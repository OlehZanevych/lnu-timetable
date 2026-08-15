package org.lnu.timetable.security;

import io.r2dbc.spi.Parameters;
import io.r2dbc.spi.R2dbcType;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * Raw SQL access to the {@code users} / {@code groups} / {@code user_groups} / {@code permissions}
 * tables. These deliberately sit outside the {@code @GraphQLEntity} generic CRUD framework (see
 * {@code org.lnu.timetable.framework}) — a user's password hash must never be reachable through
 * the reflective, fully-generic query/mutation machinery, and grant checks need bespoke SQL (OR'd
 * resource-type/id pairs, {@code GLOBAL} short-circuiting) that doesn't fit that engine's model.
 */
@Component
public class PermissionRepository {

    /**
     * {@code lecturerId} / {@code studentId} are the optional, mutually exclusive link to the person
     * this account is (see {@code users_person_link_check} in {@code schema.sql}). Both are null for
     * the accounts that are nobody in particular — deanery staff, the administrator.
     */
    public record UserRow(Long id, String email, String firstName, String lastName,
                           String passwordHash, boolean mustChangePassword, boolean active,
                           Long lecturerId, Long studentId) {}

    public record GroupRow(Long id, String name, String description) {}

    /**
     * {@code level} is the {@link AccessLevel} this grant carries — EDIT, FULL or MANAGE. It is a
     * column on the grant rather than a second grant row on purpose: a grantee holds at most one
     * grant per exact resource ({@code permissions_unique_grant}), so "what may this person do
     * here" is one value to read and one value to change, never a maximum over near-duplicate rows.
     */
    public record PermissionRow(Long id, String granteeType, Long userId, Long groupId,
                                 String resourceType, Long resourceId, AccessLevel level, Long grantedBy) {}

    private final DatabaseClient db;

    public PermissionRepository(DatabaseClient db) {
        this.db = db;
    }

    // --- users ---

    public Mono<UserRow> findUserByEmail(String email) {
        return db.sql("SELECT id, email, first_name, last_name, password_hash, must_change_password, is_active, lecturer_id, student_id " +
                "FROM users WHERE lower(email) = lower(:email)")
            .bind("email", email)
            .map(this::mapUser)
            .one()
            .onErrorResume(e -> Mono.empty());
    }

    public Mono<UserRow> findUserById(Long id) {
        return db.sql("SELECT id, email, first_name, last_name, password_hash, must_change_password, is_active, lecturer_id, student_id " +
                "FROM users WHERE id = :id")
            .bind("id", id)
            .map(this::mapUser)
            .one()
            .onErrorResume(e -> Mono.empty());
    }

    public Flux<UserRow> listUsers() {
        return db.sql("SELECT id, email, first_name, last_name, password_hash, must_change_password, is_active, lecturer_id, student_id " +
                "FROM users ORDER BY last_name, first_name")
            .map(this::mapUser)
            .all();
    }

    /**
     * Name/e-mail search over active accounts, for the grantee picker on the access panels. Narrow
     * on purpose: it returns identity only, needs at least two characters, and is reachable only by
     * someone who can already delegate access somewhere (see {@code AuthDataFetchers#searchUsers}).
     * The full {@code Query.users} listing stays administrator-only — a деканат needs to find the
     * person they are handing a кафедра to, not to enumerate the university's staff.
     */
    public Flux<UserRow> searchUsers(String query, int limit) {
        return db.sql("SELECT id, email, first_name, last_name, password_hash, must_change_password, is_active, " +
                "lecturer_id, student_id FROM users " +
                "WHERE is_active AND (lower(email) LIKE :q OR lower(last_name || ' ' || first_name) LIKE :q " +
                "OR lower(first_name || ' ' || last_name) LIKE :q) " +
                "ORDER BY last_name, first_name LIMIT :limit")
            .bind("q", "%" + query.toLowerCase() + "%")
            .bind("limit", limit)
            .map(this::mapUser)
            .all();
    }

    /**
     * The administrator's {@code createUser}: an account with a temporary password, which its owner
     * has to replace before the session is good for anything else.
     */
    public Mono<Long> insertUser(String email, String firstName, String lastName, String passwordHash,
                                  Long lecturerId, Long studentId) {
        return insertUser(email, firstName, lastName, passwordHash, lecturerId, studentId, true);
    }

    /**
     * The same, saying explicitly whether the new password is a temporary one.
     * <p>
     * {@code must_change_password} exists because an administrator has to invent a password for
     * somebody else and therefore knows it. Nobody else does: an account created through a
     * registration link was given its password by the person who will use it, over TLS, and forcing
     * them to change it on the next screen would be asking them to replace a secret only they have
     * ever seen. So self-registration passes {@code false}, and it is the one caller that does.
     */
    public Mono<Long> insertUser(String email, String firstName, String lastName, String passwordHash,
                                  Long lecturerId, Long studentId, boolean mustChangePassword) {
        return db.sql("INSERT INTO users (email, first_name, last_name, password_hash, must_change_password, is_active, " +
                "lecturer_id, student_id) " +
                "VALUES (:email, :firstName, :lastName, :hash, :mustChange, TRUE, :lecturerId, :studentId) RETURNING id")
            .bind("email", email).bind("firstName", firstName).bind("lastName", lastName).bind("hash", passwordHash)
            .bind("mustChange", mustChangePassword)
            .bind("lecturerId", Parameters.in(R2dbcType.BIGINT, lecturerId))
            .bind("studentId", Parameters.in(R2dbcType.BIGINT, studentId))
            .map(row -> (Long) row.get("id"))
            .one();
    }

    /**
     * Points an account at the lecturer or the student it belongs to, or at neither (both null).
     * Passing both is rejected before this is reached ({@code AuthDataFetchers#setUserLink}) and
     * again by {@code users_person_link_check} if it somehow is not; a lecturer or student already
     * claimed by another account trips {@code users_unique_lecturer} / {@code users_unique_student}.
     * Both surface as an <em>error</em> signal, which
     * {@code AuthDataFetchers#setUserLink} translates into a named status by SQLSTATE. A user id
     * that matches nothing is not an error: {@code rowsUpdated()} always emits, so the caller reads
     * 0 and reports {@code USER_NOT_FOUND}.
     */
    public Mono<Long> setUserLink(Long userId, Long lecturerId, Long studentId) {
        return db.sql("UPDATE users SET lecturer_id = :lecturerId, student_id = :studentId, updated_at = now() " +
                "WHERE id = :id")
            .bind("lecturerId", Parameters.in(R2dbcType.BIGINT, lecturerId))
            .bind("studentId", Parameters.in(R2dbcType.BIGINT, studentId))
            .bind("id", userId)
            .fetch().rowsUpdated();
    }

    public Mono<Long> updatePassword(Long userId, String passwordHash, boolean mustChangePassword) {
        return db.sql("UPDATE users SET password_hash = :hash, must_change_password = :mustChange, updated_at = now() WHERE id = :id")
            .bind("hash", passwordHash).bind("mustChange", mustChangePassword).bind("id", userId)
            .fetch().rowsUpdated();
    }

    public Mono<Long> setUserActive(Long userId, boolean active) {
        return db.sql("UPDATE users SET is_active = :active, updated_at = now() WHERE id = :id")
            .bind("active", active).bind("id", userId)
            .fetch().rowsUpdated();
    }

    private UserRow mapUser(io.r2dbc.spi.Readable row) {
        return new UserRow(
            (Long) row.get("id"),
            (String) row.get("email"),
            (String) row.get("first_name"),
            (String) row.get("last_name"),
            (String) row.get("password_hash"),
            Boolean.TRUE.equals(row.get("must_change_password")),
            Boolean.TRUE.equals(row.get("is_active")),
            (Long) row.get("lecturer_id"),
            (Long) row.get("student_id")
        );
    }

    // --- groups & membership ---

    public Mono<GroupRow> findGroupById(Long id) {
        return db.sql("SELECT id, name, description FROM groups WHERE id = :id")
            .bind("id", id)
            .map(row -> new GroupRow((Long) row.get("id"), (String) row.get("name"), (String) row.get("description")))
            .one()
            .onErrorResume(e -> Mono.empty());
    }

    public Flux<GroupRow> listGroups() {
        return db.sql("SELECT id, name, description FROM groups ORDER BY name")
            .map(row -> new GroupRow((Long) row.get("id"), (String) row.get("name"), (String) row.get("description")))
            .all();
    }

    public Mono<Long> insertGroup(String name, String description) {
        return db.sql("INSERT INTO groups (name, description) VALUES (:name, :description) RETURNING id")
            .bind("name", name).bind("description", description == null ? "" : description)
            .map(row -> (Long) row.get("id"))
            .one();
    }

    public Flux<Long> groupIdsForUser(Long userId) {
        return db.sql("SELECT group_id FROM user_groups WHERE user_id = :userId")
            .bind("userId", userId)
            .map(row -> (Long) row.get("group_id"))
            .all();
    }

    public Flux<UserRow> usersInGroup(Long groupId) {
        return db.sql("SELECT u.id, u.email, u.first_name, u.last_name, u.password_hash, u.must_change_password, u.is_active, u.lecturer_id, u.student_id " +
                "FROM users u JOIN user_groups ug ON ug.user_id = u.id WHERE ug.group_id = :groupId ORDER BY u.last_name, u.first_name")
            .bind("groupId", groupId)
            .map(this::mapUser)
            .all();
    }

    public Flux<GroupRow> groupsForUser(Long userId) {
        return db.sql("SELECT g.id, g.name, g.description FROM groups g " +
                "JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = :userId ORDER BY g.name")
            .bind("userId", userId)
            .map(row -> new GroupRow((Long) row.get("id"), (String) row.get("name"), (String) row.get("description")))
            .all();
    }

    public Mono<Long> addUserToGroup(Long userId, Long groupId) {
        return db.sql("INSERT INTO user_groups (user_id, group_id) VALUES (:userId, :groupId) ON CONFLICT DO NOTHING")
            .bind("userId", userId).bind("groupId", groupId)
            .fetch().rowsUpdated();
    }

    public Mono<Long> removeUserFromGroup(Long userId, Long groupId) {
        return db.sql("DELETE FROM user_groups WHERE user_id = :userId AND group_id = :groupId")
            .bind("userId", userId).bind("groupId", groupId)
            .fetch().rowsUpdated();
    }

    // --- permission grants ---

    /**
     * Every grant (direct-to-user or via a group they belong to) that applies to {@code userId}.
     * <p>
     * This is now the <em>only</em> grant query the authorization path runs. It used to be
     * accompanied by a {@code hasAnyGrant} statement per decision, whose WHERE clause was an OR-list
     * of every ancestor the walk had reached — so the more deeply nested the row, the longer the SQL
     * and the more of it the database had to re-plan. A user holds a handful of grants; loading them
     * once per request and answering every question against that map in memory is both fewer round
     * trips and less work per trip. See {@link PermissionEvaluator}.
     */
    public Flux<PermissionRow> effectiveGrants(Long userId, List<Long> groupIds) {
        String sql = groupIds.isEmpty()
            ? SELECT_GRANT + " FROM permissions WHERE user_id = :userId"
            : SELECT_GRANT + " FROM permissions WHERE user_id = :userId OR group_id = ANY(:groupIds)";
        var spec = db.sql(sql).bind("userId", userId);
        if (!groupIds.isEmpty()) {
            spec = spec.bind("groupIds", groupIds.toArray(new Long[0]));
        }
        return spec.map(this::mapPermission).all();
    }

    /**
     * Creates the grant, or — when the grantee already holds one on exactly this resource — moves it
     * to the new level. Re-granting is deliberately an update rather than a duplicate-key failure:
     * "give Ivanenko FULL on this кафедра, he only had EDIT" is the same administrative act as
     * granting it in the first place, and making the caller revoke-then-grant would leave a window
     * where they had neither.
     *
     * @return the grant's id, and whether the row already existed (so the caller can say
     *         «оновлено» rather than «надано»)
     */
    public Mono<GrantOutcome> upsertPermission(String granteeType, Long userId, Long groupId,
                                                String resourceType, Long resourceId, AccessLevel level,
                                                Long grantedBy) {
        return db.sql("INSERT INTO permissions (grantee_type, user_id, group_id, resource_type, resource_id, level, granted_by) " +
                "VALUES (:granteeType::grantee_type, :userId, :groupId, :resourceType, :resourceId, :level::access_level, :grantedBy) " +
                "ON CONFLICT (grantee_type, COALESCE(user_id, 0), COALESCE(group_id, 0), resource_type, COALESCE(resource_id, 0)) " +
                "DO UPDATE SET level = EXCLUDED.level, granted_by = EXCLUDED.granted_by, updated_at = now() " +
                "RETURNING id, (xmax <> 0) AS was_update")
            .bind("granteeType", granteeType)
            // Three of these are null on any given call — a grant is a user's or a group's, never
            // both, and resource_id is null for GLOBAL — and R2DBC refuses a plain bind(name, null):
            // it has no type to send the parameter as. Parameters.in(BIGINT, value) carries the type
            // alongside the (possibly absent) value, which is the same thing insertUser and
            // setUserLink above do for the person link.
            .bind("userId", Parameters.in(R2dbcType.BIGINT, userId))
            .bind("groupId", Parameters.in(R2dbcType.BIGINT, groupId))
            .bind("resourceType", resourceType)
            .bind("resourceId", Parameters.in(R2dbcType.BIGINT, resourceId))
            .bind("level", level.name())
            .bind("grantedBy", Parameters.in(R2dbcType.BIGINT, grantedBy))
            .map(row -> new GrantOutcome((Long) row.get("id"), Boolean.TRUE.equals(row.get("was_update"))))
            .one();
    }

    /** Result of {@link #upsertPermission}: the row id, and whether an existing grant was re-levelled. */
    public record GrantOutcome(Long id, boolean updated) {}

    public Mono<PermissionRow> findPermission(Long id) {
        return db.sql(SELECT_GRANT + " FROM permissions WHERE id = :id")
            .bind("id", id)
            .map(this::mapPermission)
            .one()
            .onErrorResume(e -> Mono.empty());
    }

    public Mono<Long> deletePermission(Long id) {
        return db.sql("DELETE FROM permissions WHERE id = :id").bind("id", id).fetch().rowsUpdated();
    }

    public Flux<PermissionRow> grantsForResource(String resourceType, Long resourceId) {
        String sql = resourceId == null
            ? SELECT_GRANT + " FROM permissions WHERE resource_type = :resourceType AND resource_id IS NULL"
            : SELECT_GRANT + " FROM permissions WHERE resource_type = :resourceType AND resource_id = :resourceId";
        var spec = db.sql(sql).bind("resourceType", resourceType);
        if (resourceId != null) spec = spec.bind("resourceId", resourceId);
        return spec.map(this::mapPermission).all();
    }

    /**
     * Every grant sitting on any of {@code refs} — used to show <em>inherited</em> access, not just
     * the grants attached to one row. Asked with a resource's whole ancestor closure it answers
     * "who can actually touch this кафедра", which is the question an administrator has, rather than
     * "who was granted it here", which is the question the storage happens to answer. GLOBAL grants
     * are included whenever the closure contains the synthetic GLOBAL ref.
     */
    public Flux<PermissionRow> grantsForResources(Collection<ResourceRef> refs) {
        if (refs.isEmpty()) return Flux.empty();
        List<String> conditions = new ArrayList<>();
        var typed = new ArrayList<ResourceRef>();
        boolean global = false;
        for (ResourceRef ref : refs) {
            if (ref.isGlobal()) {
                global = true;
            } else {
                conditions.add("(resource_type = :t" + typed.size() + " AND resource_id = :i" + typed.size() + ")");
                typed.add(ref);
            }
        }
        if (global) conditions.add("resource_type = 'GLOBAL'");
        if (conditions.isEmpty()) return Flux.empty();
        var spec = db.sql(SELECT_GRANT + " FROM permissions WHERE " + String.join(" OR ", conditions));
        for (int i = 0; i < typed.size(); i++) {
            spec = spec.bind("t" + i, typed.get(i).resourceType()).bind("i" + i, typed.get(i).resourceId());
        }
        return spec.map(this::mapPermission).all();
    }

    private static final String SELECT_GRANT =
        "SELECT id, grantee_type, user_id, group_id, resource_type, resource_id, level, granted_by";

    private PermissionRow mapPermission(io.r2dbc.spi.Readable row) {
        return new PermissionRow(
            (Long) row.get("id"),
            String.valueOf(row.get("grantee_type")),
            (Long) row.get("user_id"),
            (Long) row.get("group_id"),
            (String) row.get("resource_type"),
            (Long) row.get("resource_id"),
            AccessLevel.parse(row.get("level")),
            (Long) row.get("granted_by")
        );
    }
}
