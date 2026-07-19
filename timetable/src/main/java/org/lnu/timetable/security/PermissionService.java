package org.lnu.timetable.security;

import com.google.common.base.CaseFormat;
import org.lnu.timetable.framework.metadata.EntityMetadata;
import org.lnu.timetable.framework.metadata.EntityMetadataRegistry;
import org.lnu.timetable.framework.metadata.PermissionJoinParentEdge;
import org.lnu.timetable.framework.metadata.PermissionParentEdge;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Central authorization decision point. "Modify" permission (covers update, delete, and creating
 * new child rows underneath the covered entity — see class-level docs on
 * {@code org.lnu.timetable.framework.annotation.PermissionParent}) on a resource cascades to every
 * entity reachable by following declared {@code @PermissionParent}/{@code @PermissionJoinParent}
 * edges from that resource downward; equivalently (the direction actually walked here, since it's
 * cheaper to go from a row up to its ancestors than from a grant down to all its descendants),
 * a row is modifiable if the caller holds a grant on that row itself OR on any of its ancestors.
 * <p>
 * A user with a {@code GLOBAL} grant (the "admin permission" from the product spec) bypasses every
 * check below.
 */
@Service
public class PermissionService {

    /** Hard cap on ancestor-chain recursion depth, guarding against accidental annotation cycles. */
    private static final int MAX_DEPTH = 15;

    private final EntityMetadataRegistry registry;
    private final PermissionGraphRepository graphRepo;
    private final PermissionRepository permissionRepo;

    public PermissionService(EntityMetadataRegistry registry, PermissionGraphRepository graphRepo,
                              PermissionRepository permissionRepo) {
        this.registry = registry;
        this.graphRepo = graphRepo;
        this.permissionRepo = permissionRepo;
    }

    public String resourceTypeOf(Class<?> entityClass) {
        return registry.getMetadata(entityClass).resourceType();
    }

    public Mono<Boolean> isAdmin(Long userId) {
        return permissionRepo.groupIdsForUser(userId).collectList()
            .flatMap(groupIds -> permissionRepo.isGlobalAdmin(userId, groupIds));
    }

    /** Can {@code userId} update/delete the existing row {@code entityClass#id}? */
    public Mono<Boolean> canModify(Long userId, Class<?> entityClass, Long id) {
        return isAdmin(userId).flatMap(admin -> admin
            ? Mono.just(true)
            : ancestryOf(entityClass, id, MAX_DEPTH).flatMap(closure -> checkAnyGrant(userId, closure)));
    }

    /** Can {@code userId} create a new {@code entityClass} row given the proposed field values? */
    public Mono<Boolean> canCreate(Long userId, Class<?> entityClass, Map<String, Object> input) {
        return isAdmin(userId).flatMap(admin -> {
            if (admin) return Mono.just(true);
            return candidateParentClosures(entityClass, input)
                .flatMap(candidates -> candidates.isEmpty()
                    ? Mono.just(false)
                    : checkAnyGrant(userId, candidates));
        });
    }

    /**
     * Can {@code userId} currently modify {@code resourceType#resourceId} — i.e. does granting (or
     * revoking) a permission scoped to exactly this resource fall within what they're already
     * allowed to do? This is the rule enforced for permission delegation (see product spec: "if a
     * user has permission to modify an entity, he can grant access to it, or its children, to
     * others") — a user can only extend access to a scope they themselves already hold.
     */
    public Mono<Boolean> canManageGrantsOn(Long userId, String resourceType, Long resourceId) {
        if ("GLOBAL".equals(resourceType)) {
            return isAdmin(userId);
        }
        Class<?> entityClass = registry.getEntityClassByResourceType(resourceType);
        if (entityClass == null) return Mono.just(false);
        return canModify(userId, entityClass, resourceId);
    }

    // --- ancestor graph traversal ---

    private Mono<Set<ResourceRef>> ancestryOf(Class<?> entityClass, Long id, int depthRemaining) {
        EntityMetadata md = registry.getMetadata(entityClass);
        ResourceRef self = new ResourceRef(md.resourceType(), id);
        if (depthRemaining <= 0) {
            return Mono.just(new HashSet<>(Set.of(self)));
        }

        List<String> fkColumns = md.permissionParents().stream().map(PermissionParentEdge::joinColumn).toList();

        Mono<Map<String, Object>> rowMono = fkColumns.isEmpty()
            ? Mono.just(Map.of())
            : graphRepo.fetchForeignKeys(md.tableName(), fkColumns, id);

        Mono<Set<ResourceRef>> viaFk = rowMono.flatMapMany(row -> Flux.fromIterable(md.permissionParents())
                .flatMap(edge -> {
                    Object raw = row.get(edge.joinColumn());
                    if (raw == null) return Mono.<Set<ResourceRef>>just(Set.of());
                    Long parentId = ((Number) raw).longValue();
                    return ancestryOf(edge.parentEntity(), parentId, depthRemaining - 1);
                }))
            .flatMap(Flux::fromIterable)
            .collect(Collectors.toSet());

        Mono<Set<ResourceRef>> viaJoin = Flux.fromIterable(md.permissionJoinParents())
            .flatMap(edge -> graphRepo.fetchJoinParentIds(edge.joinTable(), edge.selfColumn(), edge.parentColumn(), id)
                .flatMap(parentId -> ancestryOf(edge.parentEntity(), parentId, depthRemaining - 1)))
            .flatMap(Flux::fromIterable)
            .collect(Collectors.toSet());

        return Mono.zip(viaFk, viaJoin, (a, b) -> {
            Set<ResourceRef> merged = new HashSet<>(a);
            merged.addAll(b);
            merged.add(self);
            return merged;
        });
    }

    /**
     * For a not-yet-created row: builds the union of ancestor closures reachable from whichever
     * {@code @PermissionParent} foreign keys are present in the proposed {@code input} (join-table
     * ancestors don't apply here — a brand new row can't yet have join-table rows pointing at it).
     * An entity with no applicable parent reference in the input (e.g. a top-level Faculty/Building,
     * or an optional-FK entity created with none of its FKs set) yields an empty set, meaning only
     * an admin may create it.
     */
    private Mono<Set<ResourceRef>> candidateParentClosures(Class<?> entityClass, Map<String, Object> input) {
        EntityMetadata md = registry.getMetadata(entityClass);
        return Flux.fromIterable(md.permissionParents())
            .flatMap(edge -> {
                String fkField = CaseFormat.LOWER_UNDERSCORE.to(CaseFormat.LOWER_CAMEL, edge.joinColumn());
                Object raw = input.get(fkField);
                if (raw == null) return Mono.<Set<ResourceRef>>just(Set.of());
                Long parentId = raw instanceof Number n ? n.longValue() : Long.parseLong(raw.toString());
                return ancestryOf(edge.parentEntity(), parentId, MAX_DEPTH);
            })
            .flatMap(Flux::fromIterable)
            .collect(Collectors.toSet());
    }

    private Mono<Boolean> checkAnyGrant(Long userId, Set<ResourceRef> closure) {
        if (closure.isEmpty()) return Mono.just(false);
        return permissionRepo.groupIdsForUser(userId).collectList()
            .flatMap(groupIds -> permissionRepo.hasAnyGrant(userId, groupIds, closure));
    }
}
