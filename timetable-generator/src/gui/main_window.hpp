// The one window: pick a scope, pick a policy, pick a budget, watch the nine Π terms fall.
#pragma once

#include <QJsonObject>
#include <QMainWindow>

#include "run_controller.hpp"

class QComboBox;
class QLabel;
class QPlainTextEdit;
class QProgressBar;
class QPushButton;
class QRadioButton;
class QSpinBox;
class QTableWidget;
class QLineEdit;

namespace tg::gui {

class GraphQlClient;

class MainWindow : public QMainWindow {
    Q_OBJECT

public:
    explicit MainWindow(GraphQlClient* client, QWidget* parent = nullptr);

private slots:
    void loadFaculties();
    void startRun();
    void stopRun();
    void saveResult();
    void onProgress(const tg::gui::RunProgress& progress);
    void onFinished(const tg::gui::RunProgress& summary, const QString& reportPath);
    void onFailed(const QString& message);

private:
    void log(const QString& line);
    void setBusy(bool busy);
    /// Disables everything that could start a second request while one is in flight. Every call into
    /// the service runs a nested event loop on this thread, so the window stays live during it and
    /// a second click would re-enter with the first still on the stack.
    void setNetworkBusy(bool busy);
    void showCounters(const RunProgress& p);
    RunRequest currentRequest() const;

    GraphQlClient* client_;
    RunController* controller_;

    QComboBox* faculty_;
    QRadioButton* scopeAll_;
    QRadioButton* scopeOne_;
    QRadioButton* policyRecreate_;
    QRadioButton* policyKeep_;
    QComboBox* parity_;
    QSpinBox* minutes_;
    QSpinBox* threads_;
    QComboBox* engine_;
    QLineEdit* logDir_;

    QPushButton* start_;
    QPushButton* stop_;
    QPushButton* save_;
    QProgressBar* progress_;
    QLabel* headline_;
    QTableWidget* counters_;
    QPlainTextEdit* console_;

    QJsonObject payload_;
    // The request the finished run was made with. Read again from the widgets at save time it
    // would silently follow whatever the person has since clicked, and save a faculty's schedule
    // under another faculty's name.
    RunRequest lastRequest_;
    qint64 budgetMs_ = 0;
};

}  // namespace tg::gui
