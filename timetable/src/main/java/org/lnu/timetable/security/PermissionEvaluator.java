package org.lnu.timetable.security;

import com.google.common.base.CaseFormat;
import org.lnu.timetable.framework.metadata.EntityMetadata;
import org.lnu.timetable.framework.metadata.EntityMetadataRegistry;
import org.lnu.timetable.framework.metadata.PermissionJoinParentEdge;
import org.lnu.timetable.framework.metadata.PermissionParentEdge;
import org.lnu.timetable.framework.metadata.PermissionTypeGraph;
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
    private final PermissionTypeGraph typeGraph;
    private final PermissionGraphRepository graphRepo;
    private final PermissionRepository permissionRepo;

    /** The caller's grants, loaded at most once per request. */
    private final Mono<Grants> grants;

    /** Effective level per node, for every node whose full ancestry has already been walked. */
    private final Map<ResourceRef, AccessLevel> resolved = new HashMap<>();

    PermissionEvaluator(Long userId, EntityMetadataRegistry registry, PermissionTypeGraph typeGraph,
                        PermissionGraphRepository graphRepo, PermissionRepository permissionRepo) {
        this.userId = userId;
        this.registry = registry;
        this.typeGraph = typeGraph;
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

    /**
     * Which kinds of thing this caller could create <em>somewhere</em> — the answer behind every
     * «+ Додати» button and every page that exists only to add rows.
     *
     * <p>It is a question about types, not rows, and that is what makes it cheap: no row is named, so
     * nothing is walked and nothing is read beyond the grants already loaded. A grant at
     * {@link AccessLevel#EDIT} or above covers its own type and everything below it
     * ({@link PermissionTypeGraph#coveredBy}), and a type is creatable when one of its foreign-key
     * parents is in that set — the same edge {@link #levelForNew} checks, one level up.
     *
     * <p>It is deliberately an over-approximation: it says a create of this kind is possible
     * somewhere, not that it is possible here. The client uses it to decide whether a button or a
     * whole screen is worth showing; the write itself is still authorized against the row it names.
     * The alternative the client had before was «this account holds some grant», which showed
     * «+ Додати корпус» to a викладач whose grant was one кафедра.
     */
    public Mono<Set<String>> creatableResourceTypes() {
        return grants.map(g -> {
            if (AccessLevel.allows(g.global(), AccessLevel.EDIT)) return typeGraph.allTypes();
            List<String> editable = g.byResource().entrySet().stream()
                .filter(e -> e.getValue().allows(AccessLevel.EDIT))
                .map(e -> e.getKey().resourceType())
                .toList();
            return typeGraph.creatableFrom(editable);
        });
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
            Long parentId = coerceId(input.get(fieldFor(edge.joinColumn())));
            if (parentId != null) {
                parentsByClass.computeIfAbsent(edge.parentEntity(), k -> new LinkedHashSet<>()).add(parentId);
            }
        }
        return levelOverParents(parentsByClass);
    }

    /**
     * The level the caller would have over an <em>existing</em> row once a proposed update has been
     * applied to it — the post-state counterpart of {@link #allows}, which sees only the pre-state.
     *
     * <h2>Why both are needed</h2>
     * Authorizing an update against the row as it stands answers "may this caller touch this row?"
     * and stops there. It does not answer "may the row end up where this update puts it?", and for a
     * cascade in which authority flows down structural edges those are different questions: an
     * update that rewrites a permission-bearing foreign key <em>moves the row to another scope</em>.
     * A кафедра-level методист could take a row out of the кафедра they administer and attach it to
     * one they have no rights over, because the check ran before the move and the move is what the
     * check should have been about. Requiring the level on the pre-state <em>and</em> on the
     * post-state is the same split PostgreSQL row-level security makes between {@code USING} (is the
     * existing row allowed?) and {@code WITH CHECK} (is the resulting row allowed?).
     *
     * <h2>What "post-state" means here</h2>
     * The row's parents after the write: each permission-bearing foreign key takes its value from
     * {@code input} when the field is present (including an explicit null, which clears the edge)
     * and its current value otherwise, and each join-table parent takes the list the mutation
     * reconciles when it manages that join table, or its current membership when it does not. The
     * level over that parent set is then the ordinary any-path maximum, so a write that leaves the
     * row inside at least one scope the caller controls stays permitted. That is deliberate: a
     * timetable entry names a room, and rooms are shared, so scheduling a class into a room one does
     * not administer must not require authority over the room when authority over the workload is
     * already there.
     *
     * @param joinListsByTable post-state membership for the join tables the mutation manages, keyed
     *                         by join-table name; tables absent from the map keep what they have
     */
    public Mono<AccessLevel> levelAfterUpdate(Class<?> entityClass, Long id, Map<String, Object> input,
                                              Map<String, Collection<Long>> joinListsByTable) {
        EntityMetadata md = registry.getMetadata(entityClass);
        if (md == null || id == null) return Mono.empty();

        List<PermissionParentEdge> fkEdges = md.permissionParents();
        List<PermissionJoinParentEdge> joinEdges = md.permissionJoinParents();

        // Foreign-key parents: the columns the update does not mention have to be read, because the
        // row keeps them and they still carry authority.
        List<String> unchanged = fkEdges.stream()
            .filter(e -> !input.containsKey(fieldFor(e.joinColumn())))
            .map(PermissionParentEdge::joinColumn)
            .toList();
        Map<String, Class<?>> parentByColumn = new LinkedHashMap<>();
        for (PermissionParentEdge edge : fkEdges) parentByColumn.put(edge.joinColumn(), edge.parentEntity());

        Mono<Map<Class<?>, Set<Long>>> fromForeignKeys = graphRepo
            .fetchForeignKeys(md.tableName(), md.keyColumn(), unchanged, List.of(id))
            .collectList()
            .defaultIfEmpty(List.of())
            .map(current -> {
                Map<Class<?>, Set<Long>> parents = new LinkedHashMap<>();
                for (PermissionParentEdge edge : fkEdges) {
                    String field = fieldFor(edge.joinColumn());
                    if (input.containsKey(field)) {
                        Long proposed = coerceId(input.get(field));   // null clears the edge
                        if (proposed != null) add(parents, edge.parentEntity(), proposed);
                    }
                }
                for (PermissionGraphRepository.FkEdge fk : current) {
                    Class<?> parentClass = parentByColumn.get(fk.column());
                    if (parentClass != null) add(parents, parentClass, fk.parentId());
                }
                return parents;
            });

        Mono<Map<Class<?>, Set<Long>>> fromJoinTables = Flux.fromIterable(joinEdges)
            .flatMap(edge -> {
                Collection<Long> proposed = joinListsByTable.get(edge.joinTable());
                Flux<Long> ids = proposed != null
                    ? Flux.fromIterable(proposed)
                    : graphRepo.fetchJoinParents(edge.joinTable(), edge.selfColumn(), edge.parentColumn(), List.of(id))
                        .map(PermissionGraphRepository.JoinEdge::parentId);
                Class<?> parentClass = edge.parentEntity();
                return ids.map(parentId -> Map.<Class<?>, Long>entry(parentClass, parentId));
            })
            .collectList()
            .map(entries -> {
                Map<Class<?>, Set<Long>> parents = new LinkedHashMap<>();
                for (Map.Entry<Class<?>, Long> e : entries) add(parents, e.getKey(), e.getValue());
                return parents;
            });

        return Mono.zip(fromForeignKeys, fromJoinTables).flatMap(both -> {
            Map<Class<?>, Set<Long>> parents = new LinkedHashMap<>(both.getT1());
            both.getT2().forEach((k, v) -> parents.computeIfAbsent(k, x -> new LinkedHashSet<>()).addAll(v));
            return levelOverParents(parents);
        });
    }

    /**
     * Does this update touch anything that carries authority? Only a write that rewrites a
     * permission-bearing foreign key, or reconciles a join table that is a permission parent, can
     * move the row between scopes; every other update leaves the post-state parents equal to the
     * pre-state ones, and checking them again would be two extra round trips to reach a conclusion
     * already reached.
     */
    public boolean movesScope(Class<?> entityClass, Map<String, Object> input, Set<String> managedJoinTables) {
        EntityMetadata md = registry.getMetadata(entityClass);
        if (md == null) return false;
        for (PermissionParentEdge edge : md.permissionParents()) {
            if (input.containsKey(fieldFor(edge.joinColumn()))) return true;
        }
        for (PermissionJoinParentEdge edge : md.permissionJoinParents()) {
            if (managedJoinTables.contains(edge.joinTable())) return true;
        }
        return false;
    }

    /**
     * Does the caller hold {@code required} on every authority-bearing scope this write would
     * <em>introduce</em>?
     *
     * <h2>Why the post-state level is not enough</h2>
     * {@link #levelAfterUpdate} asks whether the row still sits somewhere the caller administers,
     * which stops a write that moves a row out of their reach. It does not stop the opposite:
     * pointing an additional authority-bearing edge at a scope the caller does not control while
     * keeping one they do. The row stays covered through the old path, so the any-path rule is
     * satisfied — but the administrators of the new parent have just acquired authority over it,
     * and the caller was in no position to hand it to them. Adding a relationship is a grant of
     * access to somebody else's scope, and it has to be authorized as one.
     *
     * <h2>Why "every", here, and "any" everywhere else</h2>
     * Coverage of an existing row through any one path is the policy and stays the policy. This is
     * a different question — not "may this row be touched?" but "may this row be put here?" — and
     * for it the answer has to hold for each destination separately, since each one confers its own
     * authority. Edges declared {@code authority = false} are exempt, because they confer a path
     * downward without meaning ownership: a shared lecture hall is the example, and requiring
     * authority over it would stop a timetabler scheduling into it.
     *
     * @return true when nothing authority-bearing is introduced, or the caller holds the level on
     *         everything that is
     */
    public Mono<Boolean> allowsIntroducedScopes(Class<?> entityClass, Long id, Map<String, Object> input,
                                                Map<String, Collection<Long>> joinListsByTable,
                                                AccessLevel required) {
        EntityMetadata md = registry.getMetadata(entityClass);
        if (md == null) return Mono.just(true);

        // Foreign keys: only a value the input names, only when it differs from the stored one.
        List<PermissionParentEdge> named = md.permissionParents().stream()
            .filter(e -> e.authority())
            .filter(e -> input.containsKey(fieldFor(e.joinColumn())))
            .toList();
        List<PermissionJoinParentEdge> namedJoins = md.permissionJoinParents().stream()
            .filter(e -> e.authority())
            .filter(e -> joinListsByTable.containsKey(e.joinTable()))
            .toList();
        if (named.isEmpty() && namedJoins.isEmpty()) return Mono.just(true);

        Mono<Map<String, Long>> currentFk = (id == null || named.isEmpty())
            ? Mono.just(Map.of())
            : graphRepo.fetchForeignKeys(md.tableName(), md.keyColumn(),
                    named.stream().map(PermissionParentEdge::joinColumn).toList(), List.of(id))
                .collectMap(PermissionGraphRepository.FkEdge::column,
                    PermissionGraphRepository.FkEdge::parentId)
                .defaultIfEmpty(Map.of());

        Mono<Map<String, Set<Long>>> currentJoins = (id == null || namedJoins.isEmpty())
            ? Mono.just(Map.of())
            : Flux.fromIterable(namedJoins)
                .flatMap(e -> graphRepo
                    .fetchJoinParents(e.joinTable(), e.selfColumn(), e.parentColumn(), List.of(id))
                    .map(j -> Map.entry(e.joinTable(), j.parentId())))
                .collectList()
                .map(entries -> {
                    Map<String, Set<Long>> byTable = new LinkedHashMap<>();
                    for (Map.Entry<String, Long> e : entries) {
                        byTable.computeIfAbsent(e.getKey(), k -> new LinkedHashSet<>()).add(e.getValue());
                    }
                    return byTable;
                });

        return Mono.zip(currentFk, currentJoins).flatMap(now -> {
            Map<Class<?>, Set<Long>> introduced = new LinkedHashMap<>();
            for (PermissionParentEdge e : named) {
                Long proposed = coerceId(input.get(fieldFor(e.joinColumn())));
                if (proposed == null) continue;                       // clearing introduces nothing
                if (proposed.equals(now.getT1().get(e.joinColumn()))) continue;   // unchanged
                add(introduced, e.parentEntity(), proposed);
            }
            for (PermissionJoinParentEdge e : namedJoins) {
                Set<Long> before = now.getT2().getOrDefault(e.joinTable(), Set.of());
                for (Long proposed : joinListsByTable.getOrDefault(e.joinTable(), List.of())) {
                    if (proposed == null || before.contains(proposed)) continue;
                    add(introduced, e.parentEntity(), proposed);
                }
            }
            if (introduced.isEmpty()) return Mono.just(true);
            return Flux.fromIterable(introduced.entrySet())
                .flatMap(entry -> levelsFor(entry.getKey(), entry.getValue())
                    .map(levels -> entry.getValue().stream()
                        .allMatch(pid -> AccessLevel.allows(levels.get(pid), required))))
                .all(ok -> ok);
        });
    }

    /** The highest level the caller holds over any of these parents, or their GLOBAL grant alone. */
    private Mono<AccessLevel> levelOverParents(Map<Class<?>, Set<Long>> parentsByClass) {
        if (parentsByClass.isEmpty()) {
            return grants.flatMap(g -> g.global() == null ? Mono.empty() : Mono.just(g.global()));
        }
        return Flux.fromIterable(parentsByClass.entrySet())
            .flatMap(e -> levelsFor(e.getKey(), e.getValue()))
            .flatMapIterable(Map::values)
            .reduce(AccessLevel::max);
    }

    private static void add(Map<Class<?>, Set<Long>> parents, Class<?> parentClass, Long parentId) {
        parents.computeIfAbsent(parentClass, k -> new LinkedHashSet<>()).add(parentId);
    }

    /** The GraphQL input field that carries a column: {@code faculty_id} is written {@code facultyId}. */
    private static String fieldFor(String column) {
        return CaseFormat.LOWER_UNDERSCORE.to(CaseFormat.LOWER_CAMEL, column);
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

            Flux<Edge> viaForeignKeys = graphRepo.fetchForeignKeys(md.tableName(), md.keyColumn(), columns, ids)
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
