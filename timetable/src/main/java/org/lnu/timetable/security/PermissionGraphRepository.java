package org.lnu.timetable.security;

import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.Collection;
import java.util.List;

/**
 * Small, purpose-built reader for walking the permission-ancestor graph declared via
 * {@code @PermissionParent}/{@code @PermissionJoinParent} (see {@link PermissionService}) — kept
 * separate from {@link org.lnu.timetable.framework.query.R2dbcQueryEngine} because its queries
 * (raw FK-column reads, join-table parent lookups) don't fit that engine's per-request,
 * selection-set-driven column projection model.
 * <p>
 * Every method here is <em>set-at-a-time</em>: it takes all the row ids the walk is currently
 * standing on and returns all their parent edges in one statement. That shape is the whole point.
 * The previous version read one row per call, so answering "which of these 200 courses may I edit?"
 * cost 200 independent chains of round trips up the hierarchy — the same faculty fetched two
 * hundred times. {@link PermissionEvaluator} now walks the graph breadth-first, one query per
 * (table, edge) per level, which makes that same question a handful of statements regardless of how
 * many rows are on screen.
 */
@Component
public class PermissionGraphRepository {

    /** One resolved foreign key: {@code childId}'s {@code column} points at {@code parentId}. */
    public record FkEdge(Long childId, String column, Long parentId) {}

    /** One resolved join-table edge: {@code childId} is linked to {@code parentId}. */
    public record JoinEdge(Long childId, Long parentId) {}

    private final DatabaseClient db;

    public PermissionGraphRepository(DatabaseClient db) {
        this.db = db;
    }

    /**
     * Reads the given FK columns for every id in {@code ids}, emitting one {@link FkEdge} per
     * non-null value. Rows that do not exist, and columns that are null (an optional parent that
     * was never set), simply produce nothing — an unreachable ancestor is indistinguishable from an
     * absent one for authorization purposes, and both mean "this path grants nothing".
     * <p>
     * {@code keyColumn} is the entity's own key (see {@code EntityMetadata#keyColumn()}), aliased
     * to {@code id} here so the walk above stays written in terms of ids. For an entity keyed by
     * its parent that column is also one of {@code columns} — selecting it twice under two labels
     * is what lets the same row be both the child being asked about and the edge upward.
     */
    public Flux<FkEdge> fetchForeignKeys(String table, String keyColumn, List<String> columns, Collection<Long> ids) {
        if (columns.isEmpty() || ids.isEmpty()) return Flux.empty();
        String sql = "SELECT " + keyColumn + " AS id, " + String.join(", ", columns)
            + " FROM " + table + " WHERE " + keyColumn + " = ANY(:ids)";
        return db.sql(sql).bind("ids", ids.toArray(new Long[0]))
            .map(row -> {
                Long childId = ((Number) row.get("id")).longValue();
                return columns.stream()
                    .map(column -> {
                        Object raw = row.get(column);
                        return raw == null ? null : new FkEdge(childId, column, ((Number) raw).longValue());
                    })
                    .filter(java.util.Objects::nonNull)
                    .toList();
            })
            .all()
            .flatMapIterable(edges -> edges);
    }

    /** Resolves the parent ids linked to each of {@code ids} through a many-to-many join table. */
    public Flux<JoinEdge> fetchJoinParents(String joinTable, String selfColumn, String parentColumn,
                                            Collection<Long> ids) {
        if (ids.isEmpty()) return Flux.empty();
        String sql = "SELECT " + selfColumn + " AS child_id, " + parentColumn + " AS parent_id " +
            "FROM " + joinTable + " WHERE " + selfColumn + " = ANY(:ids)";
        return db.sql(sql).bind("ids", ids.toArray(new Long[0]))
            .map(row -> new JoinEdge(((Number) row.get("child_id")).longValue(),
                ((Number) row.get("parent_id")).longValue()))
            .all();
    }

    /** Best-effort human label for a resource, used only for admin-UI display (never for authz decisions). */
    public Mono<String> fetchLabel(String table, String keyColumn, String column, Long id) {
        String sql = "SELECT " + column + " AS label FROM " + table + " WHERE " + keyColumn + " = :id";
        return db.sql(sql).bind("id", id)
            .map(row -> (String) row.get("label"))
            .one()
            .onErrorResume(e -> Mono.empty())
            .defaultIfEmpty("#" + id);
    }
}
