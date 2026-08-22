// Runs the search on a worker thread and reports back to the window.
//
// The core is deliberately free of Qt — it is the part that has to run inside a benchmark harness on
// a machine with nothing but a compiler — so everything Qt-shaped lives here: the thread, the
// queued-connection signals, and the translation between the service's payload and the core's model.
#pragma once

#include <atomic>
#include <memory>

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QThread>

#include "core/model.hpp"
#include "core/search.hpp"

namespace tg::gui {

/// What the four buttons mean, spelled out once.
enum class RunScope { AllFaculties, OneFaculty };
enum class RunPolicy {
    Recreate,  ///< throw away every placement this run owns and schedule from nothing
    Keep       ///< leave every placed class exactly where it is; place only what has none
};

struct RunRequest {
    RunScope scope = RunScope::AllFaculties;
    RunPolicy policy = RunPolicy::Recreate;
    QString facultyId;
    QString facultyName;
    QString semesterParity = QStringLiteral("ODD");
    qint64 timeLimitMs = 60000;
    int threads = 0;
    quint64 seed = 20260802;
    QString engine = QStringLiteral("mixed");
    QString logDirectory;
};

/// One progress sample, mirrored out of `tg::TrajectoryPoint` so the window never includes the core.
struct RunProgress {
    double seconds = 0;
    qint64 moves = 0;
    qint64 hard = 0;
    qint64 soft = 0;
    double objective = 0;
    qint64 lecturerConflicts = 0, groupConflicts = 0, roomConflicts = 0;
    qint64 groupTravel = 0, lecturerTravel = 0, abstractRoomOverflow = 0;
    qint64 lecturerWindows = 0, groupWindows = 0, mixedOnlineDays = 0;
    QString phase;
};

class RunController : public QObject {
    Q_OBJECT

public:
    explicit RunController(QObject* parent = nullptr);
    ~RunController() override;

    /// `payload` is the `timetableGenerationInput` object exactly as the service returned it.
    void start(const QJsonObject& payload, const RunRequest& request);
    /// Ends the run at the next check and keeps whatever has been found — «зупинити й показати».
    void stop();
    bool running() const { return thread_ != nullptr && thread_->isRunning(); }

    /// The placements the finished run produced, in the shape `saveGeneratedTimetable` takes.
    QJsonArray placements() const { return placements_; }

signals:
    void progressed(const tg::gui::RunProgress& progress);
    void finished(const tg::gui::RunProgress& summary, const QString& reportPath);
    void failed(const QString& message);

private:
    void execute(QJsonObject payload, RunRequest request);

    QThread* thread_ = nullptr;
    std::atomic<bool> stopFlag_{false};
    QJsonArray placements_;
};

}  // namespace tg::gui

Q_DECLARE_METATYPE(tg::gui::RunProgress)
