package org.lnu.timetable.framework.query;

import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

/**
 * Builds and executes optimized SQL queries that select only the requested columns.
 */
@Component
public class R2dbcQueryEngine {

    /** A column to select, aliased to the GraphQL field name (map key). */
    public record Col(String column, String alias) {}

    /** An equality filter applied as a WHERE clause to list/count queries. */
    public record Filter(String column, Object value) {}

    /**
     * Wraps a value destined for a column backed by a native Postgres enum type (see
     * {@code @PgEnum}), so {@link #insert} / {@link #update} can add an explicit {@code ::type}
     * cast in the generated SQL. R2DBC binds plain Java values as their default wire type (a
     * {@code String} becomes VARCHAR), and Postgres will not implicitly coerce that to a custom
     * enum column type the way it does for untyped literals in plain SQL text.
     */
    public record EnumValue(Object value, String pgType) {}

    /**
     * A row returned from a batched lookup, paired with the "grouping key" (the FK / join-table
     * value it belongs to) so callers can bucket rows back per original request key. Used by
     * {@link #selectWhereIn} and {@link #selectViaJoinTableBatch} to support DataLoader batching.
     */
    public record KeyedRow(Object key, Map<String, Object> row) {}

    private final DatabaseClient db;

    public R2dbcQueryEngine(DatabaseClient db) {
        this.db = db;
    }

    public Mono<Map<String, Object>> selectOne(String table, List<Col> cols, String whereColumn, Object value) {
        String sql = "SELECT " + projection(cols) + " FROM " + table + " WHERE " + whereColumn + " = :v";
        return db.sql(sql).bind("v", value).map(row -> mapRow(row, cols)).one();
    }

    public Flux<Map<String, Object>> selectList(String table, List<Col> cols, String orderByColumn,
                                                int limit, long offset, List<Filter> filters) {
        StringBuilder sql = new StringBuilder("SELECT ").append(projection(cols)).append(" FROM ").append(table);
        appendWhere(sql, filters);
        if (orderByColumn != null) sql.append(" ORDER BY ").append(orderByColumn);
        sql.append(" LIMIT ").append(limit);
        if (offset != 0) sql.append(" OFFSET ").append(offset);
        return bindFilters(db.sql(sql.toString()), filters).map(row -> mapRow(row, cols)).all();
    }

    public Flux<Map<String, Object>> selectWhere(String table, List<Col> cols, String whereColumn, Object value, String orderByColumn) {
        StringBuilder sql = new StringBuilder("SELECT ").append(projection(cols))
            .append(" FROM ").append(table).append(" WHERE ").append(whereColumn).append(" = :v");
        if (orderByColumn != null) {
            sql.append(" ORDER BY ").append(orderByColumn);
        }
        return db.sql(sql.toString()).bind("v", value).map(row -> mapRow(row, cols)).all();
    }

    public Mono<Long> count(String table) {
        return db.sql("SELECT COUNT(*) FROM " + table).map(row -> ((Number) row.get(0)).longValue()).one();
    }

    public Mono<Long> countWhere(String table, List<Filter> filters) {
        if (filters.isEmpty()) return count(table);
        StringBuilder sql = new StringBuilder("SELECT COUNT(*) FROM ").append(table);
        appendWhere(sql, filters);
        return bindFilters(db.sql(sql.toString()), filters)
            .map(row -> ((Number) row.get(0)).longValue()).one();
    }

    /** Batched many-to-one / one-to-one lookup: fetches every row of {@code table} whose id is in {@code ids} in a single query. */
    public Flux<Map<String, Object>> selectByIds(String table, List<Col> cols, Collection<Object> ids) {
        if (ids.isEmpty()) return Flux.empty();
        String sql = "SELECT " + projection(cols) + " FROM " + table + " WHERE id = ANY(:ids)";
        return db.sql(sql).bind("ids", toLongArray(ids)).map(row -> mapRow(row, cols)).all();
    }

    /**
     * Batched one-to-many lookup: fetches every row of {@code table} whose {@code fkColumn} is in
     * {@code fkValues} in a single query, pairing each row with its {@code fkColumn} value so the
     * caller can group rows back per parent id.
     */
    public Flux<KeyedRow> selectWhereIn(String table, List<Col> cols, String fkColumn, Collection<Object> fkValues) {
        if (fkValues.isEmpty()) return Flux.empty();
        String sql = "SELECT " + projection(cols) + ", " + fkColumn + " AS \"__batchFk\" FROM " + table
            + " WHERE " + fkColumn + " = ANY(:vals) ORDER BY id";
        return db.sql(sql).bind("vals", toLongArray(fkValues))
            .map(row -> new KeyedRow(row.get("__batchFk"), mapRow(row, cols)))
            .all();
    }

    /**
     * Batched many-to-many lookup: for every id in {@code parentIds}, fetches the linked rows of
     * {@code table} via {@code joinTable} in a single query, pairing each row with the parent id
     * (the join table's {@code joinColumn} value) it belongs to.
     */
    public Flux<KeyedRow> selectViaJoinTableBatch(String table, List<Col> cols, String joinTable,
                                                  String joinColumn, String inverseJoinColumn, Collection<Object> parentIds) {
        if (parentIds.isEmpty()) return Flux.empty();
        String sql = "SELECT " + projectionQualified(cols, "t") + ", jt." + joinColumn + " AS \"__batchFk\" FROM " + joinTable + " jt"
            + " JOIN " + table + " t ON t.id = jt." + inverseJoinColumn
            + " WHERE jt." + joinColumn + " = ANY(:vals) ORDER BY t.id";
        return db.sql(sql).bind("vals", toLongArray(parentIds))
            .map(row -> new KeyedRow(row.get("__batchFk"), mapRow(row, cols)))
            .all();
    }

    public Mono<Object> insert(String table, LinkedHashMap<String, Object> columnValues) {
        String columns = String.join(", ", columnValues.keySet());
        String binds = columnValues.entrySet().stream()
            .map(e -> ":" + e.getKey() + castSuffix(e.getValue()))
            .collect(Collectors.joining(", "));
        String sql = "INSERT INTO " + table + " (" + columns + ") VALUES (" + binds + ") RETURNING id";
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql);
        for (var e : columnValues.entrySet()) {
            spec = spec.bind(e.getKey(), unwrap(e.getValue()));
        }
        return spec.map(row -> row.get("id")).one();
    }

    public Mono<Long> update(String table, LinkedHashMap<String, Object> columnValues, Object id) {
        String assignments = columnValues.entrySet().stream()
            .map(e -> e.getKey() + " = :" + e.getKey() + castSuffix(e.getValue()))
            .collect(Collectors.joining(", "));
        String sql = "UPDATE " + table + " SET " + assignments + " WHERE id = :idValue";
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql);
        for (var e : columnValues.entrySet()) {
            spec = spec.bind(e.getKey(), unwrap(e.getValue()));
        }
        return spec.bind("idValue", id).fetch().rowsUpdated();
    }

    /** Returns a Postgres {@code ::type} cast suffix for values wrapped in {@link EnumValue}, otherwise empty. */
    private String castSuffix(Object value) {
        return value instanceof EnumValue ev ? "::" + ev.pgType() : "";
    }

    /** Unwraps an {@link EnumValue} to the raw value that should actually be bound. */
    private Object unwrap(Object value) {
        return value instanceof EnumValue ev ? ev.value() : value;
    }

    public Mono<Long> delete(String table, Object id) {
        return db.sql("DELETE FROM " + table + " WHERE id = :v").bind("v", id).fetch().rowsUpdated();
    }

    /** Deletes every row of {@code table} whose {@code column} equals {@code value}; used to clear join-table rows. */
    public Mono<Long> deleteWhere(String table, String column, Object value) {
        return db.sql("DELETE FROM " + table + " WHERE " + column + " = :v").bind("v", value).fetch().rowsUpdated();
    }

    /** Inserts a single row into a many-to-many join table linking {@code joinValue} to {@code inverseValue}. */
    public Mono<Long> insertJoinRow(String joinTable, String joinColumn, Object joinValue, String inverseJoinColumn, Object inverseValue) {
        String sql = "INSERT INTO " + joinTable + " (" + joinColumn + ", " + inverseJoinColumn + ") VALUES (:a, :b)";
        return db.sql(sql).bind("a", joinValue).bind("b", inverseValue).fetch().rowsUpdated();
    }

    private void appendWhere(StringBuilder sql, List<Filter> filters) {
        if (filters.isEmpty()) return;
        String conditions = IntStream.range(0, filters.size())
            .mapToObj(i -> filters.get(i).column() + " = :f" + i)
            .collect(Collectors.joining(" AND "));
        sql.append(" WHERE ").append(conditions);
    }

    private DatabaseClient.GenericExecuteSpec bindFilters(DatabaseClient.GenericExecuteSpec spec, List<Filter> filters) {
        for (int i = 0; i < filters.size(); i++) {
            spec = spec.bind("f" + i, filters.get(i).value());
        }
        return spec;
    }

    private String projection(List<Col> cols) {
        return cols.stream().map(c -> c.column() + " AS \"" + c.alias() + "\"").collect(Collectors.joining(", "));
    }

    /** Same as {@link #projection} but table-qualifies each column, for queries that join multiple tables. */
    private String projectionQualified(List<Col> cols, String tableAlias) {
        return cols.stream().map(c -> tableAlias + "." + c.column() + " AS \"" + c.alias() + "\"").collect(Collectors.joining(", "));
    }

    private Long[] toLongArray(Collection<Object> values) {
        return values.stream().map(v -> ((Number) v).longValue()).toArray(Long[]::new);
    }

    private Map<String, Object> mapRow(io.r2dbc.spi.Readable row, List<Col> cols) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (Col c : cols) {
            map.put(c.alias(), row.get(c.alias()));
        }
        return map;
    }
}
