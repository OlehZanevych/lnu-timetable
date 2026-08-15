package org.lnu.timetable.mail;

import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * The one place this service sends mail from: the two links that let a person the institution has
 * already entered take over their own account — a registration link for a викладач or a студент who
 * has none yet, and a password-recovery link for one who has forgotten theirs.
 *
 * <p><strong>Transport.</strong> SMTP, through Spring's {@code JavaMailSender}, configured in
 * {@code application.properties} for {@code smtp.office365.com:587} with STARTTLS and the mailbox
 * credentials read from {@code MAIL_USERNAME} / {@code MAIL_PASSWORD}. Host and port are ordinary
 * properties, so pointing this at a different relay — a departmental one, or a capture server
 * during development — is configuration rather than code. Two things are worth knowing before
 * blaming this class for a failure to send: Microsoft disables SMTP AUTH per mailbox by default and
 * it has to be enabled for {@code timetable@lnu.edu.ua} explicitly, and an account with multi-factor
 * authentication cannot use its own password here at all — it needs an app password or a different
 * mailbox.
 *
 * <p><strong>Threading.</strong> {@code JavaMailSender} is blocking, and everything else in this
 * service is not: a send that took a second on the event loop would stall every other request the
 * same thread was carrying. Each send is therefore run on {@link Schedulers#boundedElastic()}, whose
 * whole purpose is exactly this — a bounded pool for blocking calls that would otherwise be made
 * from a non-blocking one.
 *
 * <p><strong>Failure.</strong> A send that fails errors the returned {@code Mono} rather than being
 * swallowed. The caller turns that into {@code MAIL_FAILED}, which the client shows as «не вдалося
 * надіслати листа» — the honest answer, and the one thing worse than which is telling somebody to
 * check an inbox nothing was sent to.
 */
@Component
public class MailService {

    private static final Logger log = LoggerFactory.getLogger(MailService.class);

    private final JavaMailSender sender;
    private final String from;
    private final String fromName;

    public MailService(JavaMailSender sender,
                        @Value("${app.mail.from:}") String from,
                        @Value("${app.mail.from-name:Планування освітнього процесу}") String fromName,
                        @Value("${spring.mail.username:}") String username) {
        this.sender = sender;
        // The From address defaults to the mailbox being authenticated as, because Office 365
        // rejects a From that is neither the authenticated mailbox nor one it has Send As on — a
        // separate app.mail.from is for exactly that delegated case and is otherwise noise.
        this.from = from == null || from.isBlank() ? username : from;
        this.fromName = fromName;
    }

    /**
     * The link that creates an account for a викладач or a студент the institution has entered.
     *
     * @param firstName how to address them — their own first name, as held on their row
     * @param url       the link, already carrying the token
     * @param ttlMinutes how long it stays good, so the message can say so rather than leaving the
     *                   reader to find out by being too late
     */
    public Mono<Void> sendRegistrationLink(String to, String firstName, String url, int ttlMinutes) {
        String subject = "Реєстрація в системі «Планування освітнього процесу»";
        String plain = """
            Доброго дня, %s!

            Ви (або хтось від Вашого імені) розпочали реєстрацію в системі планування освітнього
            процесу Львівського національного університету імені Івана Франка.

            Щоб завершити реєстрацію та встановити пароль, перейдіть за посиланням:

            %s

            Посилання дійсне %d хвилин. Якщо Ви не звертались за реєстрацією, просто проігноруйте
            цього листа — обліковий запис не буде створено.
            """.formatted(firstName, url, ttlMinutes);
        return send(to, subject, plain, html(
            "Реєстрація в системі «Планування освітнього процесу»",
            firstName,
            "Щоб завершити реєстрацію та встановити пароль, натисніть кнопку нижче.",
            "Завершити реєстрацію",
            url,
            ttlMinutes,
            "Якщо Ви не звертались за реєстрацією, просто проігноруйте цього листа — обліковий запис не буде створено."));
    }

    /** The link that replaces the password of an account that has forgotten it. */
    public Mono<Void> sendPasswordResetLink(String to, String firstName, String url, int ttlMinutes) {
        String subject = "Відновлення пароля в системі «Планування освітнього процесу»";
        String plain = """
            Доброго дня, %s!

            Ви (або хтось від Вашого імені) звернулись за відновленням пароля до системи планування
            освітнього процесу Львівського національного університету імені Івана Франка.

            Щоб встановити новий пароль, перейдіть за посиланням:

            %s

            Посилання дійсне %d хвилин. Якщо Ви не звертались за відновленням пароля, просто
            проігноруйте цього листа — Ваш поточний пароль залишиться чинним.
            """.formatted(firstName, url, ttlMinutes);
        return send(to, subject, plain, html(
            "Відновлення пароля",
            firstName,
            "Щоб встановити новий пароль, натисніть кнопку нижче.",
            "Встановити новий пароль",
            url,
            ttlMinutes,
            "Якщо Ви не звертались за відновленням пароля, просто проігноруйте цього листа — Ваш поточний пароль залишиться чинним."));
    }

    /**
     * One layout for both messages. Inline styles rather than a stylesheet, and a table rather than
     * flexbox, because that is what mail clients render predictably; the link is repeated as text
     * below the button because a client that strips the button must still leave something clickable.
     */
    private String html(String heading, String firstName, String lead, String action, String url,
                         int ttlMinutes, String footnote) {
        // Everything interpolated is escaped, and the one that matters is the name. It comes from a
        // `lecturers` or `students` row, which anybody holding EDIT on a кафедра may write: a first
        // name of `<a href="https://…">натисніть тут</a>` would otherwise put a stranger's link
        // above the real button, in a message sent from the university's own address.
        return """
            <!doctype html>
            <html lang="uk">
            <body style="margin:0;padding:24px;background:#f4f5f7;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1f2430">
              <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:32px">
                <tr><td>
                  <h2 style="margin:0 0 4px;font-size:19px">%s</h2>
                  <p style="margin:0 0 20px;color:#6b7280;font-size:13px">Львівський національний університет імені Івана Франка</p>
                  <p style="margin:0 0 8px">Доброго дня, %s!</p>
                  <p style="margin:0 0 24px">%s</p>
                  <p style="margin:0 0 24px">
                    <a href="%s" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">%s</a>
                  </p>
                  <p style="margin:0 0 20px;font-size:13px;color:#6b7280">
                    Якщо кнопка не працює, скопіюйте це посилання у браузер:<br>
                    <a href="%s" style="color:#1d4ed8;word-break:break-all">%s</a>
                  </p>
                  <p style="margin:0 0 8px;font-size:13px;color:#6b7280">Посилання дійсне %d хвилин.</p>
                  <p style="margin:0;font-size:13px;color:#6b7280">%s</p>
                </td></tr>
              </table>
            </body>
            </html>
            """.formatted(escape(heading), escape(firstName), escape(lead), escape(url), escape(action),
                escape(url), escape(url), ttlMinutes, escape(footnote));
    }

    /**
     * The five characters that can change the meaning of markup. Small enough to write out, and
     * written out rather than pulled in, because a mail template is the whole of this service's
     * HTML output and a dependency for it would be the only reason it had one.
     */
    private String escape(String text) {
        return text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
            .replace("'", "&#39;");
    }

    private Mono<Void> send(String to, String subject, String plainText, String htmlBody) {
        return Mono.<Void>fromRunnable(() -> {
            try {
                MimeMessage message = sender.createMimeMessage();
                // true: multipart, so the plain-text alternative travels with the HTML one.
                MimeMessageHelper helper = new MimeMessageHelper(message, true, "UTF-8");
                helper.setFrom(new InternetAddress(from, fromName, "UTF-8"));
                helper.setTo(to);
                helper.setSubject(subject);
                helper.setText(plainText, htmlBody);
                sender.send(message);
                log.info("Sent «{}» to {}", subject, to);
            } catch (Exception e) {
                log.error("Could not send «{}» to {}: {}", subject, to, e.toString());
                throw new IllegalStateException("Could not send mail to " + to, e);
            }
        }).subscribeOn(Schedulers.boundedElastic());
    }
}
