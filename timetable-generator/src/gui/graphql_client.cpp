#include "graphql_client.hpp"

#include <QEventLoop>
#include <QJsonArray>
#include <QJsonDocument>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QTimer>

namespace tg::gui {
namespace {

// The exact shape `LoginResponse` carries — `isSuccess`, `token`, `mustChangePassword`,
// `errorStatus` — and nothing else. There is no `user` on it; the signed-in account is `Query.me`,
// which this application does not need.
const char* const kLogin = R"(
mutation Login($email: String!, $password: String!) {
  login(email: $email, password: $password) {
    isSuccess
    token
    mustChangePassword
    errorStatus
  }
}
)";

// Every generated connection lives inside a per-entity namespace field — `Query.faculties` of type
// `FacultyQueries` — and takes `limit`/`offset` only: the ordering is fixed at declaration
// (`facultyConnection` is ordered by `name`) and is not an argument.
const char* const kFaculties = R"(
query Faculties {
  faculties {
    facultyConnection(limit: 500) {
      nodes { id name abbreviation }
    }
  }
}
)";

// One request for the whole problem. Every field is asked for because the solver needs every field;
// selecting less would only mean discovering at midnight that a travel matrix was missing.
const char* const kGenerationInput = R"(
query GenerationInput($facultyId: ID, $semesterParity: String) {
  timetableGenerationInput(facultyId: $facultyId, semesterParity: $semesterParity) {
    academicHourMinutes
    semesterDurationWeeks
    semesterParity
    abstractRoomTravelMinutes
    universityCommuteMinutes
    days
    faculties { id name abbreviation }
    classTimes { id setId ordinal startTime }
    rooms
    roomBuilding { roomId buildingId }
    buildingTravel { fromBuildingId toBuildingId minutes }
    abstractRooms { id name capacity buildingId }
    requirements {
      key workloadId entryId courseName hourType durationHours classStartTimeSetId
      lecturerIds groupIds roomIds abstractRoomId isOnline studentsCount isBiweekly locked facultyId
      current { dayOfWeek classStartTimeId roomId weekParity }
    }
    fixedEntries {
      id dayOfWeek weekParity startTime durationHours
      lecturerIds groupIds roomId abstractRoomId isOnline studentsCount
    }
    lecturerConstraints { subjectId constraints { type dayOfWeek value } }
    groupConstraints { subjectId constraints { type dayOfWeek value } }
    roomConstraints { subjectId constraints { type dayOfWeek value } }
  }
}
)";

const char* const kSave = R"(
mutation SaveGeneratedTimetable($input: SaveGeneratedTimetableInput!) {
  saveGeneratedTimetable(input: $input) {
    isSuccess created updated deleted errorStatus
    rejected { key reason }
  }
}
)";

}  // namespace

GraphQlClient::GraphQlClient(QObject* parent)
    : QObject(parent), net_(new QNetworkAccessManager(this)) {}

GqlResult GraphQlClient::run(const QString& document, const QJsonObject& variables, int timeoutMs) {
    QJsonObject body;
    body.insert(QStringLiteral("query"), document);
    body.insert(QStringLiteral("variables"), variables);

    QNetworkRequest request{QUrl(endpoint_)};
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    if (!token_.isEmpty()) {
        request.setRawHeader("Authorization", QByteArray("Bearer ") + token_.toUtf8());
    }

    QNetworkReply* reply = net_->post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    QObject::connect(&timer, &QTimer::timeout, &loop, [&] { reply->abort(); });
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    timer.start(timeoutMs);
    loop.exec();

    GqlResult out;
    if (reply->error() != QNetworkReply::NoError) {
        out.error = reply->errorString();
        reply->deleteLater();
        return out;
    }
    const QByteArray payload = reply->readAll();
    reply->deleteLater();

    QJsonParseError parseError{};
    const QJsonDocument doc = QJsonDocument::fromJson(payload, &parseError);
    if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
        out.error = QStringLiteral("The service answered something that is not JSON: %1")
                        .arg(parseError.errorString());
        return out;
    }
    const QJsonObject root = doc.object();
    // A GraphQL response may carry both data and errors. Report the error either way — a partial
    // answer to «give me the whole problem» is not an answer.
    if (root.contains(QStringLiteral("errors"))) {
        const QJsonArray errors = root.value(QStringLiteral("errors")).toArray();
        QStringList messages;
        for (const QJsonValue& e : errors) {
            messages << e.toObject().value(QStringLiteral("message")).toString();
        }
        out.error = messages.join(QStringLiteral("; "));
        return out;
    }
    out.data = root.value(QStringLiteral("data")).toObject();
    out.ok = true;
    return out;
}

GqlResult GraphQlClient::signIn(const QString& email, const QString& password) {
    QJsonObject vars;
    vars.insert(QStringLiteral("email"), email);
    vars.insert(QStringLiteral("password"), password);
    GqlResult r = run(QString::fromUtf8(kLogin), vars, 30000);
    if (!r.ok) return r;

    const QJsonObject login = r.data.value(QStringLiteral("login")).toObject();
    if (!login.value(QStringLiteral("isSuccess")).toBool()) {
        r.ok = false;
        const QString status = login.value(QStringLiteral("errorStatus")).toString();
        r.error = status.isEmpty() ? QStringLiteral("Sign-in failed") : status;
        return r;
    }
    token_ = login.value(QStringLiteral("token")).toString();
    mustChangePassword_ = login.value(QStringLiteral("mustChangePassword")).toBool();
    return r;
}

GqlResult GraphQlClient::faculties() {
    return run(QString::fromUtf8(kFaculties), QJsonObject{}, 30000);
}

GqlResult GraphQlClient::generationInput(const QString& facultyId, const QString& semesterParity) {
    QJsonObject vars;
    // A null variable is how "every faculty" is said. Omitting the key would work too; sending an
    // explicit null says it on purpose.
    if (facultyId.isEmpty()) vars.insert(QStringLiteral("facultyId"), QJsonValue());
    else vars.insert(QStringLiteral("facultyId"), facultyId);
    vars.insert(QStringLiteral("semesterParity"), semesterParity);
    return run(QString::fromUtf8(kGenerationInput), vars, 600000);
}

GqlResult GraphQlClient::saveGenerated(const QJsonObject& input) {
    QJsonObject vars;
    vars.insert(QStringLiteral("input"), input);
    return run(QString::fromUtf8(kSave), vars, 600000);
}

}  // namespace tg::gui
