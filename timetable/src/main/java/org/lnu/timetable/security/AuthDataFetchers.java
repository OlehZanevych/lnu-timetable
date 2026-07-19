package org.lnu.timetable.security;

import graphql.schema.DataFetcher;
import org.lnu.timetable.framework.metadata.EntityMetadata;
import org.lnu.timetable.framework.metadata.EntityMetadataRegistry;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

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
 * {@link PermissionService#canManageGrantsOn} for permission delegation).
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

    // --- Query.me / Query.users / Query.groups / Query.canModifyResources ---

    public DataFetcher<?> me() {
        return env -> {
            Principal principal = AuthorizingDataFetcherProvider.principalOf(env);
            if (principal == null) return Mono.empty().toFuture();
            return currentUserMap(principal).toFuture();
        };
    }

    private Mono<Map<String, Object>> currentUserMap(Principal principal) {
        return permissionRepo.groupIdsForUser(principal.userId()).collectList()
            .flatMap(groupIds -> Mono.zip(
                permissionRepo.isGlobalAdmin(principal.userId(), groupIds),
                permissionRepo.effectiveGrants(principal.userId(), groupIds).collectList(),
                permissionRepo.groupsForUser(principal.userId()).collectList()
            ).map(tuple -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", principal.userId());
                m.put("email", principal.email());
                m.put("firstName", principal.firstName());
                m.put("lastName", principal.lastName());
                m.put("mustChangePassword", principal.mustChangePassword());
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

    public DataFetcher<?> groups() {
        return env -> requirePrincipal(env)
            .flatMapMany(p -> permissionRepo.listGroups())
            .map(this::groupToMap)
            .collectList()
            .toFuture();
    }

    /** Given a set of candidate ids of one resource type, returns the subset the caller may modify. */
    public DataFetcher<?> canModifyResources() {
        return env -> {
            String resourceType = env.getArgument("resourceType");
            List<String> rawIds = env.getArgument("resourceIds");
            Class<?> entityClass = entityRegistry.getEntityClassByResourceType(resourceType);
            return requirePrincipal(env).flatMap(principal -> {
                if (entityClass == null) return Mono.just(List.<Long>of());
                return Flux.fromIterable(rawIds)
                    .map(Long::parseLong)
                    .flatMap(id -> permissionService.canModify(principal.userId(), entityClass, id)
                        .map(ok -> ok ? id : null))
                    .filter(java.util.Objects::nonNull)
                    .collectList();
            }).toFuture();
        };
    }

    public DataFetcher<?> grantsForResource() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            String resourceType = env.getArgument("resourceType");
            Object rawResourceId = env.getArgument("resourceId");
            Long resourceId = rawResourceId == null ? null : Long.parseLong(rawResourceId.toString());
            return permissionService.canManageGrantsOn(principal.userId(), resourceType, resourceId)
                .flatMapMany(allowed -> allowed
                    ? permissionRepo.grantsForResource(resourceType, resourceId)
                    : Flux.<PermissionRepository.PermissionRow>error(new GraphQlAuthException(
                        "You don't have permission to view grants on this resource.")))
                .map(this::permissionToMap)
                .collectList();
        }).toFuture();
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
            return permissionRepo.findUserByEmail(email)
                .flatMap(existing -> Mono.just(createResult(false, null, "DUPLICATE_EMAIL")))
                .switchIfEmpty(permissionRepo.insertUser(email, firstName, lastName, passwordEncoder.encode(temporaryPassword))
                    .map(id -> createResult(true, Map.of(
                        "id", id, "email", email, "firstName", firstName, "lastName", lastName,
                        "mustChangePassword", true, "isActive", true), null)));
        }).toFuture();
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

    public DataFetcher<?> grantPermission() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            String granteeType = env.getArgument("granteeType");
            Object rawUserId = env.getArgument("userId");
            Object rawGroupId = env.getArgument("groupId");
            String resourceType = env.getArgument("resourceType");
            Object rawResourceId = env.getArgument("resourceId");
            Long resourceId = rawResourceId == null ? null : Long.parseLong(rawResourceId.toString());

            if (!"GLOBAL".equals(resourceType) && entityRegistry.getEntityClassByResourceType(resourceType) == null) {
                return Mono.just(simpleResult(false, "UNKNOWN_RESOURCE_TYPE"));
            }
            return permissionService.canManageGrantsOn(principal.userId(), resourceType, resourceId)
                .flatMap(allowed -> {
                    if (!allowed) return Mono.just(simpleResult(false, "FORBIDDEN"));
                    Long userId = rawUserId == null ? null : Long.parseLong(rawUserId.toString());
                    Long groupId = rawGroupId == null ? null : Long.parseLong(rawGroupId.toString());
                    return permissionRepo.insertPermission(granteeType, userId, groupId, resourceType, resourceId, principal.userId())
                        .map(id -> simpleResult(true, null))
                        .switchIfEmpty(Mono.just(simpleResult(false, "ALREADY_GRANTED")));
                });
        }).toFuture();
    }

    public DataFetcher<?> revokePermission() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            Long permissionId = Long.parseLong(env.getArgument("permissionId").toString());
            return permissionRepo.findPermission(permissionId).flatMap(grant ->
                permissionService.canManageGrantsOn(principal.userId(), grant.resourceType(), grant.resourceId())
                    .flatMap(allowed -> {
                        if (!allowed) return Mono.just(simpleResult(false, "FORBIDDEN"));
                        return permissionRepo.deletePermission(permissionId).map(rows -> simpleResult(rows > 0, null));
                    })
            ).switchIfEmpty(Mono.just(simpleResult(false, "PERMISSION_NOT_FOUND")));
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
            return permissionRepo.usersInGroup(groupId).map(this::userToMap).collectList().toFuture();
        };
    }

    public DataFetcher<?> grantUserField() {
        return env -> {
            Map<String, Object> source = env.getSource();
            Long userId = (Long) source.get("_userId");
            if (userId == null) return Mono.empty().toFuture();
            return permissionRepo.findUserById(userId).map(this::userToMap).toFuture();
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
            return permissionRepo.findUserById(grantedBy).map(this::userToMap).toFuture();
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
        return requirePrincipal(env).flatMap(principal -> permissionService.isAdmin(principal.userId()))
            .flatMap(admin -> admin ? Mono.just(true) : Mono.error(new GraphQlAuthException("Administrator access required.")));
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
        m.put("_userId", p.userId());
        m.put("_groupId", p.groupId());
        m.put("_grantedBy", p.grantedBy());
        return m;
    }
}
