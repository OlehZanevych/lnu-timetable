#include "login_dialog.hpp"

#include <QDialogButtonBox>
#include <QFormLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QSettings>
#include <QVBoxLayout>

#include "graphql_client.hpp"

namespace tg::gui {

LoginDialog::LoginDialog(GraphQlClient* client, QWidget* parent)
    : QDialog(parent), client_(client) {
    setWindowTitle(tr("Вхід"));
    setModal(true);
    setMinimumWidth(420);

    QSettings settings;
    endpoint_ = new QLineEdit(settings.value(QStringLiteral("endpoint"),
                                             QStringLiteral("http://localhost:8080/graphql")).toString(), this);
    email_ = new QLineEdit(settings.value(QStringLiteral("email")).toString(), this);
    email_->setPlaceholderText(QStringLiteral("admin@lnu.edu.ua"));
    password_ = new QLineEdit(this);
    password_->setEchoMode(QLineEdit::Password);

    status_ = new QLabel(this);
    status_->setWordWrap(true);
    status_->setStyleSheet(QStringLiteral("color: #b00020;"));

    auto* form = new QFormLayout;
    form->addRow(tr("Сервіс"), endpoint_);
    form->addRow(tr("Ел. пошта"), email_);
    form->addRow(tr("Пароль"), password_);

    auto* buttons = new QDialogButtonBox(QDialogButtonBox::Cancel, this);
    signIn_ = buttons->addButton(tr("Увійти"), QDialogButtonBox::AcceptRole);
    connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
    connect(signIn_, &QPushButton::clicked, this, &LoginDialog::attempt);
    connect(password_, &QLineEdit::returnPressed, this, &LoginDialog::attempt);

    auto* layout = new QVBoxLayout(this);
    layout->addLayout(form);
    layout->addWidget(status_);
    layout->addWidget(buttons);
}

void LoginDialog::attempt() {
    status_->clear();
    signIn_->setEnabled(false);
    client_->setEndpoint(endpoint_->text().trimmed());

    const GqlResult result = client_->signIn(email_->text().trimmed(), password_->text());
    signIn_->setEnabled(true);
    if (!result.ok) {
        // The service names its own failures — «INVALID_CREDENTIALS» rather than a sentence — so
        // the one sentence a person reads is written here, once, in the language of the client.
        const QString status = result.error;
        status_->setText(status.contains(QStringLiteral("CREDENTIALS"))
                             ? tr("Невірна ел. пошта або пароль.")
                             : tr("Не вдалося увійти: %1").arg(status));
        return;
    }

    QSettings settings;
    settings.setValue(QStringLiteral("endpoint"), client_->endpoint());
    settings.setValue(QStringLiteral("email"), email_->text().trimmed());
    accept();
}

}  // namespace tg::gui
