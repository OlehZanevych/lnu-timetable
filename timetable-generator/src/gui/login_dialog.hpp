// The sign-in dialog: an address for the service, an e-mail, a password.
#pragma once

#include <QDialog>

class QLineEdit;
class QLabel;
class QPushButton;

namespace tg::gui {

class GraphQlClient;

class LoginDialog : public QDialog {
    Q_OBJECT

public:
    LoginDialog(GraphQlClient* client, QWidget* parent = nullptr);

private slots:
    void attempt();

private:
    GraphQlClient* client_;
    QLineEdit* endpoint_;
    QLineEdit* email_;
    QLineEdit* password_;
    QLabel* status_;
    QPushButton* signIn_;
};

}  // namespace tg::gui
