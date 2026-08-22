// The desktop generator's entry point: sign in, then one window.
//
// The application is a thin shell around `src/core`, which knows nothing about Qt. That separation
// is what lets every number in the study be reproduced by `timetable-solve` on a machine with no
// desktop at all, and it is why the solver can be measured rather than merely demonstrated.
#include <QApplication>

#include "graphql_client.hpp"
#include "login_dialog.hpp"
#include "main_window.hpp"

int main(int argc, char** argv) {
    QApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("LNU"));
    QCoreApplication::setOrganizationDomain(QStringLiteral("lnu.edu.ua"));
    QCoreApplication::setApplicationName(QStringLiteral("Timetable Generator"));

    tg::gui::GraphQlClient client;
    tg::gui::LoginDialog login(&client);
    if (login.exec() != QDialog::Accepted) return 0;

    tg::gui::MainWindow window(&client);
    window.show();
    return app.exec();
}
