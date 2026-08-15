package org.lnu.timetable.security;

import org.lnu.timetable.framework.metadata.EntityMetadataRegistry;
import org.springframework.stereotype.Service;

/**
 * Central authorization decision point — or rather, the factory for one. The decisions themselves
 * live in {@link PermissionEvaluator}, one instance of which exists per request so that the
 * caller's grants and the ancestry it has already walked can be reused across every field of that
 * request instead of being re-derived for each one.
 *
 * <h2>The model in one paragraph</h2>
 * A grant names a <em>scope</em> — one entity row, or {@code GLOBAL} for the whole university — and
 * an <em>access level</em>: {@link AccessLevel#EDIT} (create and update), {@link AccessLevel#FULL}
 * (also delete), {@link AccessLevel#MANAGE} (also grant and revoke access to this scope and
 * anything under it). The scope cascades downward along the {@code @PermissionParent} /
 * {@code @PermissionJoinParent} edges declared on the domain classes: a grant on a Faculty covers
 * its departments, degree programmes, academic groups, curricula, working curricula, lecturer workloads
 * and timetable entries, while a grant on a single Department covers that department, its lecturers
 * and their workloads and nothing belonging to a sibling department. The level does not weaken on
 * the way down. A caller's effective level on a row is the highest level among all their grants
 * (their own and their groups') that cover it.
 *
 * <h2>Why the walk goes upward</h2>
 * The rule reads downward — "a grant covers its descendants" — but is evaluated upward, from a row
 * to its ancestors, because that is bounded by the depth of the hierarchy (eleven edges at the
 * worst) rather than by the size of the data below a faculty.
 */
@Service
public class PermissionService {

    private final EntityMetadataRegistry registry;
    private final PermissionGraphRepository graphRepo;
    private final PermissionRepository permissionRepo;

    public PermissionService(EntityMetadataRegistry registry, PermissionGraphRepository graphRepo,
                              PermissionRepository permissionRepo) {
        this.registry = registry;
        this.graphRepo = graphRepo;
        this.permissionRepo = permissionRepo;
    }

    /**
     * A fresh evaluator for one caller. Created once per request by
     * {@link AuthenticationGraphQlInterceptor} and read from the GraphQL context thereafter — see
     * {@link AuthorizingDataFetcherProvider#evaluatorOf}. Creating a second one is harmless, just
     * wasteful: it starts with an empty cache.
     */
    public PermissionEvaluator newEvaluator(Long userId) {
        return new PermissionEvaluator(userId, registry, graphRepo, permissionRepo);
    }

    public String resourceTypeOf(Class<?> entityClass) {
        return registry.getMetadata(entityClass).resourceType();
    }
}
