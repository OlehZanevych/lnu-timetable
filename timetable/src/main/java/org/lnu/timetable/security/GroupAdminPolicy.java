package org.lnu.timetable.security;

import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * The one rule for «who may administer this group» — its membership and its invitation links.
 *
 * <p>Groups are how access travels here: a grant may name a group, and «Деканат ФПМіІ» holds MANAGE
 * on its факультет, so adding an account to a group is granting it everything that group can reach.
 * Membership management was therefore administrator-only, which was the safe answer and not the
 * right one — it made an administrator the bottleneck for the one act a деканат performs most
 * often, and the same bottleneck the delegation model (`grantPermission`) exists to remove.
 *
 * <p>The rule this states instead is delegation's own, applied to membership: <strong>you may hand
 * out only what you hold.</strong> An administrator ({@code GLOBAL} at {@code MANAGE}) may
 * administer any group. Anybody else may administer a group exactly when they hold {@code MANAGE}
 * over <em>every</em> resource that group holds a grant on.
 *
 * <p>Both halves of that are load-bearing:
 *
 * <ul>
 *   <li><strong>Every, not any.</strong> A group granted both {@code FACULTY} #1 and
 *       {@code DEPARTMENT} #7 is worth both. Letting the head of that one кафедра add members would
 *       hand out faculty-wide access they do not hold, through the side door of membership.</li>
 *   <li><strong>A group with no grants at all belongs to an administrator alone.</strong> "Every"
 *       over an empty set is vacuously true, which would mean anyone holding MANAGE anywhere could
 *       fill an empty group — and an empty group is one grant away from being a powerful one,
 *       granted by somebody else entirely.</li>
 * </ul>
 *
 * <p>What it deliberately does not cover: creating a group ({@code createGroup}) and granting one
 * access ({@code grantPermission}) are unchanged. The first stays administrator-only because a group
 * that does not exist yet has no grants to measure anybody against; the second has always been
 * governed by MANAGE over the resource being granted, which is the same sentence read the other way
 * round.
 */
@Component
public class GroupAdminPolicy {

    private final PermissionRepository permissionRepo;

    public GroupAdminPolicy(PermissionRepository permissionRepo) {
        this.permissionRepo = permissionRepo;
    }

    /**
     * May this caller administer this group? Evaluated per call rather than cached: the answer
     * changes the moment a grant is added to the group, and the {@link PermissionEvaluator} it asks
     * is request-scoped and memoised, so repeating the question inside one request is nearly free.
     */
    public Mono<Boolean> mayAdminister(PermissionEvaluator evaluator, Long groupId) {
        if (groupId == null) return Mono.just(false);
        return evaluator.isAdmin().flatMap(admin -> {
            if (admin) return Mono.just(true);
            return permissionRepo.grantsOfGroup(groupId).collectList().flatMap(grants -> {
                if (grants.isEmpty()) return Mono.just(false);
                return Flux.fromIterable(grants)
                    .concatMap(grant -> evaluator.levelForResource(grant.resourceType(), grant.resourceId())
                        .map(level -> level.allows(AccessLevel.MANAGE))
                        .defaultIfEmpty(false))
                    .all(allowed -> allowed);
            });
        });
    }

    /** The same, as a gate: a refusal is a GraphQL error rather than an empty list or a false. */
    public Mono<Boolean> require(PermissionEvaluator evaluator, Long groupId) {
        return mayAdminister(evaluator, groupId)
            .flatMap(allowed -> allowed ? Mono.just(true) : Mono.error(new GraphQlAuthException(
                "You need MANAGE access to everything this group can reach in order to administer it.")));
    }
}
