package org.lnu.timetable.framework.runtime;

import com.google.common.base.CaseFormat;
import graphql.schema.DataFetcher;
import graphql.schema.DataFetchingFieldSelectionSet;
import graphql.schema.SelectedField;
import org.dataloader.BatchLoaderEnvironment;
import org.dataloader.DataLoader;
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
import org.lnu.timetable.framework.query.R2dbcQueryEngine.KeyedRow;
import org.lnu.timetable.framework.schema.DataFetcherProvider;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.graphql.execution.BatchLoaderRegistry;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.util.*;

/**
 * Provides optimized data fetchers that translate the GraphQL selection set
 * into SQL queries fetching only the requested columns.
 * <p>
 * Relation fields (to-one, to-many, many-to-many) are resolved through per-request {@link
 * org.dataloader.DataLoader}s registered on {@link BatchLoaderRegistry} (see {@link
 * #registerLoaderIfAbsent}), so that N sibling rows requesting the same relation in one query
 * result in a single batched SQL query instead of N individual ones.
 */
@Component
public class DynamicDataFetchers implements DataFetcherProvider {

    private final EntityMetadataRegistry registry;
    private final R2dbcQueryEngine engine;
    private final BatchLoaderRegistry batchLoaderRegistry;
    private final Set<String> registeredLoaders = Collections.synchronizedSet(new HashSet<>());

    public DynamicDataFetchers(EntityMetadataRegistry registry, R2dbcQueryEngine engine, BatchLoaderRegistry batchLoaderRegistry) {
        this.registry = registry;
        this.engine = engine;
        this.batchLoaderRegistry = batchLoaderRegistry;
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
    public DataFetcher<?> relation(String ownerTypeName, RelationMetadata rel) {
        EntityMetadata targetMd = registry.getMetadata(rel.targetEntity());
        String loaderName = ownerTypeName + "." + rel.fieldName();
        registerLoaderIfAbsent(loaderName, rel, targetMd);

        return env -> {
            Map<String, Object> parent = env.getSource();
            List<Col> cols = resolveCols(targetMd, env.getSelectionSet());
            DataLoader<Object, Object> loader = env.getDataLoader(loaderName);

            if (rel.type() == RelationType.ONE_TO_MANY || rel.type() == RelationType.MANY_TO_MANY) {
                Object parentId = parent.get("id");
                return loader.load(parentId, cols);
            }
            // MANY_TO_ONE / owning ONE_TO_ONE
            Object fk = parent.get(camel(rel.joinColumn()));
            if (fk == null) {
                return Mono.empty().toFuture();
            }
            return loader.load(fk, cols);
        };
    }

    // --- relation batch loading (avoids N+1 queries; see class javadoc) ---

    /**
     * Registers, once per {@code loaderName}, a batch loader that resolves this relation for
     * however many parent rows request it within a single GraphQL execution tick. Safe to call
     * repeatedly (e.g. if the same relation field is somehow wired twice); registration only
     * happens once, and always happens at schema-build time (startup), before any request.
     */
    private void registerLoaderIfAbsent(String loaderName, RelationMetadata rel, EntityMetadata targetMd) {
        if (!registeredLoaders.add(loaderName)) return;

        if (rel.type() == RelationType.ONE_TO_MANY) {
            batchLoaderRegistry.forName(loaderName).registerMappedBatchLoader((Set<Object> keys, BatchLoaderEnvironment env) ->
                engine.selectWhereIn(targetMd.tableName(), colsFromContext(env, targetMd), rel.mappedBy(), keys)
                    .collectList()
                    .map(rows -> groupByKey(keys, rows)));
        } else if (rel.type() == RelationType.MANY_TO_MANY) {
            batchLoaderRegistry.forName(loaderName).registerMappedBatchLoader((Set<Object> keys, BatchLoaderEnvironment env) ->
                engine.selectViaJoinTableBatch(targetMd.tableName(), colsFromContext(env, targetMd),
                        rel.joinTable(), rel.joinColumn(), rel.inverseJoinColumn(), keys)
                    .collectList()
                    .map(rows -> groupByKey(keys, rows)));
        } else {
            // MANY_TO_ONE / owning ONE_TO_ONE
            batchLoaderRegistry.forName(loaderName).registerMappedBatchLoader((Set<Object> keys, BatchLoaderEnvironment env) ->
                engine.selectByIds(targetMd.tableName(), colsFromContext(env, targetMd), keys)
                    .collectList()
                    .map(rows -> {
                        Map<Object, Object> byId = new HashMap<>();
                        for (Map<String, Object> row : rows) {
                            byId.put(row.get("id"), row);
                        }
                        return byId;
                    }));
        }
    }

    /**
     * Groups batched one-to-many / many-to-many rows back per requested key, so every key gets a
     * (possibly empty) list rather than {@code null} when it has no matching rows.
     */
    private Map<Object, Object> groupByKey(Set<Object> keys, List<KeyedRow> rows) {
        Map<Object, Object> grouped = new HashMap<>();
        for (Object key : keys) {
            grouped.put(key, new ArrayList<Map<String, Object>>());
        }
        for (KeyedRow kr : rows) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> list = (List<Map<String, Object>>) grouped.get(kr.key());
            if (list != null) list.add(kr.row());
        }
        return grouped;
    }

    /**
     * Recovers the requested columns from the batch call's key contexts (each key was loaded with
     * the current selection set's columns as its context — see {@link #relation}). Every key in a
     * given batch shares the same context because they all come from the same GraphQL field
     * occurrence (same query AST node) resolved once per sibling row, so any one of them works.
     */
    @SuppressWarnings("unchecked")
    private List<Col> colsFromContext(BatchLoaderEnvironment env, EntityMetadata fallbackMd) {
        for (Object ctx : env.getKeyContexts().values()) {
            if (ctx instanceof List<?> list) return (List<Col>) list;
        }
        List<Col> cols = new ArrayList<>();
        cols.add(new Col("id", "id"));
        for (String field : fallbackMd.selectableColumns()) {
            EntityFieldMetadata fm = fallbackMd.getField(field);
            if (fm != null) cols.add(new Col(fm.columnName(), field));
        }
        return cols;
    }

    // --- mutation handlers ---

    private Mono<Map<String, Object>> createHandler(MutationDefinition def, EntityMetadata md, Map<String, Object> input) {
        LinkedHashMap<String, Object> columnValues = new LinkedHashMap<>();
        Map<String, Object> data = new LinkedHashMap<>();
        bindFields(md, def.getInputFields(), input, columnValues, data);

        return engine.insert(md.tableName(), columnValues)
            .flatMap(id -> {
                data.put("id", id);
                return Mono.when(createNestedLists(def, input, id), createManyToManyLists(def, input, id))
                    .thenReturn(success(data));
            })
            .onErrorResume(e -> Mono.just(error(def, e)));
    }

    private Mono<Map<String, Object>> updateHandler(MutationDefinition def, EntityMetadata md, Object id, Map<String, Object> input) {
        LinkedHashMap<String, Object> columnValues = new LinkedHashMap<>();
        bindFields(md, def.getInputFields(), input, columnValues, null);

        return engine.update(md.tableName(), columnValues, id)
            .flatMap(rows -> rows > 0
                ? Mono.when(reconcileNestedLists(def, input, id), reconcileManyToManyLists(def, input, id)).thenReturn(success(null))
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

    // --- many-to-many id list handling (see MutationDefinition#manyToMany) ---

    /** Inserts one join-table row per id of each declared many-to-many list, for the newly created parent. */
    private Mono<Void> createManyToManyLists(MutationDefinition def, Map<String, Object> input, Object parentId) {
        if (def.getManyToManyLists().isEmpty()) return Mono.empty();

        List<Mono<?>> ops = new ArrayList<>();
        for (MutationDefinition.ManyToManyDefinition mm : def.getManyToManyLists()) {
            for (Object targetId : idList(input, mm.fieldName())) {
                ops.add(engine.insertJoinRow(mm.joinTable(), mm.joinColumn(), parentId, mm.inverseJoinColumn(), targetId));
            }
        }
        return ops.isEmpty() ? Mono.empty() : Mono.when(ops);
    }

    /**
     * Reconciles each declared many-to-many list against the existing join-table rows for
     * {@code parentId}: when the field is present in the input, all of the parent's existing
     * join rows for that relation are deleted and replaced with one row per incoming id. A
     * many-to-many field that's entirely absent from the input leaves the existing rows untouched.
     */
    private Mono<Void> reconcileManyToManyLists(MutationDefinition def, Map<String, Object> input, Object parentId) {
        if (def.getManyToManyLists().isEmpty()) return Mono.empty();

        List<Mono<Void>> ops = new ArrayList<>();
        for (MutationDefinition.ManyToManyDefinition mm : def.getManyToManyLists()) {
            if (!input.containsKey(mm.fieldName())) continue;

            List<Mono<?>> inserts = new ArrayList<>();
            for (Object targetId : idList(input, mm.fieldName())) {
                inserts.add(engine.insertJoinRow(mm.joinTable(), mm.joinColumn(), parentId, mm.inverseJoinColumn(), targetId));
            }
            Mono<Void> op = engine.deleteWhere(mm.joinTable(), mm.joinColumn(), parentId)
                .then(inserts.isEmpty() ? Mono.empty() : Mono.when(inserts));
            ops.add(op);
        }
        return ops.isEmpty() ? Mono.empty() : Mono.when(ops);
    }

    @SuppressWarnings("unchecked")
    private List<Object> idList(Map<String, Object> input, String fieldName) {
        Object raw = input.get(fieldName);
        if (!(raw instanceof List<?> list)) return List.of();
        List<Object> ids = new ArrayList<>(list.size());
        for (Object o : list) {
            ids.add(coerce(o, Long.class));
        }
        return ids;
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
