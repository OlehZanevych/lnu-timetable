package org.lnu.timetable.security;

import io.r2dbc.spi.Parameters;
import io.r2dbc.spi.R2dbcType;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.time.LocalDateTime;

/**
 * Raw SQL for {@code account_tokens} — the one-time links behind self-service registration and
 * password recovery — plus the two person lookups that decide whether a link may be sent at all.
 *
 * <p>It sits beside {@link PermissionRepository} rather than inside it because the two answer
 * different questions: that one reads the auth tables and knows nothing about the domain, and this
 * one has to cross the line once, asking whether any {@code lecturers} or {@code students} row
 * carries the address somebody typed. That is the whole of the crossing, and it is what
 * self-registration <em>is</em>: not "anyone may create an account" but "a person this institution
 * has already entered may claim the one that belongs to them".
 *
 * <p>The plaintext token never reaches this class. Callers hash it first (see
 * {@link SelfServiceDataFetchers#hash}); {@code token_hash} is both the storage form and the lookup
 * key, so a dump of this table is a set of expired-in-thirty-minutes hashes rather than a set of
 * working links.
 */
@Component
public class AccountTokenRepository {

    /**
     * A викладач or a студент found by e-mail. Only the fields a registration link needs: who to
     * address the message to, and what to write on the account when it is created.
     */
    public record PersonRow(Long id, String firstName, String lastName, String email) {}

    /**
     * One issued link. {@code purpose} decides which of {@code lecturerId} / {@code studentId} /
     * {@code userId} is set — {@code account_tokens_subject_check} makes that a database rule
     * rather than a convention.
     * <p>
     * {@code expired} is computed by the database rather than by comparing {@code expiresAt} to the
     * application's clock. {@code expires_at} is a {@code TIMESTAMP} written from the database's
     * {@code now()}, and a thirty-minute window is short enough that a few minutes of disagreement
     * between two hosts' clocks would be the difference between a link that works and one that does
     * not. One clock decides, and it is the one that wrote the row.
     */
    public record TokenRow(Long id, String purpose, String email, Long lecturerId, Long studentId,
                            Long userId, LocalDateTime expiresAt, boolean expired, LocalDateTime usedAt) {}

    private static final String TOKEN_COLUMNS =
        "id, purpose::text AS purpose, email, lecturer_id, student_id, user_id, " +
        "expires_at, (expires_at <= now()) AS expired, used_at";

    private final DatabaseClient db;

    public AccountTokenRepository(DatabaseClient db) {
        this.db = db;
    }

    // --- who may register ---

    /**
     * The викладач carrying this address, if any. {@code lecturers.email} is nullable but
     * {@code UNIQUE}, so at most one row can match and the ordering below is belt and braces.
     */
    public Mono<PersonRow> findLecturerByEmail(String email) {
        return db.sql("SELECT id, first_name, last_name, email FROM lecturers l " +
                "WHERE l.email IS NOT NULL AND lower(l.email) = lower(:email) " +
                "ORDER BY EXISTS (SELECT 1 FROM users u WHERE u.lecturer_id = l.id), l.id LIMIT 1")
            .bind("email", email)
            .map(this::mapPerson)
            .one();
    }

    /**
     * The викладач or студент a redeemed registration link belongs to, read at the moment the
     * account is created rather than copied onto the token when it was issued: the thirty minutes
     * in between are long enough for a кафедра to correct a misspelt surname, and the account
     * should carry what the row says now.
     */
    public Mono<PersonRow> findPersonById(boolean lecturer, Long id) {
        String table = lecturer ? "lecturers" : "students";
        return db.sql("SELECT id, first_name, last_name, email FROM " + table + " WHERE id = :id")
            .bind("id", id)
            .map(this::mapPerson)
            .one();
    }

    /**
     * The студент carrying this address, if any — consulted only when no викладач does.
     * <p>
     * Unlike {@code lecturers.email}, {@code students.email} is <em>not</em> unique: siblings share
     * a family address, and a group sometimes shares a headman's. So this can match several rows,
     * and which one it picks matters — the naive {@code ORDER BY id} would hand back the same
     * student every time, and once that one had registered every later request for the address
     * would answer «цю особу вже зареєстровано», naming the wrong person, forever. Ordering by
     * "already has an account" first means an unclaimed student is preferred and the claimed one is
     * only returned when there is nobody else, which is exactly when
     * {@code PERSON_ALREADY_LINKED} is the right answer.
     */
    public Mono<PersonRow> findStudentByEmail(String email) {
        return db.sql("SELECT id, first_name, last_name, email FROM students s " +
                "WHERE s.email IS NOT NULL AND lower(s.email) = lower(:email) " +
                "ORDER BY EXISTS (SELECT 1 FROM users u WHERE u.student_id = s.id), s.id LIMIT 1")
            .bind("email", email)
            .map(this::mapPerson)
            .one();
    }

    /**
     * Whether some account already claims this person. Distinct from "an account already has this
     * e-mail": a викладач may have been given an account under a personal address and then had a
     * university one added to their row, and the second must not become a second account —
     * {@code users_unique_lecturer} would refuse it anyway, and refusing here says why.
     */
    public Mono<Boolean> personHasAccount(boolean lecturer, Long personId) {
        String column = lecturer ? "lecturer_id" : "student_id";
        return db.sql("SELECT 1 FROM users WHERE " + column + " = :id LIMIT 1")
            .bind("id", personId)
            .map(row -> Boolean.TRUE)
            .one()
            .defaultIfEmpty(Boolean.FALSE);
    }

    // --- issuing ---

    /**
     * How many links of any purpose were issued in the last minute, to anybody. The per-address
     * cooldown below bounds what one inbox can be sent; this bounds what the mailbox as a whole can
     * be made to send, which is a different question with a different victim — a script walking a
     * list of five thousand published university addresses trips no per-address limit at all, and
     * the damage is to the sending mailbox's reputation rather than to any one recipient.
     */
    public Mono<Long> issuedInLastMinute() {
        return db.sql("SELECT count(*) AS n FROM account_tokens WHERE created_at > now() - INTERVAL '1 minute'")
            .map(row -> (Long) row.get("n"))
            .one();
    }

    /**
     * Seconds since the most recent link of this purpose was issued to this address. What the
     * cooldown reads: a form somebody can hold down the Enter key on is a way to send a stranger
     * fifty identical e-mails.
     * <p>
     * An aggregate over no rows is one row of NULL, not no rows, and Reactor will not carry a null
     * through {@code map} — so "there has never been one" is spelled as a number large enough to
     * pass any cooldown rather than as an empty {@code Mono} the caller would have to remember to
     * defaultIfEmpty.
     */
    public Mono<Long> secondsSinceLastRequest(String email, AccountTokenPurpose purpose) {
        return db.sql("SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(created_at)))::bigint, 86400) AS seconds " +
                "FROM account_tokens WHERE lower(email) = lower(:email) AND purpose = :purpose::account_token_purpose")
            .bind("email", email)
            .bind("purpose", purpose.name())
            .map(row -> (Long) row.get("seconds"))
            .one();
    }

    /**
     * Retires every link of this purpose still outstanding for this address <em>except</em> the one
     * just issued, so that asking for a second one silently invalidates the first. Without it, a
     * person who requested twice holds two working links and no way to know which of the two
     * e-mails is the live one.
     *
     * <p>It expires them rather than marking them used, and the difference is visible to whoever
     * clicks the old link. {@code used_at} means «ви вже це зробили» — the account exists, go and
     * sign in — and telling that to somebody who never redeemed anything sends them to a login form
     * with a password they have not set. Expiry means «замовте нове», which is both true and
     * actionable. One column per fact, rather than one column doing duty for two.
     *
     * <p>Called only after the new link has actually been sent: retiring the old one first would
     * mean an SMTP failure left the person with no working link at all.
     */
    public Mono<Long> supersedeOutstanding(String email, AccountTokenPurpose purpose, Long keepId) {
        return db.sql("UPDATE account_tokens SET expires_at = now() " +
                "WHERE lower(email) = lower(:email) AND purpose = :purpose::account_token_purpose " +
                "AND id <> :keepId AND used_at IS NULL AND expires_at > now()")
            .bind("email", email)
            .bind("purpose", purpose.name())
            .bind("keepId", keepId)
            .fetch().rowsUpdated();
    }

    /**
     * Removes a link that was written but never sent. Deleted rather than expired: nothing ever
     * referred to it, and leaving the row behind would start the per-address cooldown on the
     * strength of an e-mail that does not exist — so the person told «не вдалося надіслати листа»
     * would be refused for a minute when they did the only sensible thing and tried again.
     */
    public Mono<Long> delete(Long id) {
        return db.sql("DELETE FROM account_tokens WHERE id = :id")
            .bind("id", id)
            .fetch().rowsUpdated();
    }

    public Mono<Long> insert(AccountTokenPurpose purpose, String tokenHash, String email,
                              Long lecturerId, Long studentId, Long userId, int ttlMinutes) {
        return db.sql("INSERT INTO account_tokens (purpose, token_hash, email, lecturer_id, student_id, user_id, expires_at) " +
                "VALUES (:purpose::account_token_purpose, :hash, :email, :lecturerId, :studentId, :userId, " +
                "        now() + make_interval(mins => :ttl)) RETURNING id")
            .bind("purpose", purpose.name())
            .bind("hash", tokenHash)
            .bind("email", email)
            .bind("lecturerId", Parameters.in(R2dbcType.BIGINT, lecturerId))
            .bind("studentId", Parameters.in(R2dbcType.BIGINT, studentId))
            .bind("userId", Parameters.in(R2dbcType.BIGINT, userId))
            .bind("ttl", ttlMinutes)
            .map(row -> (Long) row.get("id"))
            .one();
    }

    // --- redeeming ---

    /**
     * The link with this hash, whatever state it is in. Deliberately not filtered on
     * {@code used_at IS NULL AND expires_at > now()}: the caller has to be able to tell «посилання
     * вже використано» from «термін дії посилання минув» from «посилання недійсне», and a query
     * that returns nothing for all three cannot.
     */
    public Mono<TokenRow> findByHash(String tokenHash, AccountTokenPurpose purpose) {
        return db.sql("SELECT " + TOKEN_COLUMNS + " FROM account_tokens " +
                "WHERE token_hash = :hash AND purpose = :purpose::account_token_purpose")
            .bind("hash", tokenHash)
            .bind("purpose", purpose.name())
            .map(this::mapToken)
            .one();
    }

    /**
     * Spends the link, and reports whether it was this call that spent it. The {@code used_at IS
     * NULL} predicate is the whole of the concurrency story: two browser tabs redeeming the same
     * link race here, exactly one updates a row, and the loser is told the link is already used
     * rather than both being allowed to create an account.
     */
    public Mono<Long> markUsed(Long id) {
        return db.sql("UPDATE account_tokens SET used_at = now() WHERE id = :id AND used_at IS NULL")
            .bind("id", id)
            .fetch().rowsUpdated();
    }

    private PersonRow mapPerson(io.r2dbc.spi.Readable row) {
        return new PersonRow(
            (Long) row.get("id"),
            (String) row.get("first_name"),
            (String) row.get("last_name"),
            (String) row.get("email")
        );
    }

    private TokenRow mapToken(io.r2dbc.spi.Readable row) {
        return new TokenRow(
            (Long) row.get("id"),
            (String) row.get("purpose"),
            (String) row.get("email"),
            (Long) row.get("lecturer_id"),
            (Long) row.get("student_id"),
            (Long) row.get("user_id"),
            (LocalDateTime) row.get("expires_at"),
            Boolean.TRUE.equals(row.get("expired")),
            (LocalDateTime) row.get("used_at")
        );
    }
}
