package org.lnu.timetable.security;

import io.r2dbc.spi.Parameters;
import io.r2dbc.spi.R2dbcType;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

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

    public record PermissionRow(Long id, String granteeType, Long userId, Long groupId,
                                 String resourceType, Long resourceId, Long grantedBy) {}

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

    public Mono<Long> insertUser(String email, String firstName, String lastName, String passwordHash,
                                  Long lecturerId, Long studentId) {
        return db.sql("INSERT INTO users (email, first_name, last_name, password_hash, must_change_password, is_active, " +
                "lecturer_id, student_id) " +
                "VALUES (:email, :firstName, :lastName, :hash, TRUE, TRUE, :lecturerId, :studentId) RETURNING id")
            .bind("email", email).bind("firstName", firstName).bind("lastName", lastName).bind("hash", passwordHash)
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

    /** Every grant (direct-to-user or via a group they belong to) that applies to {@code userId}. */
    public Flux<PermissionRow> effectiveGrants(Long userId, List<Long> groupIds) {
        String sql = groupIds.isEmpty()
            ? "SELECT id, grantee_type, user_id, group_id, resource_type, resource_id, granted_by FROM permissions WHERE user_id = :userId"
            : "SELECT id, grantee_type, user_id, group_id, resource_type, resource_id, granted_by FROM permissions " +
              "WHERE user_id = :userId OR group_id = ANY(:groupIds)";
        var spec = db.sql(sql).bind("userId", userId);
        if (!groupIds.isEmpty()) {
            spec = spec.bind("groupIds", groupIds.toArray(new Long[0]));
        }
        return spec.map(this::mapPermission).all();
    }

    /** Whether {@code userId} (directly, or via one of {@code groupIds}) holds a GLOBAL admin grant. */
    public Mono<Boolean> isGlobalAdmin(Long userId, List<Long> groupIds) {
        return hasAnyGrant(userId, groupIds, Set.of());
    }

    /**
     * Whether {@code userId} (directly, or via one of {@code groupIds}) holds a grant matching
     * {@code GLOBAL}, or any (resourceType, resourceId) pair in {@code refs}.
     */
    public Mono<Boolean> hasAnyGrant(Long userId, List<Long> groupIds, Set<ResourceRef> refs) {
        List<String> conditions = new ArrayList<>();
        conditions.add("resource_type = 'GLOBAL'");
        var spec = db.sql(buildHasAnyGrantSql(groupIds, refs, conditions)).bind("userId", userId);
        if (!groupIds.isEmpty()) {
            spec = spec.bind("groupIds", groupIds.toArray(new Long[0]));
        }
        int i = 0;
        for (ResourceRef ref : refs) {
            spec = spec.bind("t" + i, ref.resourceType()).bind("i" + i, ref.resourceId());
            i++;
        }
        return spec.map(row -> true).first().defaultIfEmpty(false);
    }

    private String buildHasAnyGrantSql(List<Long> groupIds, Set<ResourceRef> refs, List<String> conditions) {
        int i = 0;
        for (ResourceRef ignored : refs) {
            conditions.add("(resource_type = :t" + i + " AND resource_id = :i" + i + ")");
            i++;
        }
        String granteeClause = groupIds.isEmpty() ? "user_id = :userId" : "(user_id = :userId OR group_id = ANY(:groupIds))";
        return "SELECT 1 FROM permissions WHERE " + granteeClause + " AND (" +
            String.join(" OR ", conditions) + ") LIMIT 1";
    }

    public Mono<Long> insertPermission(String granteeType, Long userId, Long groupId,
                                        String resourceType, Long resourceId, Long grantedBy) {
        return db.sql("INSERT INTO permissions (grantee_type, user_id, group_id, resource_type, resource_id, granted_by) " +
                "VALUES (:granteeType::grantee_type, :userId, :groupId, :resourceType, :resourceId, :grantedBy) " +
                "ON CONFLICT DO NOTHING RETURNING id")
            .bind("granteeType", granteeType)
            .bind("userId", userId).bind("groupId", groupId)
            .bind("resourceType", resourceType).bind("resourceId", resourceId)
            .bind("grantedBy", grantedBy)
            .map(row -> (Long) row.get("id"))
            .one()
            .onErrorResume(e -> Mono.empty());
    }

    public Mono<PermissionRow> findPermission(Long id) {
        return db.sql("SELECT id, grantee_type, user_id, group_id, resource_type, resource_id, granted_by " +
                "FROM permissions WHERE id = :id")
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
            ? "SELECT id, grantee_type, user_id, group_id, resource_type, resource_id, granted_by " +
              "FROM permissions WHERE resource_type = :resourceType AND resource_id IS NULL"
            : "SELECT id, grantee_type, user_id, group_id, resource_type, resource_id, granted_by " +
              "FROM permissions WHERE resource_type = :resourceType AND resource_id = :resourceId";
        var spec = db.sql(sql).bind("resourceType", resourceType);
        if (resourceId != null) spec = spec.bind("resourceId", resourceId);
        return spec.map(this::mapPermission).all();
    }

    private PermissionRow mapPermission(io.r2dbc.spi.Readable row) {
        return new PermissionRow(
            (Long) row.get("id"),
            String.valueOf(row.get("grantee_type")),
            (Long) row.get("user_id"),
            (Long) row.get("group_id"),
            (String) row.get("resource_type"),
            (Long) row.get("resource_id"),
            (Long) row.get("granted_by")
        );
    }
}
