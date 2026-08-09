package org.lnu.timetable.security;

import com.google.common.base.CaseFormat;
import org.lnu.timetable.framework.metadata.EntityMetadata;
import org.lnu.timetable.framework.metadata.EntityMetadataRegistry;
import org.lnu.timetable.framework.metadata.PermissionJoinParentEdge;
import org.lnu.timetable.framework.metadata.PermissionParentEdge;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * One caller's authorization state for the duration of one GraphQL request.
 *
 * <h2>Why this exists</h2>
 * Authorization here is a graph question — "does this person hold a grant on this row or on
 * anything above it?" — and a single GraphQL request asks it many times: once per mutation, and
 * once per row when a page asks which of the two hundred courses it is showing are editable. The
 * previous implementation answered each of those from scratch: two SQL round trips to learn the
 * caller's groups and grants, then one round trip per node while climbing the hierarchy, with no
 * memory between questions. Two hundred courses in the same faculty meant that faculty was fetched
 * two hundred times.
 *
 * <h2>What it does instead</h2>
 * <ol>
 *   <li><b>Loads the caller's grants once</b> ({@link PermissionRepository#effectiveGrants}) and
 *       keeps them as a {@code ResourceRef -> AccessLevel} map. A person holds a handful of grants;
 *       every subsequent question is answered against that map rather than against SQL.</li>
 *   <li><b>Walks the ancestor graph breadth-first over a whole set of rows at once</b> — one query
 *       per (table, edge) per level, regardless of how many rows are in the set — instead of one
 *       chain of queries per row.</li>
 *   <li><b>Remembers what it resolved.</b> Once a node's effective level is known it is never
 *       recomputed, and never re-expanded, for the rest of the request. The second question about
 *       the same faculty costs nothing.</li>
 *   <li><b>Tracks visited nodes rather than trusting a depth counter</b>, so
 *       {@code Course.parent_course_id} (an entity that is its own ancestor type) cannot loop, and
 *       a legitimately deep chain is not silently truncated into a denial.</li>
 * </ol>
 *
 * <h2>The rule it implements</h2>
 * A caller's <em>effective level</em> on a row is the highest level among: their grants on that row,
 * their grants on any ancestor of it, and their university-wide ({@code GLOBAL}) grant. Levels do
 * not weaken on the way down — EDIT on a факультет is EDIT on everything under it. Each operation
 * then names the level it needs: update needs {@link AccessLevel#EDIT}, delete needs
 * {@link AccessLevel#FULL}, delegation needs {@link AccessLevel#MANAGE}.
 * <p>
 * Instances are per-request and not thread-safe by design; one is created by
 * {@link AuthenticationGraphQlInterceptor} and placed in the GraphQL context.
 */
public class PermissionEvaluator {

    /**
     * Backstop against an annotation cycle that the visited-set somehow fails to close. The deepest
     * real chain in the domain model is 11 edges (Building → … → LecturerWorkloadCandidateConstraint),
     * so this is headroom, not a limit anyone can reach by legitimately nesting data.
     */
    private static final int MAX_DEPTH = 32;

    private final Long userId;
    private final EntityMetadataRegistry registry;
    private final PermissionGraphRepository graphRepo;
    private final PermissionRepository permissionRepo;

    /** The caller's grants, loaded at most once per request. */
    private final Mono<Grants> grants;

    /** Effective level per node, for every node whose full ancestry has already been walked. */
    private final Map<ResourceRef, AccessLevel> resolved = new HashMap<>();

    PermissionEvaluator(Long userId, EntityMetadataRegistry registry, PermissionGraphRepository graphRepo,
                        PermissionRepository permissionRepo) {
        this.userId = userId;
        this.registry = registry;
        this.graphRepo = graphRepo;
        this.permissionRepo = permissionRepo;
        this.grants = loadGrants().cache();
    }

    public Long userId() {
        return userId;
    }

    /** The caller's direct grants, keyed by the resource each names. */
    public record Grants(Map<ResourceRef, AccessLevel> byResource, AccessLevel global) {}

    private Mono<Grants> loadGrants() {
        return permissionRepo.groupIdsForUser(userId).collectList()
            .flatMapMany(groupIds -> permissionRepo.effectiveGrants(userId, groupIds))
            .collectList()
            .map(rows -> {
                Map<ResourceRef, AccessLevel> byResource = new HashMap<>();
                AccessLevel global = null;
                for (PermissionRepository.PermissionRow row : rows) {
                    ResourceRef ref = ResourceRef.of(row.resourceType(), row.resourceId());
                    if (ref.isGlobal()) {
                        global = AccessLevel.max(global, row.level());
                    } else {
                        byResource.merge(ref, row.level(), AccessLevel::max);
                    }
                }
                return new Grants(byResource, global);
            });
    }

    // --- the questions callers actually ask ---

    /** The caller's university-wide level, or null if they hold no {@code GLOBAL} grant. */
    public Mono<AccessLevel> globalLevel() {
        return grants.flatMap(g -> g.global() == null ? Mono.empty() : Mono.just(g.global()));
    }

    /**
     * Whether the caller is an administrator — {@code GLOBAL} at {@link AccessLevel#MANAGE}. This is
     * the one grant that opens user and group administration, and it is deliberately the same
     * mechanism as every other grant rather than a separate {@code users.is_admin} flag.
     */
    public Mono<Boolean> isAdmin() {
        return grants.map(g -> AccessLevel.allows(g.global(), AccessLevel.MANAGE));
    }

    /**
     * Whether the caller can delegate access <em>anywhere</em> — the gate on the shared grantee
     * picker and on the «Доступ» panels. Asked without naming a resource, because the client needs
     * to know whether to render the panel at all before it knows which resource it is about.
     */
    public Mono<Boolean> canDelegateSomewhere() {
        return grants.map(g -> AccessLevel.allows(g.global(), AccessLevel.MANAGE)
            || g.byResource().values().stream().anyMatch(level -> level.allows(AccessLevel.MANAGE)));
    }

    /** The caller's effective level on one row, or null if they have no access to it at all. */
    public Mono<AccessLevel> levelFor(Class<?> entityClass, Long id) {
        if (id == null) return Mono.empty();
        return levelsFor(entityClass, List.of(id)).flatMap(levels -> {
            AccessLevel level = levels.get(id);
            return level == null ? Mono.empty() : Mono.just(level);
        });
    }

    /** Does the caller hold at least {@code required} on this row? */
    public Mono<Boolean> allows(Class<?> entityClass, Long id, AccessLevel required) {
        if (id == null) return Mono.just(false);
        return levelsFor(entityClass, List.of(id))
            .map(levels -> AccessLevel.allows(levels.get(id), required));
    }

    /**
     * Effective level for many rows of one entity type, resolved together. This is what makes a
     * table of two hundred rows cost a handful of queries: they share almost all of their ancestry,
     * and it is walked once.
     *
     * @return a map containing only the ids the caller has some access to
     */
    public Mono<Map<Long, AccessLevel>> levelsFor(Class<?> entityClass, Collection<Long> ids) {
        if (ids.isEmpty()) return Mono.just(Map.of());
        EntityMetadata md = registry.getMetadata(entityClass);
        if (md == null) return Mono.just(Map.of());
        return grants.flatMap(g -> resolveGraph(entityClass, ids).map(levels -> {
            Map<Long, AccessLevel> result = new LinkedHashMap<>();
            for (Long id : ids) {
                AccessLevel level = AccessLevel.max(levels.get(new ResourceRef(md.resourceType(), id)), g.global());
                if (level != null) result.put(id, level);
            }
            return result;
        }));
    }

    /**
     * Effective level for a resource named the way a grant names it — by {@code resource_type}
     * string rather than by class. {@code GLOBAL} resolves to the caller's university-wide level.
     */
    public Mono<AccessLevel> levelForResource(String resourceType, Long resourceId) {
        if (ResourceRef.GLOBAL_TYPE.equals(resourceType)) {
            return grants.flatMap(g -> g.global() == null ? Mono.empty() : Mono.just(g.global()));
        }
        Class<?> entityClass = registry.getEntityClassByResourceType(resourceType);
        if (entityClass == null || resourceId == null) return Mono.empty();
        return levelFor(entityClass, resourceId);
    }

    /**
     * The level the caller would have over a row that does not exist yet, given the field values it
     * is being created with: the highest level they hold over any of the parents the new row is
     * being attached to. Join-table ancestors cannot apply — nothing points at the row yet — so an
     * entity created with none of its optional parent references set has no covering scope, and only
     * a {@code GLOBAL} grant can create it. That is intentional: a Room belonging to no building and
     * no faculty is a university-wide object.
     */
    public Mono<AccessLevel> levelForNew(Class<?> entityClass, Map<String, Object> input) {
        EntityMetadata md = registry.getMetadata(entityClass);
        if (md == null) return Mono.empty();

        Map<Class<?>, Set<Long>> parentsByClass = new LinkedHashMap<>();
        for (PermissionParentEdge edge : md.permissionParents()) {
            String field = CaseFormat.LOWER_UNDERSCORE.to(CaseFormat.LOWER_CAMEL, edge.joinColumn());
            Long parentId = coerceId(input.get(field));
            if (parentId != null) {
                parentsByClass.computeIfAbsent(edge.parentEntity(), k -> new LinkedHashSet<>()).add(parentId);
            }
        }
        if (parentsByClass.isEmpty()) {
            return grants.flatMap(g -> g.global() == null ? Mono.empty() : Mono.just(g.global()));
        }
        return Flux.fromIterable(parentsByClass.entrySet())
            .flatMap(e -> levelsFor(e.getKey(), e.getValue()))
            .flatMapIterable(Map::values)
            .reduce(AccessLevel::max);
    }

    /**
     * Every node a grant could sit on and still cover {@code resourceType#resourceId} — the row
     * itself, all of its ancestors, and {@link ResourceRef#GLOBAL}. Used by the administration UI to
     * show <em>effective</em> access (including access inherited from a факультет) rather than only
     * the grants that happen to be attached to this exact row.
     */
    public Mono<Set<ResourceRef>> coveringRefs(String resourceType, Long resourceId) {
        Set<ResourceRef> refs = new LinkedHashSet<>();
        refs.add(ResourceRef.GLOBAL);
        if (ResourceRef.GLOBAL_TYPE.equals(resourceType) || resourceId == null) {
            return Mono.just(refs);
        }
        Class<?> entityClass = registry.getEntityClassByResourceType(resourceType);
        if (entityClass == null) return Mono.just(refs);
        return buildGraph(entityClass, List.of(resourceId))
            .map(graph -> {
                refs.addAll(graph.nodes());
                return refs;
            });
    }

    /**
     * Is {@code candidate} a strict ancestor of {@code resource} — that is, does the caller's
     * authority over {@code resource} come from somewhere genuinely above it? This is what separates
     * "may revoke a peer's grant" from "may revoke the grant that sits alongside my own", and it is
     * why the head of one кафедра cannot quietly unseat the head of the same кафедра while the
     * деканат above them can.
     */
    public Mono<Boolean> holdsManageAbove(String resourceType, Long resourceId) {
        return grants.flatMap(g -> {
            if (AccessLevel.allows(g.global(), AccessLevel.MANAGE)) return Mono.just(true);
            if (ResourceRef.GLOBAL_TYPE.equals(resourceType) || resourceId == null) return Mono.just(false);
            Class<?> entityClass = registry.getEntityClassByResourceType(resourceType);
            if (entityClass == null) return Mono.just(false);
            ResourceRef self = new ResourceRef(resourceType, resourceId);
            return buildGraph(entityClass, List.of(resourceId)).map(graph -> graph.nodes().stream()
                .anyMatch(ref -> !ref.equals(self)
                    && AccessLevel.allows(g.byResource().get(ref), AccessLevel.MANAGE)));
        });
    }

    // --- graph machinery ---

    /** The walked ancestor graph: every node reached, and each node's direct parents. */
    private record Graph(Set<ResourceRef> nodes, Map<ResourceRef, Set<ResourceRef>> parents, boolean complete) {}

    private record Edge(ResourceRef child, Class<?> parentClass, Long parentId) {}

    /**
     * Walks the ancestry of {@code ids} and folds the caller's grants down it, returning the
     * effective level of every node reached. Nodes whose ancestry was fully walked are memoised for
     * the rest of the request.
     */
    private Mono<Map<ResourceRef, AccessLevel>> resolveGraph(Class<?> entityClass, Collection<Long> ids) {
        return grants.flatMap(g -> buildGraph(entityClass, ids).map(graph -> {
            Map<ResourceRef, AccessLevel> levels = new HashMap<>();
            for (ResourceRef node : graph.nodes()) {
                AccessLevel seed = resolved.containsKey(node) ? resolved.get(node) : g.byResource().get(node);
                if (seed != null) levels.put(node, seed);
            }
            // Propagate levels downward to a fixpoint. The edge set is small (hundreds of nodes at
            // most) and this converges in at most `depth` passes; doing it as a fixpoint rather than
            // in topological order is what makes a self-referential edge — an ELECTIVE course whose
            // parent is an ELECTIVE_GROUP course — harmless rather than a special case.
            boolean changed = true;
            while (changed) {
                changed = false;
                for (Map.Entry<ResourceRef, Set<ResourceRef>> entry : graph.parents().entrySet()) {
                    AccessLevel best = levels.get(entry.getKey());
                    for (ResourceRef parent : entry.getValue()) {
                        best = AccessLevel.max(best, levels.get(parent));
                    }
                    if (best != null && best != levels.get(entry.getKey())) {
                        levels.put(entry.getKey(), best);
                        changed = true;
                    }
                }
            }
            if (graph.complete()) {
                for (ResourceRef node : graph.nodes()) {
                    resolved.put(node, levels.get(node));
                }
            }
            return levels;
        }));
    }

    private Mono<Graph> buildGraph(Class<?> entityClass, Collection<Long> ids) {
        EntityMetadata md = registry.getMetadata(entityClass);
        Set<ResourceRef> nodes = new LinkedHashSet<>();
        Map<ResourceRef, Set<ResourceRef>> parents = new LinkedHashMap<>();
        Map<Class<?>, Set<Long>> frontier = new LinkedHashMap<>();
        Set<Long> start = new LinkedHashSet<>();
        for (Long id : ids) {
            if (id == null) continue;
            ResourceRef ref = new ResourceRef(md.resourceType(), id);
            nodes.add(ref);
            // A node already resolved earlier in this request needs no re-expansion: its level is
            // known, and its ancestors can only tell us the same thing again.
            if (!resolved.containsKey(ref)) start.add(id);
        }
        if (!start.isEmpty()) frontier.put(entityClass, start);
        return expand(new Graph(nodes, parents, true), frontier, MAX_DEPTH);
    }

    private Mono<Graph> expand(Graph graph, Map<Class<?>, Set<Long>> frontier, int depthRemaining) {
        if (frontier.isEmpty()) return Mono.just(graph);
        if (depthRemaining <= 0) {
            return Mono.just(new Graph(graph.nodes(), graph.parents(), false));
        }
        return edgesFrom(frontier).collectList().flatMap(edges -> {
            Map<Class<?>, Set<Long>> next = new LinkedHashMap<>();
            for (Edge edge : edges) {
                EntityMetadata parentMd = registry.getMetadata(edge.parentClass());
                if (parentMd == null) continue;
                ResourceRef parentRef = new ResourceRef(parentMd.resourceType(), edge.parentId());
                graph.parents().computeIfAbsent(edge.child(), k -> new HashSet<>()).add(parentRef);
                if (graph.nodes().add(parentRef) && !resolved.containsKey(parentRef)) {
                    next.computeIfAbsent(edge.parentClass(), k -> new LinkedHashSet<>()).add(edge.parentId());
                }
            }
            return expand(graph, next, depthRemaining - 1);
        });
    }

    /** One breadth-first level: at most one statement per (table, FK group) and per join edge. */
    private Flux<Edge> edgesFrom(Map<Class<?>, Set<Long>> frontier) {
        return Flux.fromIterable(frontier.entrySet()).flatMap(entry -> {
            Class<?> entityClass = entry.getKey();
            Set<Long> ids = entry.getValue();
            EntityMetadata md = registry.getMetadata(entityClass);
            if (md == null) return Flux.<Edge>empty();

            Map<String, Class<?>> parentByColumn = new LinkedHashMap<>();
            for (PermissionParentEdge edge : md.permissionParents()) {
                parentByColumn.put(edge.joinColumn(), edge.parentEntity());
            }
            List<String> columns = new ArrayList<>(parentByColumn.keySet());

            Flux<Edge> viaForeignKeys = graphRepo.fetchForeignKeys(md.tableName(), columns, ids)
                .map(fk -> new Edge(new ResourceRef(md.resourceType(), fk.childId()),
                    parentByColumn.get(fk.column()), fk.parentId()));

            Flux<Edge> viaJoinTables = Flux.fromIterable(md.permissionJoinParents())
                .flatMap((PermissionJoinParentEdge edge) ->
                    graphRepo.fetchJoinParents(edge.joinTable(), edge.selfColumn(), edge.parentColumn(), ids)
                        .map(join -> new Edge(new ResourceRef(md.resourceType(), join.childId()),
                            edge.parentEntity(), join.parentId())));

            return Flux.merge(viaForeignKeys, viaJoinTables);
        });
    }

    private static Long coerceId(Object raw) {
        if (raw == null) return null;
        if (raw instanceof Number n) return n.longValue();
        String text = raw.toString().trim();
        if (text.isEmpty()) return null;
        try {
            return Long.parseLong(text);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
