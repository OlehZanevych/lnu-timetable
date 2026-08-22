#include "run_controller.hpp"

#include <QDateTime>
#include <QDir>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMetaObject>

#include "core/instance_io.hpp"
#include "core/json.hpp"
#include "core/state.hpp"

namespace tg::gui {
namespace {

RunProgress toProgress(const tg::TrajectoryPoint& p) {
    RunProgress out;
    out.seconds = p.seconds;
    out.moves = p.moves;
    out.hard = p.hard;
    out.soft = p.soft;
    out.objective = p.objective;
    out.lecturerConflicts = p.lecConflicts;
    out.groupConflicts = p.grpConflicts;
    out.roomConflicts = p.roomConflicts;
    out.groupTravel = p.grpTravel;
    out.lecturerTravel = p.lecTravel;
    out.abstractRoomOverflow = p.absOverflow;
    out.lecturerWindows = p.lecWindows;
    out.groupWindows = p.grpWindows;
    out.mixedOnlineDays = p.mixedDays;
    out.phase = QString::fromStdString(p.phase);
    return out;
}

/// The placement list, in the shape `saveGeneratedTimetable` takes: the requirement's key and the
/// `entryId` it came in with, so the mutation knows which of the four rows of a workload it is
/// looking at without guessing.
QJsonArray placementsFor(const tg::Problem& problem, const std::vector<tg::Gene>& genes,
                         const QJsonObject& payload) {
    // The key and the workload id travel with the requirement rather than being reconstructed:
    // `workloadId::wk|bi::index` is a contract with the service and parsing it back would be one
    // more place for the two halves to disagree.
    QHash<QString, QJsonObject> byKey;
    for (const QJsonValue& v : payload.value(QStringLiteral("requirements")).toArray()) {
        const QJsonObject r = v.toObject();
        byKey.insert(r.value(QStringLiteral("key")).toString(), r);
    }

    QJsonArray out;
    for (int i = 0; i < problem.movableCount; ++i) {
        const tg::Gene& g = genes[static_cast<size_t>(i)];
        if (!g.movable || g.day < 0 || g.timeIdx < 0 || g.reqIndex < 0) continue;
        const QString key = QString::fromStdString(problem.reqKeys[static_cast<size_t>(g.reqIndex)]);
        const auto it = byKey.constFind(key);
        if (it == byKey.constEnd()) continue;

        QJsonObject p;
        p.insert(QStringLiteral("key"), key);
        p.insert(QStringLiteral("workloadId"), it->value(QStringLiteral("workloadId")));
        const QJsonValue entryId = it->value(QStringLiteral("entryId"));
        if (!entryId.isNull() && !entryId.isUndefined()) p.insert(QStringLiteral("entryId"), entryId);
        p.insert(QStringLiteral("dayOfWeek"), g.day);
        p.insert(QStringLiteral("classStartTimeId"),
                 QString::fromStdString(problem.timeIds[static_cast<size_t>(g.timeIdx)]));
        if (g.room >= 0) {
            p.insert(QStringLiteral("roomId"), QString::fromStdString(problem.roomIds[static_cast<size_t>(g.room)]));
        }
        p.insert(QStringLiteral("weekParity"),
                 g.parity == tg::kNumerator ? QStringLiteral("NUMERATOR")
                 : g.parity == tg::kDenominator ? QStringLiteral("DENOMINATOR")
                                                : QStringLiteral("WEEKLY"));
        out.append(p);
    }
    return out;
}

}  // namespace

RunController::RunController(QObject* parent) : QObject(parent) {
    qRegisterMetaType<tg::gui::RunProgress>("tg::gui::RunProgress");
}

RunController::~RunController() {
    stop();
    // Unbounded. `quit()` is a no-op for a functor thread — there is no event loop in it to quit —
    // and a timed wait that expires would leave the worker writing `placements_`, writing the run
    // journal and posting to a `this` that is about to stop existing.
    if (thread_) thread_->wait();
}

void RunController::stop() { stopFlag_.store(true, std::memory_order_relaxed); }

void RunController::start(const QJsonObject& payload, const RunRequest& request) {
    if (running()) return;
    stopFlag_.store(false, std::memory_order_relaxed);
    placements_ = QJsonArray{};

    QThread* thread = QThread::create([this, payload, request] { execute(payload, request); });
    thread_ = thread;
    connect(thread, &QThread::finished, thread, &QObject::deleteLater);
    // Compare before clearing. The `finished` signal reaches the window before the queued
    // `deleteLater` runs, so a second run can already have been started and stored here by the time
    // the *first* thread is destroyed — and an unconditional `thread_ = nullptr` would then erase
    // the live run's handle, letting a third `start()` launch a concurrent search over the same
    // stop flag and the same result buffer.
    connect(thread, &QObject::destroyed, this, [this, thread] {
        if (thread_ == thread) thread_ = nullptr;
    });
    thread->start();
}

void RunController::execute(QJsonObject payload, RunRequest request) {
    try {
        const QByteArray text = QJsonDocument(payload).toJson(QJsonDocument::Compact);
        tg::Json problemJson = tg::Json::parse(std::string_view(text.constData(), static_cast<size_t>(text.size())));
        tg::Problem problem = tg::loadProblem(problemJson);
        if (request.policy == RunPolicy::Keep) tg::freezePlaced(problem);

        tg::SearchOptions options;
        options.timeLimitMs = request.timeLimitMs;
        options.threads = request.threads;
        options.seed = request.seed;
        options.engine = request.engine.toStdString();
        options.keepExisting = request.policy == RunPolicy::Keep;
        options.stopFlag = &stopFlag_;
        options.onProgress = [this](const tg::TrajectoryPoint& p) {
            const RunProgress rp = toProgress(p);
            QMetaObject::invokeMethod(this, [this, rp] { emit progressed(rp); }, Qt::QueuedConnection);
        };

        tg::SearchResult result = tg::solve(problem, options);
        placements_ = placementsFor(problem, result.best, payload);

        // Every run leaves a record, whether or not anybody asked. The whole point of an hour-long
        // search is that its trajectory is worth reading afterwards, and a run whose numbers were
        // only ever on screen is a measurement nobody can quote.
        QString reportPath;
        if (!request.logDirectory.isEmpty()) {
            QDir().mkpath(request.logDirectory);
            const QString stamp = QDateTime::currentDateTime().toString(QStringLiteral("yyyyMMdd-HHmmss"));
            const QString scope = request.scope == RunScope::AllFaculties
                                      ? QStringLiteral("all")
                                      : QStringLiteral("faculty-%1").arg(request.facultyId);
            const QString policy = request.policy == RunPolicy::Recreate ? QStringLiteral("recreate")
                                                                        : QStringLiteral("keep");
            const QString base = QStringLiteral("%1/%2-%3-%4").arg(request.logDirectory, stamp, scope, policy);
            tg::writeTrajectory((base + QStringLiteral(".csv")).toStdString(), result);
            tg::writeTrajectory((base + QStringLiteral(".jsonl")).toStdString(), result);

            tg::Json summary = result.summary();
            summary.set("scope", tg::Json{scope.toStdString()});
            summary.set("policy", tg::Json{policy.toStdString()});
            summary.set("semesterParity", tg::Json{request.semesterParity.toStdString()});
            summary.set("timeLimitMs", tg::Json{static_cast<long long>(request.timeLimitMs)});
            summary.set("seed", tg::Json{static_cast<long long>(request.seed)});
            summary.set("engine", tg::Json{request.engine.toStdString()});
            QFile file(base + QStringLiteral("-summary.json"));
            if (file.open(QIODevice::WriteOnly | QIODevice::Text)) {
                file.write(QByteArray::fromStdString(summary.dump(2)));
            }
            reportPath = base + QStringLiteral(".csv");
        }

        RunProgress done;
        done.seconds = result.totalSeconds;
        done.moves = result.moves;
        done.hard = result.hard;
        done.soft = result.soft;
        done.objective = result.objective;
        const tg::Counters& c = result.counters;
        done.lecturerConflicts = c.lecConflicts;
        done.groupConflicts = c.grpConflicts;
        done.roomConflicts = c.roomConflicts;
        done.groupTravel = c.grpTravel;
        done.lecturerTravel = c.lecTravel;
        done.abstractRoomOverflow = c.absOverflow;
        done.lecturerWindows = llround(static_cast<double>(c.lecWinHalves) / 2.0);
        done.groupWindows = llround(static_cast<double>(c.grpWinHalves) / 2.0);
        done.mixedOnlineDays = llround(static_cast<double>(c.mixedHalves) / 2.0);
        done.phase = QStringLiteral("done");

        QMetaObject::invokeMethod(this, [this, done, reportPath] { emit finished(done, reportPath); },
                                  Qt::QueuedConnection);
    } catch (const std::exception& e) {
        const QString message = QString::fromUtf8(e.what());
        QMetaObject::invokeMethod(this, [this, message] { emit failed(message); }, Qt::QueuedConnection);
    }
}

}  // namespace tg::gui
