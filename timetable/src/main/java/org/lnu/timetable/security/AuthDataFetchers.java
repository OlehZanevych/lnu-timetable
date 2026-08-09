package org.lnu.timetable.security;

import graphql.schema.DataFetcher;
import io.r2dbc.spi.R2dbcException;
import org.lnu.timetable.framework.metadata.EntityMetadata;
import org.lnu.timetable.framework.metadata.EntityMetadataRegistry;
import org.springframework.core.NestedExceptionUtils;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Hand-rolled data fetchers for authentication and user/group/permission management — the
 * {@code User}/{@code Group}/{@code PermissionGrant} GraphQL types (built in
 * {@link org.lnu.timetable.framework.schema.DynamicGraphQLSchemaBuilder#buildAuthTypes()}) live
 * outside the reflective {@code @GraphQLEntity} framework entirely, for the same reason
 * {@code GlobalProperty} does (see that class's javadoc): a user's password hash must never be
 * reachable through the fully-generic, selection-set-driven query/mutation machinery, and
 * operations like {@code login} or {@code grantPermission} don't fit the generic
 * create/update/delete shape anyway.
 * <p>
 * Unlike the rest of the schema, these root fields are <em>not</em> routed through
 * {@link AuthorizingDataFetcherProvider} (that decorator only wraps the generic,
 * entity-metadata-driven {@code DataFetcherProvider}) — each method here reads the
 * {@link Principal} straight from the GraphQL context and applies whatever check that particular
 * operation needs (none at all for {@code login}, "is this an admin" for user/group management,
 * {@link AccessLevel#MANAGE} on the target resource for permission delegation).
 */
@Component
public class AuthDataFetchers {

    private final PermissionRepository permissionRepo;
    private final PermissionGraphRepository graphRepo;
    private final PermissionService permissionService;
    private final EntityMetadataRegistry entityRegistry;
    private final JwtService jwtService;
    private final PasswordEncoder passwordEncoder;

    public AuthDataFetchers(PermissionRepository permissionRepo, PermissionGraphRepository graphRepo,
                             PermissionService permissionService, EntityMetadataRegistry entityRegistry,
                             JwtService jwtService, PasswordEncoder passwordEncoder) {
        this.permissionRepo = permissionRepo;
        this.graphRepo = graphRepo;
        this.permissionService = permissionService;
        this.entityRegistry = entityRegistry;
        this.jwtService = jwtService;
        this.passwordEncoder = passwordEncoder;
    }

    // --- Query.me / Query.users / Query.groups / Query.accessLevels ---

    public DataFetcher<?> me() {
        return env -> {
            Principal principal = AuthorizingDataFetcherProvider.principalOf(env);
            if (principal == null) return Mono.empty().toFuture();
            return currentUserMap(principal, evaluatorOf(env, principal)).toFuture();
        };
    }

    private Mono<Map<String, Object>> currentUserMap(Principal principal, PermissionEvaluator evaluator) {
        return permissionRepo.groupIdsForUser(principal.userId()).collectList()
            .flatMap(groupIds -> Mono.zip(
                evaluator.isAdmin(),
                permissionRepo.effectiveGrants(principal.userId(), groupIds).collectList(),
                permissionRepo.groupsForUser(principal.userId()).collectList()
            ).map(tuple -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", principal.userId());
                m.put("email", principal.email());
                m.put("firstName", principal.firstName());
                m.put("lastName", principal.lastName());
                m.put("mustChangePassword", principal.mustChangePassword());
                // Who this account *is* — what «Мій кабінет» resolves its навантаження / навчальний
                // план / розклад from. At most one is ever set; both null means "nobody in
                // particular", which is the normal case for deanery staff and the administrator.
                m.put("lecturerId", principal.lecturerId());
                m.put("studentId", principal.studentId());
                m.put("isAdmin", tuple.getT1());
                m.put("permissions", tuple.getT2().stream().map(this::permissionToMap).toList());
                m.put("groups", tuple.getT3().stream().map(this::groupToMap).toList());
                return m;
            }));
    }

    public DataFetcher<?> users() {
        return env -> requireAdmin(env)
            .flatMapMany(ok -> permissionRepo.listUsers())
            .map(this::userToMap)
            .collectList()
            .toFuture();
    }

    /**
     * Finds accounts by name or e-mail, for the grantee picker on the access panels. Open to anyone
     * who can delegate access somewhere, rather than to administrators only — otherwise a деканат
     * holding MANAGE on their факультет could grant access but had no way to look up the person
     * they were granting it to, which is what kept delegation an administrator's job in practice.
     * Identity only: no person link, no flags, no password material.
     */
    public DataFetcher<?> searchUsers() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            String query = env.getArgument("query");
            Object rawLimit = env.getArgument("limit");
            int limit = rawLimit == null ? 20 : Math.min(50, Math.max(1, ((Number) rawLimit).intValue()));
            if (query == null || query.trim().length() < 2) {
                return Mono.just(List.<Map<String, Object>>of());
            }
            return evaluatorOf(env, principal).canDelegateSomewhere()
                .flatMap(allowed -> allowed
                    ? permissionRepo.searchUsers(query.trim(), limit).map(this::identityOnly).collectList()
                    : Mono.error(new GraphQlAuthException("You need MANAGE access somewhere to look up users.")));
        }).toFuture();
    }

    public DataFetcher<?> groups() {
        return env -> requirePrincipal(env)
            .flatMapMany(p -> permissionRepo.listGroups())
            .map(this::groupToMap)
            .collectList()
            .toFuture();
    }

    /**
     * Given candidate ids of one resource type, returns the caller's access level on each — the one
     * query the client needs to decide which buttons a page may show.
     * <p>
     * It replaces the old {@code canModifyResources}, which answered with a subset of ids: a
     * yes/no answer cannot distinguish «можна редагувати» from «можна редагувати й видаляти», so a
     * client built on it had no way to show an Edit button without a Delete button beside it. Ids
     * the caller cannot touch at all are simply absent from the result rather than being returned
     * with a null level — the client works with a map, and absent is the natural spelling of "no".
     */
    public DataFetcher<?> accessLevels() {
        return env -> {
            String resourceType = env.getArgument("resourceType");
            List<String> rawIds = env.getArgument("resourceIds");
            Class<?> entityClass = entityRegistry.getEntityClassByResourceType(resourceType);
            return requirePrincipal(env).flatMap(principal -> {
                if (entityClass == null) return Mono.just(List.<Map<String, Object>>of());
                List<Long> ids = rawIds.stream().map(Long::parseLong).toList();
                return evaluatorOf(env, principal).levelsFor(entityClass, ids)
                    .map(levels -> levels.entrySet().stream()
                        .map(e -> {
                            Map<String, Object> m = new LinkedHashMap<>();
                            m.put("id", e.getKey());
                            m.put("level", e.getValue().name());
                            return m;
                        })
                        .toList());
            }).toFuture();
        };
    }

    /**
     * Who can currently reach this resource, and how. Requires {@link AccessLevel#MANAGE} on it.
     * <p>
     * With {@code includeInherited} (the default) the answer includes grants made on the resource's
     * ancestors and university-wide grants, because that is the question an administrator is
     * actually asking: "who can edit this кафедра" is answered wrongly by a list that omits the
     * деканат who holds the факультет above it. Inherited rows are marked — {@code inherited: true}
     * — and cannot be revoked from here; the client shows them as context rather than as controls.
     */
    public DataFetcher<?> grantsForResource() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            String resourceType = env.getArgument("resourceType");
            Object rawResourceId = env.getArgument("resourceId");
            Long resourceId = rawResourceId == null ? null : Long.parseLong(rawResourceId.toString());
            Boolean rawInherited = env.getArgument("includeInherited");
            boolean includeInherited = rawInherited == null || rawInherited;
            PermissionEvaluator evaluator = evaluatorOf(env, principal);

            return requireLevel(evaluator, resourceType, resourceId, AccessLevel.MANAGE,
                    "You need MANAGE access on this resource to see who else can reach it.")
                .flatMap(ok -> includeInherited
                    ? evaluator.coveringRefs(resourceType, resourceId)
                        .flatMapMany(permissionRepo::grantsForResources)
                        .collectList()
                    : permissionRepo.grantsForResource(resourceType, resourceId).collectList())
                .map(rows -> rows.stream()
                    .map(row -> {
                        Map<String, Object> m = permissionToMap(row);
                        boolean own = row.resourceType().equals(resourceType)
                            && java.util.Objects.equals(row.resourceId(), resourceId);
                        m.put("inherited", !own);
                        return m;
                    })
                    // Direct grants first, then inherited ones, strongest level first within each —
                    // the order someone scanning the list to answer "who is in charge here" reads in.
                    .sorted(GRANT_DISPLAY_ORDER)
                    .toList());
        }).toFuture();
    }

    /** Direct grants before inherited ones; within each, the strongest level first. */
    private static final Comparator<Map<String, Object>> GRANT_DISPLAY_ORDER =
        Comparator.<Map<String, Object>, Boolean>comparing(m -> Boolean.TRUE.equals(m.get("inherited")))
            .thenComparing(Comparator.<Map<String, Object>>comparingInt(m -> {
                AccessLevel level = AccessLevel.parse(m.get("level"));
                return level == null ? Integer.MAX_VALUE : -level.ordinal();
            }));

    /** Fails with a GraphQL error unless the caller holds at least {@code required} on the resource. */
    private Mono<Boolean> requireLevel(PermissionEvaluator evaluator, String resourceType, Long resourceId,
                                        AccessLevel required, String message) {
        return evaluator.levelForResource(resourceType, resourceId)
            .map(level -> level.allows(required))
            .defaultIfEmpty(false)
            .flatMap(ok -> ok ? Mono.just(true) : Mono.error(new GraphQlAuthException(message)));
    }

    // --- Mutation.login / changePassword / createUser / setUserActive ---

    public DataFetcher<?> login() {
        return env -> {
            String email = env.getArgument("email");
            String rawPassword = env.getArgument("password");
            return permissionRepo.findUserByEmail(email)
                .flatMap(user -> {
                    if (!user.active()) {
                        return Mono.just(result(false, null, "ACCOUNT_DISABLED", null));
                    }
                    if (!passwordEncoder.matches(rawPassword, user.passwordHash())) {
                        return Mono.just(result(false, null, "INVALID_CREDENTIALS", null));
                    }
                    String token = jwtService.issueToken(user.id());
                    return Mono.just(result(true, token, null, user.mustChangePassword()));
                })
                .switchIfEmpty(Mono.just(result(false, null, "INVALID_CREDENTIALS", null)))
                .toFuture();
        };
    }

    private Map<String, Object> result(boolean success, String token, String errorStatus, Boolean mustChangePassword) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isSuccess", success);
        if (token != null) m.put("token", token);
        if (errorStatus != null) m.put("errorStatus", errorStatus);
        if (mustChangePassword != null) m.put("mustChangePassword", mustChangePassword);
        return m;
    }

    public DataFetcher<?> changePassword() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            String currentPassword = env.getArgument("currentPassword");
            String newPassword = env.getArgument("newPassword");
            return permissionRepo.findUserById(principal.userId()).flatMap(user -> {
                if (!passwordEncoder.matches(currentPassword, user.passwordHash())) {
                    return Mono.just(simpleResult(false, "INVALID_CURRENT_PASSWORD"));
                }
                if (newPassword == null || newPassword.length() < 8) {
                    return Mono.just(simpleResult(false, "WEAK_PASSWORD"));
                }
                return permissionRepo.updatePassword(principal.userId(), passwordEncoder.encode(newPassword), false)
                    .map(rows -> simpleResult(true, null));
            });
        }).toFuture();
    }

    public DataFetcher<?> createUser() {
        return env -> requireAdmin(env).flatMap(admin -> {
            String email = env.getArgument("email");
            String firstName = env.getArgument("firstName");
            String lastName = env.getArgument("lastName");
            String temporaryPassword = env.getArgument("temporaryPassword");
            Long lecturerId = idArgument(env, "lecturerId");
            Long studentId = idArgument(env, "studentId");
            // An account is a lecturer's or a student's, or nobody's — the same rule
            // users_person_link_check enforces, checked here so the caller gets a named status
            // instead of the generic integrity-violation error (see the service README's
            // "A CHECK-constraint failure is reported as if a related row were missing").
            if (lecturerId != null && studentId != null) {
                return Mono.just(createResult(false, null, "BOTH_LINKS_SET"));
            }
            return permissionRepo.findUserByEmail(email)
                .flatMap(existing -> Mono.just(createResult(false, null, "DUPLICATE_EMAIL")))
                .switchIfEmpty(permissionRepo.insertUser(email, firstName, lastName,
                        passwordEncoder.encode(temporaryPassword), lecturerId, studentId)
                    .<Map<String, Object>>map(id -> {
                        Map<String, Object> data = new LinkedHashMap<>();
                        data.put("id", id);
                        data.put("email", email);
                        data.put("firstName", firstName);
                        data.put("lastName", lastName);
                        data.put("mustChangePassword", true);
                        data.put("isActive", true);
                        data.put("lecturerId", lecturerId);
                        data.put("studentId", studentId);
                        return createResult(true, data, null);
                    })
                    .onErrorResume(DataIntegrityViolationException.class,
                        e -> Mono.just(createResult(false, null, linkErrorStatus(e)))));
        }).toFuture();
    }

    /**
     * Points an existing account at the lecturer or the student it belongs to — or, with both
     * arguments omitted, at nobody, which is how a link is cleared. Administrator-only, like the
     * rest of account management: the link decides whose навантаження and розклад «Мій кабінет»
     * shows, so letting a user set it themselves would let anyone read anyone else's.
     */
    public DataFetcher<?> setUserLink() {
        return env -> requireAdmin(env).flatMap(admin -> {
            Long userId = Long.parseLong(env.getArgument("userId").toString());
            Long lecturerId = idArgument(env, "lecturerId");
            Long studentId = idArgument(env, "studentId");
            if (lecturerId != null && studentId != null) {
                return Mono.just(simpleResult(false, "BOTH_LINKS_SET"));
            }
            return permissionRepo.setUserLink(userId, lecturerId, studentId)
                .map(rows -> simpleResult(rows > 0, rows > 0 ? null : "USER_NOT_FOUND"))
                .onErrorResume(DataIntegrityViolationException.class,
                    e -> Mono.just(simpleResult(false, linkErrorStatus(e))));
        }).toFuture();
    }

    /** Optional `ID` argument → Long, tolerating both the absent and the explicit-null forms. */
    private Long idArgument(graphql.schema.DataFetchingEnvironment env, String name) {
        Object raw = env.getArgument(name);
        return raw == null || raw.toString().isBlank() ? null : Long.parseLong(raw.toString());
    }

    /**
     * The three ways the database can reject a person link, told apart by SQLSTATE rather than by
     * the text of the message — R2DBC surfaces all of them as one
     * {@link DataIntegrityViolationException}, and only the state code is a contract.
     * <p>
     * This is deliberately narrower than the generic handler in {@code DynamicDataFetchers}, which
     * maps every integrity violation to whichever declared status contains {@code "NOT_FOUND"} and
     * therefore cannot tell a failed {@code CHECK} from a missing row (see the service README's
     * <em>Known limitations</em>). The callers pair it with
     * {@code onErrorResume(DataIntegrityViolationException.class, …)}, so a connection failure or a
     * statement timeout still propagates as a GraphQL error instead of being reported to an
     * administrator as "that lecturer does not exist".
     */
    private String linkErrorStatus(Throwable e) {
        Throwable root = NestedExceptionUtils.getMostSpecificCause(e);
        String state = root instanceof R2dbcException r && r.getSqlState() != null ? r.getSqlState() : "";
        return switch (state) {
            // 23505 is unique_violation, and `users` has three unique constraints, not one: the two
            // partial person-link indexes and `users.email`. The e-mail one is reachable from
            // createUser, whose lower(email) pre-check can lose a race, so the constraint name is
            // consulted *inside* the already-narrowed case. That is a secondary discriminator, not
            // the handle — the state code still decides which family of problem this is.
            case "23505" -> String.valueOf(root.getMessage()).contains("users_email_key")
                ? "DUPLICATE_EMAIL" : "ALREADY_LINKED";
            case "23514" -> "BOTH_LINKS_SET";  // check_violation — users_person_link_check
            default      -> "INVALID_LINK";    // 23503 foreign_key_violation, and anything else
        };
    }

    private Map<String, Object> createResult(boolean success, Map<String, Object> data, String errorStatus) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isSuccess", success);
        if (data != null) m.put("data", data);
        if (errorStatus != null) m.put("errorStatus", errorStatus);
        return m;
    }

    public DataFetcher<?> setUserActive() {
        return env -> requireAdmin(env).flatMap(admin -> {
            Long userId = Long.parseLong(env.getArgument("userId").toString());
            boolean active = env.getArgument("active");
            return permissionRepo.setUserActive(userId, active).map(rows -> simpleResult(rows > 0, rows > 0 ? null : "USER_NOT_FOUND"));
        }).toFuture();
    }

    // --- Mutation: groups & membership ---

    public DataFetcher<?> createGroup() {
        return env -> requireAdmin(env).flatMap(admin -> {
            String name = env.getArgument("name");
            String description = env.getArgument("description");
            return permissionRepo.insertGroup(name, description)
                .map(id -> createResult(true, Map.of("id", id, "name", name,
                    "description", description == null ? "" : description), null))
                .onErrorResume(e -> Mono.just(createResult(false, null, "DUPLICATE_NAME")));
        }).toFuture();
    }

    public DataFetcher<?> addUserToGroup() {
        return env -> requireAdmin(env).flatMap(admin -> {
            Long userId = Long.parseLong(env.getArgument("userId").toString());
            Long groupId = Long.parseLong(env.getArgument("groupId").toString());
            return permissionRepo.addUserToGroup(userId, groupId).map(rows -> simpleResult(true, null));
        }).toFuture();
    }

    public DataFetcher<?> removeUserFromGroup() {
        return env -> requireAdmin(env).flatMap(admin -> {
            Long userId = Long.parseLong(env.getArgument("userId").toString());
            Long groupId = Long.parseLong(env.getArgument("groupId").toString());
            return permissionRepo.removeUserFromGroup(userId, groupId).map(rows -> simpleResult(true, null));
        }).toFuture();
    }

    // --- Mutation: grantPermission / revokePermission (delegation) ---

    /**
     * Delegation. Grants — or re-levels — access on one resource, to a user or a group.
     * <p>
     * Two rules, and no more than two: the caller must hold {@link AccessLevel#MANAGE} over the
     * resource (their own grant on it, a grant on any ancestor of it, or a university-wide grant),
     * and they cannot hand out a level above their own. Since MANAGE is the top of the scale the
     * second rule never bites today, but it is written down rather than assumed, so that adding a
     * level above MANAGE later cannot silently let a delegate mint it.
     * <p>
     * Granting the same scope twice is an update of the level, not a failure — see
     * {@link PermissionRepository#upsertPermission}. The response says which happened
     * ({@code UPDATED}) so the UI can tell the administrator what they just did.
     */
    public DataFetcher<?> grantPermission() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            String granteeType = env.getArgument("granteeType");
            Object rawUserId = env.getArgument("userId");
            Object rawGroupId = env.getArgument("groupId");
            String resourceType = env.getArgument("resourceType");
            Object rawResourceId = env.getArgument("resourceId");
            Long resourceId = rawResourceId == null ? null : Long.parseLong(rawResourceId.toString());
            AccessLevel level = AccessLevel.parse(env.getArgument("level"));

            if (level == null) {
                return Mono.just(simpleResult(false, "UNKNOWN_ACCESS_LEVEL"));
            }
            if (!ResourceRef.GLOBAL_TYPE.equals(resourceType)
                && entityRegistry.getEntityClassByResourceType(resourceType) == null) {
                return Mono.just(simpleResult(false, "UNKNOWN_RESOURCE_TYPE"));
            }
            Long userId = rawUserId == null ? null : Long.parseLong(rawUserId.toString());
            Long groupId = rawGroupId == null ? null : Long.parseLong(rawGroupId.toString());
            // A grant is one person's or one group's, never both and never neither — the same rule
            // permissions_grantee_check enforces, checked here so the caller gets a named status
            // rather than a raw integrity violation.
            boolean validGrantee = ("USER".equals(granteeType) && userId != null && groupId == null)
                || ("GROUP".equals(granteeType) && groupId != null && userId == null);
            if (!validGrantee) {
                return Mono.just(simpleResult(false, "INVALID_GRANTEE"));
            }

            return evaluatorOf(env, principal).levelForResource(resourceType, resourceId)
                .flatMap(own -> {
                    if (!own.allows(AccessLevel.MANAGE)) {
                        return Mono.just(simpleResult(false, "FORBIDDEN"));
                    }
                    if (!own.allows(level)) {
                        return Mono.just(simpleResult(false, "LEVEL_ABOVE_OWN"));
                    }
                    return permissionRepo.upsertPermission(granteeType, userId, groupId, resourceType, resourceId,
                            level, principal.userId())
                        .map(outcome -> simpleResult(true, outcome.updated() ? "UPDATED" : null))
                        // A user or group id that names nobody trips a foreign key; report it as the
                        // named status the form already knows how to say, rather than as a raw
                        // integrity-violation error. Narrowed to that one exception type so a
                        // connection failure still surfaces as a failure.
                        .onErrorResume(DataIntegrityViolationException.class,
                            e -> Mono.just(simpleResult(false, "INVALID_GRANTEE")));
                })
                // No level at all on the resource — the caller cannot see it, let alone share it.
                .switchIfEmpty(Mono.just(simpleResult(false, "FORBIDDEN")));
        }).toFuture();
    }

    /**
     * Withdraws a grant. Requires {@link AccessLevel#MANAGE}, and one thing more: the caller's
     * MANAGE must come from <em>above</em> the grant's resource, or the grant must be one they made
     * themselves.
     * <p>
     * That extra clause closes a hole the previous rule left open. When delegation and modification
     * were the same check, everyone holding a grant on a кафедра could revoke everyone else's grant
     * on that same кафедра — including the one the деканат had just made, and including their own.
     * Two heads of the same department could unseat each other, and a delegate could lock out the
     * person who appointed them. Requiring authority from a strict ancestor means access is
     * withdrawn by whoever is actually above it, while {@code granted_by} still lets anyone undo
     * their own mistake immediately.
     */
    public DataFetcher<?> revokePermission() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            Long permissionId = Long.parseLong(env.getArgument("permissionId").toString());
            PermissionEvaluator evaluator = evaluatorOf(env, principal);
            return permissionRepo.findPermission(permissionId).flatMap(grant -> {
                if (java.util.Objects.equals(grant.grantedBy(), principal.userId())) {
                    return permissionRepo.deletePermission(permissionId).map(rows -> simpleResult(rows > 0, null));
                }
                return evaluator.holdsManageAbove(grant.resourceType(), grant.resourceId())
                    .flatMap(allowed -> allowed
                        ? permissionRepo.deletePermission(permissionId).map(rows -> simpleResult(rows > 0, null))
                        : Mono.just(simpleResult(false, "FORBIDDEN")));
            }).switchIfEmpty(Mono.just(simpleResult(false, "PERMISSION_NOT_FOUND")));
        }).toFuture();
    }

    // --- relation field resolvers (User.groups, Group.members, PermissionGrant.user/group/grantedBy/resourceLabel) ---

    public DataFetcher<?> userGroupsField() {
        return env -> {
            Map<String, Object> source = env.getSource();
            Long userId = (Long) source.get("id");
            return permissionRepo.groupsForUser(userId).map(this::groupToMap).collectList().toFuture();
        };
    }

    public DataFetcher<?> groupMembersField() {
        return env -> {
            Map<String, Object> source = env.getSource();
            Long groupId = (Long) source.get("id");
            return permissionRepo.usersInGroup(groupId).map(this::identityOnly).collectList().toFuture();
        };
    }

    public DataFetcher<?> grantUserField() {
        return env -> {
            Map<String, Object> source = env.getSource();
            Long userId = (Long) source.get("_userId");
            if (userId == null) return Mono.empty().toFuture();
            return permissionRepo.findUserById(userId).map(this::identityOnly).toFuture();
        };
    }

    public DataFetcher<?> grantGroupField() {
        return env -> {
            Map<String, Object> source = env.getSource();
            Long groupId = (Long) source.get("_groupId");
            if (groupId == null) return Mono.empty().toFuture();
            return permissionRepo.findGroupById(groupId).map(this::groupToMap).toFuture();
        };
    }

    public DataFetcher<?> grantGrantedByField() {
        return env -> {
            Map<String, Object> source = env.getSource();
            Long grantedBy = (Long) source.get("_grantedBy");
            if (grantedBy == null) return Mono.empty().toFuture();
            return permissionRepo.findUserById(grantedBy).map(this::identityOnly).toFuture();
        };
    }

    public DataFetcher<?> grantResourceLabelField() {
        return env -> {
            Map<String, Object> source = env.getSource();
            String resourceType = (String) source.get("resourceType");
            Long resourceId = (Long) source.get("resourceId");
            if ("GLOBAL".equals(resourceType) || resourceId == null) {
                return Mono.just("Full access (all entities)").toFuture();
            }
            Class<?> entityClass = entityRegistry.getEntityClassByResourceType(resourceType);
            if (entityClass == null) return Mono.<String>just(resourceType + " #" + resourceId).toFuture();
            EntityMetadata md = entityRegistry.getMetadata(entityClass);
            String labelField = md.fields().containsKey("name") ? "name"
                : md.fields().containsKey("firstName") ? "firstName"
                : md.fields().containsKey("number") ? "number"
                : null;
            String labelColumn = labelField == null ? null : md.getField(labelField).columnName();
            if (labelColumn == null) {
                return Mono.<String>just(resourceType + " #" + resourceId).toFuture();
            }
            return graphRepo.fetchLabel(md.tableName(), labelColumn, resourceId).toFuture();
        };
    }

    // --- shared helpers ---

    private Mono<Principal> requirePrincipal(graphql.schema.DataFetchingEnvironment env) {
        Principal principal = AuthorizingDataFetcherProvider.principalOf(env);
        return principal == null ? Mono.error(new GraphQlAuthException("You must be signed in to do this.")) : Mono.just(principal);
    }

    private Mono<Boolean> requireAdmin(graphql.schema.DataFetchingEnvironment env) {
        return requirePrincipal(env).flatMap(principal -> evaluatorOf(env, principal).isAdmin())
            .flatMap(admin -> admin ? Mono.just(true) : Mono.error(new GraphQlAuthException("Administrator access required.")));
    }

    /** The request-scoped {@link PermissionEvaluator}; see {@link AuthorizingDataFetcherProvider#evaluatorOf}. */
    private PermissionEvaluator evaluatorOf(graphql.schema.DataFetchingEnvironment env, Principal principal) {
        PermissionEvaluator evaluator = env.getGraphQlContext().get(PermissionEvaluator.class);
        return evaluator != null ? evaluator : permissionService.newEvaluator(principal.userId());
    }

    private Map<String, Object> simpleResult(boolean success, String errorStatus) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isSuccess", success);
        if (errorStatus != null) m.put("errorStatus", errorStatus);
        return m;
    }

    private Map<String, Object> userToMap(PermissionRepository.UserRow u) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", u.id());
        m.put("email", u.email());
        m.put("firstName", u.firstName());
        m.put("lastName", u.lastName());
        m.put("mustChangePassword", u.mustChangePassword());
        m.put("isActive", u.active());
        m.put("lecturerId", u.lecturerId());
        m.put("studentId", u.studentId());
        return m;
    }

    /**
     * The same {@code User} type with the person link left out — for the three places a user is
     * named rather than administered: {@code Group.members}, {@code PermissionGrant.user} and
     * {@code PermissionGrant.grantedBy}.
     * <p>
     * {@code Query.users} is administrator-only, but {@code Query.groups} is open to any signed-in
     * caller and {@code grantsForResource} only asks for rights on the one resource, so without
     * this both would let anyone enumerate which lecturer or student every account belongs to.
     * Those fields answer "who is this person", and the link is not part of that answer.
     */
    private Map<String, Object> identityOnly(PermissionRepository.UserRow u) {
        Map<String, Object> m = userToMap(u);
        m.remove("lecturerId");
        m.remove("studentId");
        return m;
    }

    private Map<String, Object> groupToMap(PermissionRepository.GroupRow g) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", g.id());
        m.put("name", g.name());
        m.put("description", g.description());
        return m;
    }

    private Map<String, Object> permissionToMap(PermissionRepository.PermissionRow p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", p.id());
        m.put("granteeType", p.granteeType());
        m.put("resourceType", p.resourceType());
        m.put("resourceId", p.resourceId());
        m.put("level", p.level() == null ? null : p.level().name());
        m.put("_userId", p.userId());
        m.put("_groupId", p.groupId());
        m.put("_grantedBy", p.grantedBy());
        return m;
    }
}
