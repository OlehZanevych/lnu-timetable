package org.lnu.timetable.security;

import io.r2dbc.spi.Parameters;
import io.r2dbc.spi.R2dbcType;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.time.LocalDateTime;

/**
 * Raw SQL over {@code group_invitations} — the links that put whoever follows them into one group.
 *
 * <p>Like {@link PermissionRepository}, this sits outside the {@code @GraphQLEntity} framework, and
 * for a sharper reason than that table does: {@code token} is a live bearer credential, and the
 * generic, selection-set-driven machinery would happily return it to anyone who asked for the
 * field. Every read here goes through {@link GroupInvitationDataFetchers}, which asks first whether
 * the caller may administer the group.
 *
 * <p><strong>The lifetime is computed by the database, not by the JVM.</strong>
 * {@code group_invitations_lifetime_check} compares {@code expires_at} against {@code created_at},
 * and {@code created_at} defaults to the database's {@code now()}. Sending an
 * {@code Instant.now().plus(ttl)} from the service instead would compare two clocks: whenever the
 * application host is even a millisecond ahead of the database, a request for the maximum thirty
 * days writes a row a millisecond over the limit and the insert fails with an integrity violation
 * nobody can reproduce. {@code now() + make_interval(mins => :ttl)} is the same clock on both sides
 * of the constraint, by construction.
 */
@Component
public class GroupInvitationRepository {

    /**
     * One invitation as the client sees it. {@code expired} is computed in SQL rather than compared
     * in Java for the same reason the lifetime is: the answer belongs to the clock that wrote the
     * row. {@code createdByName} is the display name of the account that made it, or null once that
     * account has been deleted — the row survives it (`ON DELETE SET NULL`), because who opened a
     * door is worth knowing after they have gone.
     */
    public record InvitationRow(Long id, Long groupId, String token, LocalDateTime expiresAt,
                                boolean expired, int joinCount, Long createdBy, String createdByName,
                                LocalDateTime createdAt) {}

    private final DatabaseClient db;

    public GroupInvitationRepository(DatabaseClient db) {
        this.db = db;
    }

    private static final String SELECT_INVITATION =
        "SELECT i.id, i.group_id, i.token, i.expires_at, (i.expires_at <= now()) AS expired, " +
            "i.join_count, i.created_by, u.first_name, u.last_name, i.created_at " +
            "FROM group_invitations i LEFT JOIN users u ON u.id = i.created_by";

    /** Every invitation of one group, newest first — what «Посилання-запрошення» lists. */
    public Flux<InvitationRow> listForGroup(Long groupId) {
        return db.sql(SELECT_INVITATION + " WHERE i.group_id = :groupId ORDER BY i.created_at DESC")
            .bind("groupId", groupId)
            .map(this::mapInvitation)
            .all();
    }

    /**
     * The link itself, expired or not. Expiry is reported rather than filtered here: «термін дії
     * посилання минув, попросіть нове» and «такого посилання не існує» are different things to tell
     * somebody standing on the page, and a query that returned nothing for both could only say the
     * second.
     */
    public Mono<InvitationRow> findByToken(String token) {
        return db.sql(SELECT_INVITATION + " WHERE i.token = :token")
            .bind("token", token)
            .map(this::mapInvitation)
            .one()
            .onErrorResume(e -> Mono.empty());
    }

    public Mono<InvitationRow> findById(Long id) {
        return db.sql(SELECT_INVITATION + " WHERE i.id = :id")
            .bind("id", id)
            .map(this::mapInvitation)
            .one()
            .onErrorResume(e -> Mono.empty());
    }

    /**
     * Writes one invitation and reads it back. {@code ttlMinutes} is bounded by the caller (5 to
     * 43 200) and again by {@code group_invitations_lifetime_check}, which is the copy that holds
     * when the caller is not this service.
     */
    public Mono<InvitationRow> insert(Long groupId, String token, int ttlMinutes, Long createdBy) {
        return db.sql("INSERT INTO group_invitations (group_id, token, expires_at, created_by) " +
                "VALUES (:groupId, :token, now() + make_interval(mins => :ttlMinutes), :createdBy) RETURNING id")
            .bind("groupId", groupId)
            .bind("token", token)
            .bind("ttlMinutes", ttlMinutes)
            // Null whenever the creating account has since been forgotten — R2DBC refuses a plain
            // bind of null, so the type travels with the absent value. Same shape as
            // PermissionRepository#upsertPermission.
            .bind("createdBy", Parameters.in(R2dbcType.BIGINT, createdBy))
            .map(row -> (Long) row.get("id"))
            .one()
            .flatMap(this::findById);
    }

    /** Deleting an invitation is how it is revoked; there is no «disabled» state to reason about. */
    public Mono<Long> delete(Long id) {
        return db.sql("DELETE FROM group_invitations WHERE id = :id")
            .bind("id", id)
            .fetch()
            .rowsUpdated();
    }

    /**
     * Counts one redemption. Deliberately not conditional on anything: it runs after the membership
     * row has been inserted, and a link that expired in the meantime has already been refused.
     */
    public Mono<Long> recordJoin(Long id) {
        return db.sql("UPDATE group_invitations SET join_count = join_count + 1 WHERE id = :id")
            .bind("id", id)
            .fetch()
            .rowsUpdated();
    }

    private InvitationRow mapInvitation(io.r2dbc.spi.Readable row) {
        String first = (String) row.get("first_name");
        String last = (String) row.get("last_name");
        String name = first == null && last == null ? null
            : ((first == null ? "" : first) + " " + (last == null ? "" : last)).trim();
        return new InvitationRow(
            (Long) row.get("id"),
            (Long) row.get("group_id"),
            (String) row.get("token"),
            (LocalDateTime) row.get("expires_at"),
            Boolean.TRUE.equals(row.get("expired")),
            row.get("join_count") == null ? 0 : ((Number) row.get("join_count")).intValue(),
            (Long) row.get("created_by"),
            name,
            (LocalDateTime) row.get("created_at")
        );
    }
}
