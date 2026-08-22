#include "main_window.hpp"

#include <QApplication>
#include <QButtonGroup>
#include <QComboBox>
#include <QDateTime>
#include <QDir>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QProgressBar>
#include <QPushButton>
#include <QRadioButton>
#include <QSettings>
#include <QSpinBox>
#include <QSplitter>
#include <QStandardPaths>
#include <QTableWidget>
#include <QThread>
#include <QTimer>
#include <QVBoxLayout>

#include "graphql_client.hpp"

namespace tg::gui {
namespace {

// The nine Π terms of TIMETABLE-GENERATION.md §1.2, in the order the objective states them, with the
// hard six above the soft three so the table reads the way the search prioritises.
struct TermRow {
    const char* label;
    int weight;
    bool hard;
};

const TermRow kTerms[] = {
    {"Π₁ конфлікти викладачів", 150, true},
    {"Π₂ конфлікти груп", 100, true},
    {"Π₃ конфлікти аудиторій", 50, true},
    {"Π₄ переїзди груп", 90, true},
    {"Π₅ переїзди викладачів", 120, true},
    {"Π₆ перевищення місткості", 50, true},
    {"Π₇ вікна викладачів", 5, false},
    {"Π₈ вікна груп", 20, false},
    {"Π₉ змішані онлайн-дні", 30, false},
};

QString formatSeconds(double seconds) {
    const int total = static_cast<int>(seconds);
    return QStringLiteral("%1:%2:%3")
        .arg(total / 3600, 2, 10, QLatin1Char('0'))
        .arg((total / 60) % 60, 2, 10, QLatin1Char('0'))
        .arg(total % 60, 2, 10, QLatin1Char('0'));
}

}  // namespace

MainWindow::MainWindow(GraphQlClient* client, QWidget* parent)
    : QMainWindow(parent), client_(client), controller_(new RunController(this)) {
    setWindowTitle(tr("Генератор розкладу ЛНУ"));
    resize(1080, 720);

    // ── what to schedule ─────────────────────────────────────────────────────
    auto* scopeBox = new QGroupBox(tr("Що планувати"), this);
    scopeAll_ = new QRadioButton(tr("Усі факультети"), scopeBox);
    scopeOne_ = new QRadioButton(tr("Один факультет:"), scopeBox);
    scopeAll_->setChecked(true);
    faculty_ = new QComboBox(scopeBox);
    faculty_->setEnabled(false);
    faculty_->setMinimumWidth(320);
    connect(scopeOne_, &QRadioButton::toggled, faculty_, &QComboBox::setEnabled);

    auto* scopeLayout = new QVBoxLayout(scopeBox);
    scopeLayout->addWidget(scopeAll_);
    auto* oneRow = new QHBoxLayout;
    oneRow->addWidget(scopeOne_);
    oneRow->addWidget(faculty_, 1);
    scopeLayout->addLayout(oneRow);

    // ── what to do with what is already there ────────────────────────────────
    auto* policyBox = new QGroupBox(tr("Наявні заняття"), this);
    policyRecreate_ = new QRadioButton(tr("Перепланувати все заново"), policyBox);
    policyKeep_ = new QRadioButton(tr("Зберегти вже заплановані, розставити лише нерозставлені"), policyBox);
    policyRecreate_->setChecked(true);
    auto* policyLayout = new QVBoxLayout(policyBox);
    policyLayout->addWidget(policyRecreate_);
    policyLayout->addWidget(policyKeep_);
    // Together these two pairs are the four options the generator offers, and they are two
    // questions rather than four buttons because they are independent: the scope decides whose
    // classes may move, the policy decides which of them.

    // ── the search ───────────────────────────────────────────────────────────
    auto* searchBox = new QGroupBox(tr("Пошук"), this);
    parity_ = new QComboBox(searchBox);
    parity_->addItem(tr("Непарний семестр"), QStringLiteral("ODD"));
    parity_->addItem(tr("Парний семестр"), QStringLiteral("EVEN"));

    minutes_ = new QSpinBox(searchBox);
    minutes_->setRange(1, 1440);
    minutes_->setValue(60);
    minutes_->setSuffix(tr(" хв"));
    minutes_->setToolTip(tr("Довший бюджет дає кращий розклад. Пошук можна зупинити будь-коли — "
                            "найкращий знайдений варіант зберігається."));

    threads_ = new QSpinBox(searchBox);
    threads_->setRange(0, 256);
    threads_->setValue(0);
    threads_->setSpecialValueText(tr("усі ядра"));

    engine_ = new QComboBox(searchBox);
    engine_->addItem(tr("Змішаний (LAHC + відпал)"), QStringLiteral("mixed"));
    engine_->addItem(QStringLiteral("LAHC"), QStringLiteral("lahc"));
    engine_->addItem(tr("Імітація відпалу"), QStringLiteral("sa"));
    engine_->addItem(QStringLiteral("DLAS"), QStringLiteral("dlas"));

    const QString defaultLogs =
        QDir(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation))
            .filePath(QStringLiteral("lnu-timetable-runs"));
    logDir_ = new QLineEdit(QSettings().value(QStringLiteral("logDir"), defaultLogs).toString(), searchBox);
    logDir_->setToolTip(tr("Кожен запуск пише сюди .csv та .jsonl з усіма проміжними результатами."));

    auto* searchForm = new QFormLayout(searchBox);
    searchForm->addRow(tr("Півріччя"), parity_);
    searchForm->addRow(tr("Бюджет"), minutes_);
    searchForm->addRow(tr("Потоки"), threads_);
    searchForm->addRow(tr("Алгоритм"), engine_);
    searchForm->addRow(tr("Журнал"), logDir_);

    // ── controls ─────────────────────────────────────────────────────────────
    start_ = new QPushButton(tr("Згенерувати розклад"), this);
    stop_ = new QPushButton(tr("Зупинити й показати результат"), this);
    save_ = new QPushButton(tr("Зберегти в базу"), this);
    stop_->setEnabled(false);
    save_->setEnabled(false);
    connect(start_, &QPushButton::clicked, this, &MainWindow::startRun);
    connect(stop_, &QPushButton::clicked, this, &MainWindow::stopRun);
    connect(save_, &QPushButton::clicked, this, &MainWindow::saveResult);

    progress_ = new QProgressBar(this);
    progress_->setRange(0, 1000);
    progress_->setValue(0);
    progress_->setTextVisible(true);
    progress_->setFormat(QStringLiteral("%p%"));

    headline_ = new QLabel(tr("Не підключено."), this);
    headline_->setStyleSheet(QStringLiteral("font-size: 15px;"));

    counters_ = new QTableWidget(static_cast<int>(std::size(kTerms)), 3, this);
    counters_->setHorizontalHeaderLabels({tr("Показник"), tr("Вага β"), tr("Порушень")});
    counters_->verticalHeader()->setVisible(false);
    counters_->horizontalHeader()->setSectionResizeMode(0, QHeaderView::Stretch);
    counters_->setEditTriggers(QAbstractItemView::NoEditTriggers);
    counters_->setSelectionMode(QAbstractItemView::NoSelection);
    for (int i = 0; i < static_cast<int>(std::size(kTerms)); ++i) {
        counters_->setItem(i, 0, new QTableWidgetItem(QString::fromUtf8(kTerms[i].label)));
        counters_->setItem(i, 1, new QTableWidgetItem(QString::number(kTerms[i].weight)));
        counters_->setItem(i, 2, new QTableWidgetItem(QStringLiteral("—")));
    }

    console_ = new QPlainTextEdit(this);
    console_->setReadOnly(true);
    console_->setMaximumBlockCount(5000);

    auto* left = new QWidget(this);
    auto* leftLayout = new QVBoxLayout(left);
    leftLayout->addWidget(scopeBox);
    leftLayout->addWidget(policyBox);
    leftLayout->addWidget(searchBox);
    leftLayout->addWidget(start_);
    leftLayout->addWidget(stop_);
    leftLayout->addWidget(save_);
    leftLayout->addStretch(1);

    auto* right = new QWidget(this);
    auto* rightLayout = new QVBoxLayout(right);
    rightLayout->addWidget(headline_);
    rightLayout->addWidget(progress_);
    rightLayout->addWidget(counters_, 1);
    rightLayout->addWidget(console_, 1);

    auto* splitter = new QSplitter(this);
    splitter->addWidget(left);
    splitter->addWidget(right);
    splitter->setStretchFactor(1, 1);
    setCentralWidget(splitter);

    connect(controller_, &RunController::progressed, this, &MainWindow::onProgress);
    connect(controller_, &RunController::finished, this, &MainWindow::onFinished);
    connect(controller_, &RunController::failed, this, &MainWindow::onFailed);

    log(tr("Підключено до %1").arg(client_->endpoint()));
    if (client_->mustChangePassword()) {
        log(tr("Цей акаунт має тимчасовий пароль. Змініть його у веб-клієнті — доки він тимчасовий, "
               "сервіс відмовляє в решті запитів."));
    }
    // Deferred: the constructor must not block on the network before the window exists.
    QTimer::singleShot(0, this, &MainWindow::loadFaculties);
}

void MainWindow::loadFaculties() {
    setNetworkBusy(true);
    const GqlResult r = client_->faculties();
    setNetworkBusy(false);
    if (!r.ok) {
        log(tr("Не вдалося прочитати перелік факультетів: %1").arg(r.error));
        return;
    }
    faculty_->clear();
    const QJsonArray nodes = r.data.value(QStringLiteral("faculties")).toObject()
                                 .value(QStringLiteral("facultyConnection")).toObject()
                                 .value(QStringLiteral("nodes")).toArray();
    for (const QJsonValue& v : nodes) {
        const QJsonObject f = v.toObject();
        const QString abbreviation = f.value(QStringLiteral("abbreviation")).toString();
        const QString name = f.value(QStringLiteral("name")).toString();
        faculty_->addItem(abbreviation.isEmpty() ? name : QStringLiteral("%1 — %2").arg(abbreviation, name),
                          f.value(QStringLiteral("id")).toString());
    }
    log(tr("Факультетів: %1").arg(faculty_->count()));
}

RunRequest MainWindow::currentRequest() const {
    RunRequest r;
    r.scope = scopeOne_->isChecked() ? RunScope::OneFaculty : RunScope::AllFaculties;
    r.policy = policyKeep_->isChecked() ? RunPolicy::Keep : RunPolicy::Recreate;
    r.facultyId = r.scope == RunScope::OneFaculty ? faculty_->currentData().toString() : QString();
    r.facultyName = r.scope == RunScope::OneFaculty ? faculty_->currentText() : tr("усі факультети");
    r.semesterParity = parity_->currentData().toString();
    r.timeLimitMs = static_cast<qint64>(minutes_->value()) * 60000;
    r.threads = threads_->value();
    r.engine = engine_->currentData().toString();
    r.logDirectory = logDir_->text().trimmed();
    r.seed = static_cast<quint64>(QDateTime::currentSecsSinceEpoch());
    return r;
}

void MainWindow::startRun() {
    const RunRequest request = currentRequest();
    if (request.scope == RunScope::OneFaculty && request.facultyId.isEmpty()) {
        log(tr("Оберіть факультет."));
        return;
    }
    QSettings().setValue(QStringLiteral("logDir"), request.logDirectory);

    setBusy(true);
    log(tr("Читаю вихідні дані (%1, %2)…").arg(request.facultyName, request.semesterParity));
    QApplication::processEvents();

    const GqlResult r = client_->generationInput(request.facultyId, request.semesterParity);
    if (!r.ok) {
        setBusy(false);
        log(tr("Не вдалося прочитати вихідні дані: %1").arg(r.error));
        return;
    }
    payload_ = r.data.value(QStringLiteral("timetableGenerationInput")).toObject();

    const int requirements = payload_.value(QStringLiteral("requirements")).toArray().size();
    const int fixed = payload_.value(QStringLiteral("fixedEntries")).toArray().size();
    int locked = 0;
    for (const QJsonValue& v : payload_.value(QStringLiteral("requirements")).toArray()) {
        if (v.toObject().value(QStringLiteral("locked")).toBool()) ++locked;
    }
    log(tr("Занять до розміщення: %1 (з них заблокованих: %2). Чужих занять поруч: %3.")
            .arg(requirements).arg(locked).arg(fixed));
    if (requirements == 0) {
        setBusy(false);
        log(tr("Немає чого планувати."));
        return;
    }

    budgetMs_ = request.timeLimitMs;
    lastRequest_ = request;
    progress_->setValue(0);
    log(tr("Пошук почався. Бюджет %1 хв, потоків: %2.")
            .arg(request.timeLimitMs / 60000)
            .arg(request.threads == 0 ? QThread::idealThreadCount() : request.threads));
    controller_->start(payload_, request);
}

void MainWindow::stopRun() {
    controller_->stop();
    log(tr("Зупиняю. Найкращий знайдений розклад буде показано."));
}

void MainWindow::onProgress(const RunProgress& p) {
    if (budgetMs_ > 0) {
        progress_->setValue(static_cast<int>(std::min(1000.0, p.seconds * 1000.0 * 1000.0 / static_cast<double>(budgetMs_))));
    }
    headline_->setText(tr("%1 — рухів: %2, жорстких порушень: %3, м'яких: %4, f(σ) = %5")
                           .arg(formatSeconds(p.seconds))
                           .arg(p.moves)
                           .arg(p.hard)
                           .arg(p.soft)
                           .arg(QString::number(p.objective, 'g', 8)));
    showCounters(p);
}

void MainWindow::showCounters(const RunProgress& p) {
    const qint64 values[] = {p.lecturerConflicts, p.groupConflicts, p.roomConflicts,
                             p.groupTravel, p.lecturerTravel, p.abstractRoomOverflow,
                             p.lecturerWindows, p.groupWindows, p.mixedOnlineDays};
    for (int i = 0; i < static_cast<int>(std::size(values)); ++i) {
        QTableWidgetItem* item = counters_->item(i, 2);
        item->setText(QString::number(values[i]));
        item->setForeground(values[i] > 0 && kTerms[i].hard ? QBrush(QColor(0xb0, 0x00, 0x20))
                                                           : QBrush(QColor(0x20, 0x20, 0x20)));
    }
}

void MainWindow::onFinished(const RunProgress& summary, const QString& reportPath) {
    setBusy(false);
    save_->setEnabled(true);
    progress_->setValue(1000);
    showCounters(summary);
    headline_->setText(tr("Готово за %1 — жорстких порушень: %2, м'яких: %3, f(σ) = %4")
                           .arg(formatSeconds(summary.seconds))
                           .arg(summary.hard)
                           .arg(summary.soft)
                           .arg(QString::number(summary.objective, 'g', 8)));
    log(tr("Пошук завершено: %1 рухів, %2 жорстких, %3 м'яких порушень.")
            .arg(summary.moves).arg(summary.hard).arg(summary.soft));
    if (!reportPath.isEmpty()) log(tr("Журнал запуску: %1").arg(reportPath));
    if (summary.hard > 0) {
        log(tr("Увага: розклад містить жорсткі порушення. Їх можна зберегти й виправити вручну, "
               "або запустити пошук із довшим бюджетом."));
    }
}

void MainWindow::onFailed(const QString& message) {
    setBusy(false);
    log(tr("Помилка пошуку: %1").arg(message));
}

void MainWindow::saveResult() {
    const QJsonArray placements = controller_->placements();
    if (placements.isEmpty()) {
        log(tr("Немає що зберігати."));
        return;
    }
    const RunRequest& request = lastRequest_;
    QJsonObject input;
    if (!request.facultyId.isEmpty()) input.insert(QStringLiteral("facultyId"), request.facultyId);
    input.insert(QStringLiteral("mode"),
                 request.policy == RunPolicy::Keep ? QStringLiteral("KEEP") : QStringLiteral("REPLACE"));
    input.insert(QStringLiteral("placements"), placements);

    setNetworkBusy(true);
    log(tr("Зберігаю %1 занять…").arg(placements.size()));
    QApplication::processEvents();

    const GqlResult r = client_->saveGenerated(input);
    setNetworkBusy(false);
    if (!r.ok) {
        log(tr("Не вдалося зберегти: %1").arg(r.error));
        return;
    }
    const QJsonObject response = r.data.value(QStringLiteral("saveGeneratedTimetable")).toObject();
    log(tr("Збережено: створено %1, оновлено %2, видалено %3.")
            .arg(response.value(QStringLiteral("created")).toInt())
            .arg(response.value(QStringLiteral("updated")).toInt())
            .arg(response.value(QStringLiteral("deleted")).toInt()));
    const QJsonArray rejected = response.value(QStringLiteral("rejected")).toArray();
    for (const QJsonValue& v : rejected) {
        const QJsonObject o = v.toObject();
        log(tr("  відхилено %1: %2").arg(o.value(QStringLiteral("key")).toString(),
                                          o.value(QStringLiteral("reason")).toString()));
    }
}

void MainWindow::setNetworkBusy(bool busy) {
    start_->setEnabled(!busy && !controller_->running());
    save_->setEnabled(!busy && !controller_->placements().isEmpty());
}

void MainWindow::setBusy(bool busy) {
    start_->setEnabled(!busy);
    stop_->setEnabled(busy);
    scopeAll_->setEnabled(!busy);
    scopeOne_->setEnabled(!busy);
    faculty_->setEnabled(!busy && scopeOne_->isChecked());
    policyRecreate_->setEnabled(!busy);
    policyKeep_->setEnabled(!busy);
    parity_->setEnabled(!busy);
    minutes_->setEnabled(!busy);
    threads_->setEnabled(!busy);
    engine_->setEnabled(!busy);
    if (busy) save_->setEnabled(false);
}

void MainWindow::log(const QString& line) {
    console_->appendPlainText(QStringLiteral("[%1] %2")
                                  .arg(QDateTime::currentDateTime().toString(QStringLiteral("HH:mm:ss")), line));
}

}  // namespace tg::gui
