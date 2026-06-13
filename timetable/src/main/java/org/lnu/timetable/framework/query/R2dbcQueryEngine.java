package org.lnu.timetable.framework.query;

import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

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

    public Flux<Map<String, Object>> selectViaJoinTable(String table, List<Col> cols, String joinTable,
                                                        String joinColumn, String inverseJoinColumn, Object value) {
        String sql = "SELECT " + projection(cols) + " FROM " + table
            + " WHERE id IN (SELECT " + inverseJoinColumn + " FROM " + joinTable
            + " WHERE " + joinColumn + " = :v) ORDER BY id";
        return db.sql(sql).bind("v", value).map(row -> mapRow(row, cols)).all();
    }

    public Mono<Object> insert(String table, LinkedHashMap<String, Object> columnValues) {
        String columns = String.join(", ", columnValues.keySet());
        String binds = columnValues.keySet().stream().map(c -> ":" + c).collect(Collectors.joining(", "));
        String sql = "INSERT INTO " + table + " (" + columns + ") VALUES (" + binds + ") RETURNING id";
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql);
        for (var e : columnValues.entrySet()) {
            spec = spec.bind(e.getKey(), e.getValue());
        }
        return spec.map(row -> row.get("id")).one();
    }

    public Mono<Long> update(String table, LinkedHashMap<String, Object> columnValues, Object id) {
        String assignments = columnValues.keySet().stream().map(c -> c + " = :" + c).collect(Collectors.joining(", "));
        String sql = "UPDATE " + table + " SET " + assignments + " WHERE id = :idValue";
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql);
        for (var e : columnValues.entrySet()) {
            spec = spec.bind(e.getKey(), e.getValue());
        }
        return spec.bind("idValue", id).fetch().rowsUpdated();
    }

    public Mono<Long> delete(String table, Object id) {
        return db.sql("DELETE FROM " + table + " WHERE id = :v").bind("v", id).fetch().rowsUpdated();
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

    private Map<String, Object> mapRow(io.r2dbc.spi.Readable row, List<Col> cols) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (Col c : cols) {
            map.put(c.alias(), row.get(c.alias()));
        }
        return map;
    }
}
