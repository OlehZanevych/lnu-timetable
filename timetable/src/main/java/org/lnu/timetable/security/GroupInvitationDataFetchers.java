package org.lnu.timetable.security;

import graphql.schema.DataFetcher;
import graphql.schema.DataFetchingEnvironment;
import org.lnu.timetable.security.GroupInvitationRepository.InvitationRow;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The fetchers behind {@link GroupInvitationSchema}: five fields that let a group be joined by link
 * instead of by an administrator adding one account at a time.
 *
 * <h2>Who may administer a group's invitations</h2>
 *
 * {@link GroupAdminPolicy}, which is the same rule {@code addUserToGroup} now applies: an
 * administrator, or somebody holding {@code MANAGE} over every resource the group holds a grant on.
 * Minting a link into a group and adding an account to it are the same act through different doors,
 * and stating that rule twice is how the two would come to disagree.
 *
 * <h2>What redeeming a link is worth</h2>
 *
 * One row in {@code user_groups}, for the account already signed in. It creates no account — a
 * visitor who has none is sent to {@code /login}, and self-service registration stays what it was,
 * open only to a викладач or a студент the institution has already entered. It makes no grant, and
 * it does not let its holder invite anybody further. The whole of the access it confers is whatever
 * the group's own grants say, which is why who may create one is bounded as tightly as above.
 */
@Component
public class GroupInvitationDataFetchers {

    /** The bounds the product asks for: five minutes to thirty days. Also a CHECK on the table. */
    public static final int MIN_TTL_MINUTES = 5;
    public static final int MAX_TTL_MINUTES = 30 * 24 * 60;

    /**
     * 32 bytes, base64url, no padding — 43 characters. The same shape and the same source as the
     * registration links in {@code SelfServiceDataFetchers}: what makes a link unguessable is the
     * 256 bits behind it. base64url contains no dot, which is what keeps {@code FrontendController}'s
     * {@code [^.]*} patterns serving the page that carries it.
     */
    private static final SecureRandom RANDOM = new SecureRandom();

    private final GroupInvitationRepository invitationRepo;
    private final PermissionRepository permissionRepo;
    private final PermissionService permissionService;
    private final GroupAdminPolicy groupPolicy;

    public GroupInvitationDataFetchers(GroupInvitationRepository invitationRepo,
                                       PermissionRepository permissionRepo,
                                       PermissionService permissionService,
                                       GroupAdminPolicy groupPolicy) {
        this.invitationRepo = invitationRepo;
        this.permissionRepo = permissionRepo;
        this.permissionService = permissionService;
        this.groupPolicy = groupPolicy;
    }

    // --- Query.manageableGroups / Query.groupInvitations / Query.groupInvitation ---

    /**
     * The groups this caller may administer — what «Групи користувачів» lists. An administrator sees
     * every group; anybody else sees the ones {@link GroupAdminPolicy#mayAdminister} answers true for, which for
     * most accounts is none and for a деканат is the group their факультет was delegated to.
     * <p>
     * {@code Query.groups} already returns every group to every signed-in caller, and stays that
     * way: naming a group is not administering it, and the access panels need the list to grant to.
     * This is the narrower question — which of them may I open.
     */
    public DataFetcher<?> manageableGroups() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            PermissionEvaluator evaluator = evaluatorOf(env, principal);
            return permissionRepo.listGroups()
                .concatMap(group -> groupPolicy.mayAdminister(evaluator, group.id())
                    .map(allowed -> Map.entry(group, allowed)))
                .filter(Map.Entry::getValue)
                .map(entry -> groupToMap(entry.getKey()))
                .collectList();
        }).toFuture();
    }

    /** Every invitation of one group. Refused outright rather than answered empty — see the class note. */
    public DataFetcher<?> groupInvitations() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            Long groupId = idArgument(env, "groupId");
            return groupPolicy.require(evaluatorOf(env, principal), groupId)
                .flatMap(ok -> invitationRepo.listForGroup(groupId)
                    .map(this::invitationToMap)
                    .collectList());
        }).toFuture();
    }

    /**
     * Inspects a link without spending it, for the page the link opens: is it good, whose group is
     * it, and am I in that group already. Signed-in callers only — an invitation joins an account to
     * a group, so there is nothing to say to a caller who has none beyond «увійдіть», which the
     * client says on its own.
     */
    public DataFetcher<?> groupInvitation() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            String token = env.getArgument("token");
            if (token == null || token.isBlank()) {
                return Mono.just(check("NOT_FOUND", null, null, false));
            }
            return invitationRepo.findByToken(token).flatMap(invitation -> {
                if (invitation.expired()) {
                    return Mono.just(check("EXPIRED", null, null, false));
                }
                return permissionRepo.findGroupById(invitation.groupId()).flatMap(group ->
                    permissionRepo.groupIdsForUser(principal.userId())
                        .any(id -> id.equals(invitation.groupId()))
                        .map(isMember -> check("VALID", group.id(), group.name(), isMember)));
            }).defaultIfEmpty(check("NOT_FOUND", null, null, false));
        }).toFuture();
    }

    // --- Mutation.createGroupInvitation / deleteGroupInvitation / joinGroupByInvitation ---

    public DataFetcher<?> createGroupInvitation() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            Long groupId = idArgument(env, "groupId");
            Object rawTtl = env.getArgument("ttlMinutes");
            int ttl = rawTtl == null ? 0 : ((Number) rawTtl).intValue();
            return groupPolicy.require(evaluatorOf(env, principal), groupId).flatMap(ok -> {
                // Checked here as well as by the table, because the two answer different people: the
                // CHECK stops a bad row, this stops a bad request with a status the form can show.
                if (ttl < MIN_TTL_MINUTES || ttl > MAX_TTL_MINUTES) {
                    return Mono.just(createResult(false, null, "INVALID_TTL"));
                }
                return permissionRepo.findGroupById(groupId)
                    .flatMap(group -> invitationRepo.insert(groupId, newToken(), ttl, principal.userId())
                        .map(invitation -> createResult(true, invitationToMap(invitation), null)))
                    .defaultIfEmpty(createResult(false, null, "GROUP_NOT_FOUND"));
            });
        }).toFuture();
    }

    /**
     * Deletion is how an invitation is revoked. There is no disabled state and no «expire it now»:
     * a link that should stop working should stop existing, and the row carries nothing worth
     * keeping afterwards — who joined through it is already the membership list.
     */
    public DataFetcher<?> deleteGroupInvitation() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            Long invitationId = idArgument(env, "invitationId");
            return invitationRepo.findById(invitationId)
                .flatMap(invitation -> groupPolicy.require(evaluatorOf(env, principal), invitation.groupId())
                    .flatMap(ok -> invitationRepo.delete(invitationId)
                        .map(rows -> simpleResult(rows > 0, rows > 0 ? null : "NOT_FOUND"))))
                .defaultIfEmpty(simpleResult(false, "NOT_FOUND"));
        }).toFuture();
    }

    /**
     * Redeems a link: one {@code user_groups} row for the signed-in account.
     * <p>
     * Whether the caller was already a member is read off the insert rather than asked first.
     * {@code addUserToGroup} is an {@code ON CONFLICT DO NOTHING}, so a second click — or two tabs,
     * or two people sharing one account — updates no rows, and that zero is the answer. Asking
     * beforehand would leave a window between the question and the insert in which the count could
     * be incremented twice for one member.
     */
    public DataFetcher<?> joinGroupByInvitation() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            String token = env.getArgument("token");
            if (token == null || token.isBlank()) {
                return Mono.just(joinResult(false, null, null, "INVALID_TOKEN"));
            }
            return invitationRepo.findByToken(token).flatMap(invitation -> {
                if (invitation.expired()) {
                    return Mono.just(joinResult(false, null, null, "EXPIRED_TOKEN"));
                }
                return permissionRepo.findGroupById(invitation.groupId())
                    .flatMap(group -> permissionRepo.addUserToGroup(principal.userId(), group.id())
                        .flatMap(rows -> rows > 0
                            ? invitationRepo.recordJoin(invitation.id())
                                .thenReturn(joinResult(true, group.id(), group.name(), null))
                            : Mono.just(joinResult(false, group.id(), group.name(), "ALREADY_MEMBER"))))
                    .defaultIfEmpty(joinResult(false, null, null, "INVALID_TOKEN"));
            }).defaultIfEmpty(joinResult(false, null, null, "INVALID_TOKEN"));
        }).toFuture();
    }

    // --- authorization ---
    //
    // One rule, stated once in GroupAdminPolicy and shared with `addUserToGroup` /
    // `removeUserFromGroup`: inviting somebody into a group and adding them to it are the same act
    // with a different door, and two copies of a rule that grants access is one copy too many.

    // --- shared helpers ---
    //
    // The first two are deliberate copies of AuthDataFetchers' private helpers rather than a shared
    // base class: there are two of them, they are four lines each, and an inherited «you must be
    // signed in» is exactly the thing SelfServiceDataFetchers had to not inherit.

    private Mono<Principal> requirePrincipal(DataFetchingEnvironment env) {
        Principal principal = AuthorizingDataFetcherProvider.principalOf(env);
        return principal == null
            ? Mono.error(new GraphQlAuthException("You must be signed in to do this."))
            : Mono.just(principal);
    }

    private PermissionEvaluator evaluatorOf(DataFetchingEnvironment env, Principal principal) {
        PermissionEvaluator evaluator = env.getGraphQlContext().get(PermissionEvaluator.class);
        return evaluator != null ? evaluator : permissionService.newEvaluator(principal.userId());
    }

    private Long idArgument(DataFetchingEnvironment env, String name) {
        Object raw = env.getArgument(name);
        return raw == null || raw.toString().isBlank() ? null : Long.parseLong(raw.toString());
    }

    private String newToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /**
     * Timestamps travel as ISO-8601 strings without a zone, which is what the columns hold: the
     * database, the service and every reader of this timetable are in one timezone, and inventing an
     * offset here would only make the value look more precise than it is.
     */
    private String iso(LocalDateTime value) {
        return value == null ? null : DateTimeFormatter.ISO_LOCAL_DATE_TIME.format(value);
    }

    private Map<String, Object> invitationToMap(InvitationRow invitation) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", invitation.id());
        m.put("groupId", invitation.groupId());
        m.put("token", invitation.token());
        m.put("expiresAt", iso(invitation.expiresAt()));
        m.put("isExpired", invitation.expired());
        m.put("joinCount", invitation.joinCount());
        m.put("createdAt", iso(invitation.createdAt()));
        m.put("createdByName", invitation.createdByName());
        return m;
    }

    private Map<String, Object> groupToMap(PermissionRepository.GroupRow group) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", group.id());
        m.put("name", group.name());
        m.put("description", group.description());
        return m;
    }

    private Map<String, Object> check(String status, Long groupId, String groupName, boolean isMember) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isValid", "VALID".equals(status));
        m.put("status", status);
        m.put("groupId", groupId);
        m.put("groupName", groupName);
        m.put("isMember", isMember);
        return m;
    }

    private Map<String, Object> createResult(boolean success, Map<String, Object> data, String errorStatus) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isSuccess", success);
        m.put("data", data);
        if (errorStatus != null) m.put("errorStatus", errorStatus);
        return m;
    }

    private Map<String, Object> joinResult(boolean success, Long groupId, String groupName, String errorStatus) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isSuccess", success);
        m.put("groupId", groupId);
        m.put("groupName", groupName);
        if (errorStatus != null) m.put("errorStatus", errorStatus);
        return m;
    }

    /** The shared shape for a mutation with nothing to return but «done» — here, deletion. */
    private Map<String, Object> simpleResult(boolean success, String errorStatus) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isSuccess", success);
        if (errorStatus != null) m.put("errorStatus", errorStatus);
        return m;
    }
}
