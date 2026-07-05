package org.lnu.timetable.framework.runtime;

import com.google.common.base.CaseFormat;
import graphql.schema.DataFetcher;
import graphql.schema.DataFetchingFieldSelectionSet;
import graphql.schema.SelectedField;
import org.lnu.timetable.framework.config.MutationDefinition;
import org.lnu.timetable.framework.config.QueryDefinition;
import org.lnu.timetable.framework.metadata.EntityFieldMetadata;
import org.lnu.timetable.framework.metadata.EntityMetadata;
import org.lnu.timetable.framework.metadata.EntityMetadataRegistry;
import org.lnu.timetable.framework.metadata.RelationMetadata;
import org.lnu.timetable.framework.metadata.RelationType;
import org.lnu.timetable.framework.query.R2dbcQueryEngine;
import org.lnu.timetable.framework.query.R2dbcQueryEngine.Col;
import org.lnu.timetable.framework.query.R2dbcQueryEngine.EnumValue;
import org.lnu.timetable.framework.schema.DataFetcherProvider;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.util.*;

/**
 * Provides optimized data fetchers that translate the GraphQL selection set
 * into SQL queries fetching only the requested columns.
 */
@Component
public class DynamicDataFetchers implements DataFetcherProvider {

    private final EntityMetadataRegistry registry;
    private final R2dbcQueryEngine engine;

    public DynamicDataFetchers(EntityMetadataRegistry registry, R2dbcQueryEngine engine) {
        this.registry = registry;
        this.engine = engine;
    }

    @Override
    public DataFetcher<?> namespace() {
        return env -> new Object();
    }

    @Override
    public DataFetcher<?> query(QueryDefinition def) {
        EntityMetadata md = registry.getMetadata(def.getEntityClass());
        return env -> {
            Object id = coerce(env.getArgument("id"), Long.class);
            List<Col> cols = resolveCols(md, env.getSelectionSet());
            return engine.selectOne(md.tableName(), cols, "id", id).toFuture();
        };
    }

    @Override
    public DataFetcher<?> connection(QueryDefinition def) {
        EntityMetadata md = registry.getMetadata(def.getEntityClass());
        return env -> {
            int limit = ((Number) env.getArgument("limit")).intValue();
            long offset = ((Number) env.getArgument("offset")).longValue();

            List<R2dbcQueryEngine.Filter> filters = new ArrayList<>();
            for (QueryDefinition.FilterParam fp : def.getFilters()) {
                Object val = env.getArgument(fp.paramName());
                if (val != null) {
                    filters.add(new R2dbcQueryEngine.Filter(fp.column(), coerce(val, Long.class)));
                }
            }

            SelectedField nodesField = immediate(env.getSelectionSet(), "nodes");
            boolean pageInfoSelected = immediate(env.getSelectionSet(), "pageInfo") != null;

            if (nodesField == null) {
                return engine.countWhere(md.tableName(), filters)
                    .map(total -> connection(null, pageInfo(total, limit + offset)))
                    .toFuture();
            }

            List<Col> cols = resolveCols(md, nodesField.getSelectionSet());
            return engine.selectList(md.tableName(), cols, columnOf(md, def.getOrderBy()), limit, offset, filters)
                .collectList()
                .flatMap(nodes -> {
                    if (!pageInfoSelected) {
                        return Mono.just(connection(nodes, null));
                    }
                    if (nodes.size() < limit) {
                        return Mono.just(connection(nodes, pageInfo(offset + nodes.size(), -1)));
                    }
                    return engine.countWhere(md.tableName(), filters)
                        .map(total -> connection(nodes, pageInfo(total, limit + offset)));
                })
                .toFuture();
        };
    }

    @Override
    public DataFetcher<?> mutation(MutationDefinition def) {
        EntityMetadata md = registry.getMetadata(def.getEntityClass());
        String argName = CaseFormat.UPPER_CAMEL.to(CaseFormat.LOWER_CAMEL, def.getEntityClass().getSimpleName());
        return switch (def.getMutationType()) {
            case CREATE -> env -> createHandler(def, md, env.getArgument(argName)).toFuture();
            case UPDATE -> env -> updateHandler(def, md, coerce(env.getArgument("id"), Long.class),
                env.getArgument(argName)).toFuture();
            case DELETE -> env -> deleteHandler(def, md, coerce(env.getArgument("id"), Long.class)).toFuture();
        };
    }

    @Override
    public DataFetcher<?> relation(RelationMetadata rel) {
        EntityMetadata targetMd = registry.getMetadata(rel.targetEntity());
        return env -> {
            Map<String, Object> parent = env.getSource();
            List<Col> cols = resolveCols(targetMd, env.getSelectionSet());

            if (rel.type() == RelationType.ONE_TO_MANY) {
                Object parentId = parent.get("id");
                return engine.selectWhere(targetMd.tableName(), cols, rel.mappedBy(), parentId, "id")
                    .collectList().toFuture();
            }
            if (rel.type() == RelationType.MANY_TO_MANY) {
                Object parentId = parent.get("id");
                return engine.selectViaJoinTable(targetMd.tableName(), cols, rel.joinTable(),
                        rel.joinColumn(), rel.inverseJoinColumn(), parentId)
                    .collectList().toFuture();
            }
            // MANY_TO_ONE / owning ONE_TO_ONE
            Object fk = parent.get(camel(rel.joinColumn()));
            if (fk == null) {
                return Mono.empty().toFuture();
            }
            return engine.selectOne(targetMd.tableName(), cols, "id", fk).toFuture();
        };
    }

    // --- mutation handlers ---

    private Mono<Map<String, Object>> createHandler(MutationDefinition def, EntityMetadata md, Map<String, Object> input) {
        LinkedHashMap<String, Object> columnValues = new LinkedHashMap<>();
        Map<String, Object> data = new LinkedHashMap<>();
        bindFields(md, def.getInputFields(), input, columnValues, data);

        return engine.insert(md.tableName(), columnValues)
            .flatMap(id -> {
                data.put("id", id);
                return createNestedLists(def, input, id).thenReturn(success(data));
            })
            .onErrorResume(e -> Mono.just(error(def, e)));
    }

    private Mono<Map<String, Object>> updateHandler(MutationDefinition def, EntityMetadata md, Object id, Map<String, Object> input) {
        LinkedHashMap<String, Object> columnValues = new LinkedHashMap<>();
        bindFields(md, def.getInputFields(), input, columnValues, null);

        return engine.update(md.tableName(), columnValues, id)
            .flatMap(rows -> rows > 0
                ? reconcileNestedLists(def, input, id).thenReturn(success(null))
                : Mono.just(error(def, notFoundStatus(def, md))))
            .onErrorResume(e -> Mono.just(error(def, e)));
    }

    private Mono<Map<String, Object>> deleteHandler(MutationDefinition def, EntityMetadata md, Object id) {
        return engine.delete(md.tableName(), id)
            .map(rows -> rows > 0 ? success(null) : error(def, notFoundStatus(def, md)))
            .onErrorResume(e -> Mono.just(error(def, e)));
    }

    private void bindFields(EntityMetadata md, List<String> fieldNames, Map<String, Object> input,
                            LinkedHashMap<String, Object> columnValues, Map<String, Object> data) {
        for (String field : fieldNames) {
            Object value = input.get(field);
            if (value == null) continue;
            EntityFieldMetadata fm = md.getField(field);
            String column = fm != null ? fm.columnName() : snake(field);
            Class<?> type = fm != null ? fm.type() : Long.class;
            Object coerced = coerce(value, type);
            Object bound = (fm != null && fm.pgEnumType() != null)
                ? new EnumValue(coerced, fm.pgEnumType())
                : coerced;
            columnValues.put(column, bound);
            if (data != null) data.put(field, coerced);
        }
    }

    // --- nested one-to-many list handling (see MutationDefinition#nestedList) ---

    /** Inserts every item of each declared nested list, pointing its FK at the newly created parent. */
    private Mono<Void> createNestedLists(MutationDefinition def, Map<String, Object> input, Object parentId) {
        if (def.getNestedLists().isEmpty()) return Mono.empty();

        List<Mono<?>> ops = new ArrayList<>();
        for (MutationDefinition.NestedListDefinition nl : def.getNestedLists()) {
            List<Map<String, Object>> items = nestedItems(input, nl);
            EntityMetadata childMd = registry.getMetadata(nl.childEntityClass());
            String fkColumn = fkColumn(childMd, nl.fkField());

            for (Map<String, Object> item : items) {
                LinkedHashMap<String, Object> childCols = new LinkedHashMap<>();
                bindFields(childMd, nl.childInputFields(), item, childCols, null);
                childCols.put(fkColumn, parentId);
                ops.add(engine.insert(childMd.tableName(), childCols));
            }
        }
        return ops.isEmpty() ? Mono.empty() : Mono.when(ops);
    }

    /**
     * Reconciles each declared nested list against the existing child rows for {@code parentId}:
     * items whose {@code id} matches an existing row update it, items with no matching {@code id}
     * are inserted, and existing rows not referenced by any item are deleted. A nested list field
     * that's entirely absent from the input leaves that list's rows untouched.
     */
    private Mono<Void> reconcileNestedLists(MutationDefinition def, Map<String, Object> input, Object parentId) {
        if (def.getNestedLists().isEmpty()) return Mono.empty();

        List<Mono<Void>> ops = new ArrayList<>();
        for (MutationDefinition.NestedListDefinition nl : def.getNestedLists()) {
            if (!input.containsKey(nl.fieldName())) continue;
            ops.add(reconcileNestedList(nl, nestedItems(input, nl), parentId));
        }
        return ops.isEmpty() ? Mono.empty() : Mono.when(ops);
    }

    private Mono<Void> reconcileNestedList(MutationDefinition.NestedListDefinition nl, List<Map<String, Object>> items, Object parentId) {
        EntityMetadata childMd = registry.getMetadata(nl.childEntityClass());
        String fkColumn = fkColumn(childMd, nl.fkField());

        return engine.selectWhere(childMd.tableName(), List.of(new Col("id", "id")), fkColumn, parentId, null)
            .map(row -> (Object) row.get("id"))
            .collectList()
            .flatMap(existingIds -> {
                Set<Object> toDelete = new LinkedHashSet<>(existingIds);
                List<Mono<?>> ops = new ArrayList<>();

                for (Map<String, Object> item : items) {
                    Object rawId = item.get("id");
                    Object itemId = rawId != null ? coerce(rawId, Long.class) : null;

                    LinkedHashMap<String, Object> childCols = new LinkedHashMap<>();
                    bindFields(childMd, nl.childInputFields(), item, childCols, null);

                    if (itemId != null && toDelete.remove(itemId)) {
                        ops.add(engine.update(childMd.tableName(), childCols, itemId));
                    } else {
                        childCols.put(fkColumn, parentId);
                        ops.add(engine.insert(childMd.tableName(), childCols));
                    }
                }
                for (Object staleId : toDelete) {
                    ops.add(engine.delete(childMd.tableName(), staleId));
                }
                return ops.isEmpty() ? Mono.empty() : Mono.when(ops);
            });
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> nestedItems(Map<String, Object> input, MutationDefinition.NestedListDefinition nl) {
        Object raw = input.get(nl.fieldName());
        if (!(raw instanceof List<?> list)) return List.of();
        List<Map<String, Object>> items = new ArrayList<>(list.size());
        for (Object o : list) {
            items.add((Map<String, Object>) o);
        }
        return items;
    }

    private String fkColumn(EntityMetadata childMd, String fkField) {
        EntityFieldMetadata fm = childMd.getField(fkField);
        return fm != null ? fm.columnName() : snake(fkField);
    }

    // --- response helpers ---

    private Map<String, Object> success(Map<String, Object> data) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("isSuccess", true);
        if (data != null) response.put("data", data);
        return response;
    }

    private Map<String, Object> error(MutationDefinition def, Throwable e) {
        String status;
        if (e instanceof DuplicateKeyException) {
            status = statusContaining(def, "DUPLICAT");
        } else if (e instanceof DataIntegrityViolationException) {
            status = statusContaining(def, "NOT_FOUND");
        } else {
            status = null;
        }
        return error(def, status != null ? status : statusContaining(def, "INTERNAL_SERVER_ERROR"));
    }

    private Map<String, Object> error(MutationDefinition def, String status) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("isSuccess", false);
        response.put("errorStatus", status);
        return response;
    }

    private String notFoundStatus(MutationDefinition def, EntityMetadata md) {
        String entity = md.entityClass().getSimpleName().toUpperCase();
        return statusContaining(def, entity + "_NOT_FOUND");
    }

    private String statusContaining(MutationDefinition def, String token) {
        return def.getErrorStatuses().stream()
            .map(MutationDefinition.ErrorStatus::name)
            .filter(name -> name.contains(token))
            .findFirst().orElse(null);
    }

    // --- connection helpers ---

    private Map<String, Object> connection(List<Map<String, Object>> nodes, Map<String, Object> pageInfo) {
        Map<String, Object> connection = new LinkedHashMap<>();
        if (nodes != null) connection.put("nodes", nodes);
        if (pageInfo != null) connection.put("pageInfo", pageInfo);
        return connection;
    }

    private Map<String, Object> pageInfo(long total, long nextPageOffset) {
        Map<String, Object> pageInfo = new LinkedHashMap<>();
        pageInfo.put("total", total);
        boolean hasNextPage = nextPageOffset >= 0 && nextPageOffset < total;
        pageInfo.put("hasNextPage", hasNextPage);
        pageInfo.put("nextPageOffset", hasNextPage ? nextPageOffset : null);
        return pageInfo;
    }

    // --- selection / column resolution ---

    private List<Col> resolveCols(EntityMetadata md, DataFetchingFieldSelectionSet selectionSet) {
        Map<String, Col> byAlias = new LinkedHashMap<>();
        byAlias.put("id", new Col("id", "id"));

        for (SelectedField field : selectionSet.getImmediateFields()) {
            String name = field.getName();
            EntityFieldMetadata fm = md.getField(name);
            if (fm != null) {
                byAlias.put(name, new Col(fm.columnName(), name));
                continue;
            }
            RelationMetadata rel = md.getRelation(name);
            if (rel != null && (rel.type() == RelationType.MANY_TO_ONE || rel.type() == RelationType.ONE_TO_ONE)
                && rel.joinColumn() != null) {
                String alias = camel(rel.joinColumn());
                byAlias.put(alias, new Col(rel.joinColumn(), alias));
            }
        }
        return new ArrayList<>(byAlias.values());
    }

    private SelectedField immediate(DataFetchingFieldSelectionSet selectionSet, String name) {
        return selectionSet.getImmediateFields().stream()
            .filter(f -> f.getName().equals(name)).findFirst().orElse(null);
    }

    private String columnOf(EntityMetadata md, String field) {
        EntityFieldMetadata fm = md.getField(field);
        return fm != null ? fm.columnName() : field;
    }

    // --- conversion utils ---

    private Object coerce(Object value, Class<?> type) {
        if (value == null) return null;
        if (type == Long.class || type == long.class) return value instanceof Number n ? n.longValue() : Long.valueOf(value.toString());
        if (type == Integer.class || type == int.class) return value instanceof Number n ? n.intValue() : Integer.valueOf(value.toString());
        if (type == Boolean.class || type == boolean.class) return value instanceof Boolean b ? b : Boolean.valueOf(value.toString());
        if (type == Double.class || type == double.class) return value instanceof Number n ? n.doubleValue() : Double.valueOf(value.toString());
        return value.toString();
    }

    private String camel(String column) {
        return CaseFormat.LOWER_UNDERSCORE.to(CaseFormat.LOWER_CAMEL, column);
    }

    private String snake(String field) {
        return CaseFormat.LOWER_CAMEL.to(CaseFormat.LOWER_UNDERSCORE, field);
    }
}
