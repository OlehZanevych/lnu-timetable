// A small GraphQL client over QNetworkAccessManager.
//
// Three calls, which is the whole of what the generator needs from the service: sign in, read the
// input, write the answer back. Every value travels as a **variable**, never spliced into the
// document — the same rule `timetable-ui`'s `npm run lint:graphql` enforces on the web client, and
// for the same reason: a кафедра called «Кафедра «Інформатика»» pasted into a query string is a
// syntax error at best and something worse at worst.
#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QObject>
#include <QString>

class QNetworkAccessManager;
class QNetworkReply;

namespace tg::gui {

/// One GraphQL round trip's outcome. `errors` carries the service's own messages, which are the
/// ones worth showing: it says «Невірний email або пароль», and inventing a sentence here instead
/// would be neither translatable nor true.
struct GqlResult {
    bool ok = false;
    QJsonObject data;
    QString error;
};

class GraphQlClient : public QObject {
    Q_OBJECT

public:
    explicit GraphQlClient(QObject* parent = nullptr);

    void setEndpoint(const QString& url) { endpoint_ = url; }
    QString endpoint() const { return endpoint_; }

    void setToken(const QString& token) { token_ = token; }
    QString token() const { return token_; }
    bool signedIn() const { return !token_.isEmpty(); }
    /// The account is on a temporary password and the service will refuse everything else until it
    /// is changed. Nothing here can change it — that is the web client's screen — so the window says
    /// so rather than failing later with a message about authorization.
    bool mustChangePassword() const { return mustChangePassword_; }

    /// Blocking, on purpose: three requests do not justify a callback chain. It runs a nested event
    /// loop, so a caller on the GUI thread must disable whatever could start a second request first —
    /// `MainWindow::setNetworkBusy` is that.
    GqlResult run(const QString& document, const QJsonObject& variables, int timeoutMs = 120000);

    /// `login(email, password)` — stores the token on success.
    GqlResult signIn(const QString& email, const QString& password);

    /// The whole solver input for one faculty, or for every faculty when `facultyId` is empty.
    GqlResult generationInput(const QString& facultyId, const QString& semesterParity);

    /// Writes a generated timetable back.
    GqlResult saveGenerated(const QJsonObject& input);

    /// The faculties this account can see, for the picker.
    GqlResult faculties();

private:
    QNetworkAccessManager* net_;
    QString endpoint_ = QStringLiteral("http://localhost:8080/graphql");
    QString token_;
    bool mustChangePassword_ = false;
};

}  // namespace tg::gui
