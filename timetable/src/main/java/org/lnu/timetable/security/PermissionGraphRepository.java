package org.lnu.timetable.security;

import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Small, purpose-built reader for walking the permission-ancestor graph declared via
 * {@code @PermissionParent}/{@code @PermissionJoinParent} (see {@link PermissionService}) — kept
 * separate from {@link org.lnu.timetable.framework.query.R2dbcQueryEngine} because its queries
 * (raw FK-column reads, join-table parent lookups) don't fit that engine's per-request,
 * selection-set-driven column projection model.
 */
@Component
public class PermissionGraphRepository {

    private final DatabaseClient db;

    public PermissionGraphRepository(DatabaseClient db) {
        this.db = db;
    }

    /** Reads the given FK columns of a single row, by id. Missing row -> empty map. */
    public Mono<Map<String, Object>> fetchForeignKeys(String table, List<String> columns, Long id) {
        if (columns.isEmpty()) return Mono.just(Map.of());
        String sql = "SELECT " + String.join(", ", columns) + " FROM " + table + " WHERE id = :id";
        return db.sql(sql).bind("id", id)
            .map(row -> {
                Map<String, Object> values = new LinkedHashMap<>();
                for (String col : columns) {
                    values.put(col, row.get(col));
                }
                return values;
            })
            .one()
            .onErrorResume(e -> Mono.just(Map.of()))
            .defaultIfEmpty(Map.of());
    }

    /** Resolves the parent id(s) linked to {@code selfId} through a many-to-many join table. */
    public Flux<Long> fetchJoinParentIds(String joinTable, String selfColumn, String parentColumn, Long selfId) {
        String sql = "SELECT " + parentColumn + " AS parent_id FROM " + joinTable + " WHERE " + selfColumn + " = :id";
        return db.sql(sql).bind("id", selfId)
            .map(row -> ((Number) row.get("parent_id")).longValue())
            .all();
    }

    /** Best-effort human label for a resource, used only for admin-UI display (never for authz decisions). */
    public Mono<String> fetchLabel(String table, String column, Long id) {
        String sql = "SELECT " + column + " AS label FROM " + table + " WHERE id = :id";
        return db.sql(sql).bind("id", id)
            .map(row -> (String) row.get("label"))
            .one()
            .onErrorResume(e -> Mono.empty())
            .defaultIfEmpty("#" + id);
    }
}
