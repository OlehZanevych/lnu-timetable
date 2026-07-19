package org.lnu.timetable.framework.schema;

import com.google.common.base.CaseFormat;
import graphql.schema.*;
import graphql.schema.idl.SchemaPrinter;
import org.lnu.timetable.framework.config.*;
import org.lnu.timetable.framework.metadata.*;
import org.lnu.timetable.framework.runtime.DynamicDataFetchers;
import org.lnu.timetable.security.AuthDataFetchers;
import org.springframework.stereotype.Component;

import java.util.*;

import static graphql.Scalars.*;
import static graphql.schema.GraphQLArgument.newArgument;
import static graphql.schema.GraphQLEnumType.newEnum;
import static graphql.schema.GraphQLFieldDefinition.newFieldDefinition;
import static graphql.schema.GraphQLInputObjectField.newInputObjectField;
import static graphql.schema.GraphQLInputObjectType.newInputObject;
import static graphql.schema.GraphQLObjectType.newObject;

/**
 * Builds a complete GraphQL schema programmatically from entity metadata and schema configuration.
 */
@Component
public class DynamicGraphQLSchemaBuilder {

    private final EntityMetadataRegistry metadataRegistry;
    private final Map<String, GraphQLObjectType> builtTypes = new LinkedHashMap<>();
    private final Map<String, GraphQLInputObjectType> builtInputTypes = new LinkedHashMap<>();
    private final Map<String, GraphQLEnumType> builtEnumTypes = new LinkedHashMap<>();

    public DynamicGraphQLSchemaBuilder(EntityMetadataRegistry metadataRegistry) {
        this.metadataRegistry = metadataRegistry;
    }

    /**
     * @param fetchers               dispatches every generic, entity-metadata-driven query/mutation/relation —
     *                               normally an authorization-checking decorator (see
     *                               {@code org.lnu.timetable.security.AuthorizingDataFetcherProvider}) wrapping
     *                               {@code globalPropertyFetchers}, but any {@link DataFetcherProvider} works
     *                               (e.g. a no-op one in tests — see {@code SchemaBuildTest}).
     * @param globalPropertyFetchers supplies the hand-rolled {@code GlobalProperty} fetchers (see
     *                               {@link #buildGlobalPropertyTypes()}); kept as the concrete
     *                               {@link DynamicDataFetchers} type since those three methods aren't part of
     *                               the generic {@link DataFetcherProvider} contract.
     * @param authFetchers           supplies the hand-rolled authentication/user/group/permission fetchers (see
     *                               {@link #buildAuthTypes()}); deliberately bypasses {@code fetchers} entirely
     *                               so unauthenticated operations like {@code login} stay reachable.
     */
    public GraphQLSchema buildSchema(List<GraphQLSchemaConfig> configs, DataFetcherProvider fetchers,
                                      DynamicDataFetchers globalPropertyFetchers, AuthDataFetchers authFetchers) {
        SchemaDefinition schemaDef = collectSchemaDefinition(configs);
        buildAllTypes(schemaDef);

        Map<Class<?>, List<QueryDefinition>> queriesByEntity = groupQueries(schemaDef.getQueries());
        Map<Class<?>, List<MutationDefinition>> mutationsByEntity = groupMutations(schemaDef.getMutations());

        GraphQLObjectType queryType = buildQueryType(queriesByEntity);
        GraphQLObjectType mutationType = buildMutationType(mutationsByEntity);
        GraphQLCodeRegistry codeRegistry = buildCodeRegistry(schemaDef, queriesByEntity, mutationsByEntity,
            fetchers, globalPropertyFetchers, authFetchers);

        return assembleSchema(queryType, mutationType, codeRegistry);
    }

    // -------------------------------------------------------------------------
    // Schema assembly steps
    // -------------------------------------------------------------------------

    private SchemaDefinition collectSchemaDefinition(List<GraphQLSchemaConfig> configs) {
        SchemaDefinition schemaDef = new SchemaDefinition();
        for (GraphQLSchemaConfig config : configs) {
            config.configure(schemaDef);
        }
        return schemaDef;
    }

    private void buildAllTypes(SchemaDefinition schemaDef) {
        builtTypes.put("ConnectionPageInfo", buildPageInfoType());
        buildGlobalPropertyTypes();
        buildAuthTypes();

        for (TypeDefinition typeDef : schemaDef.getTypes()) {
            buildObjectType(typeDef);
        }
        for (QueryDefinition queryDef : schemaDef.getQueries()) {
            if (queryDef.getQueryType() == QueryDefinition.QueryType.CONNECTION) {
                buildConnectionType(queryDef);
            }
        }
        for (MutationDefinition mutDef : schemaDef.getMutations()) {
            buildMutationTypes(mutDef);
        }
    }

    private Map<Class<?>, List<QueryDefinition>> groupQueries(List<QueryDefinition> queries) {
        Map<Class<?>, List<QueryDefinition>> map = new LinkedHashMap<>();
        for (QueryDefinition qd : queries) {
            map.computeIfAbsent(qd.getEntityClass(), k -> new ArrayList<>()).add(qd);
        }
        return map;
    }

    private Map<Class<?>, List<MutationDefinition>> groupMutations(List<MutationDefinition> mutations) {
        Map<Class<?>, List<MutationDefinition>> map = new LinkedHashMap<>();
        for (MutationDefinition md : mutations) {
            map.computeIfAbsent(md.getEntityClass(), k -> new ArrayList<>()).add(md);
        }
        return map;
    }

    /** Builds the Query root type, grouping fields into per-entity XxxQueries namespaces. */
    private GraphQLObjectType buildQueryType(Map<Class<?>, List<QueryDefinition>> queriesByEntity) {
        GraphQLObjectType.Builder builder = newObject().name("Query");

        for (var entry : queriesByEntity.entrySet()) {
            String entityName = entry.getKey().getSimpleName();
            String queriesTypeName = entityName + "Queries";
            String fieldName = pluralize(CaseFormat.UPPER_CAMEL.to(CaseFormat.LOWER_CAMEL, entityName));

            GraphQLObjectType.Builder queriesTypeBuilder = newObject().name(queriesTypeName);
            for (QueryDefinition qd : entry.getValue()) {
                queriesTypeBuilder.field(buildQueryField(qd));
            }
            GraphQLObjectType queriesType = queriesTypeBuilder.build();
            builtTypes.put(queriesTypeName, queriesType);

            builder.field(newFieldDefinition().name(fieldName).type(queriesType).build());
        }

        addApolloFederationServiceField(builder);
        addGlobalPropertyQueryField(builder);
        addAuthQueryFields(builder);

        return builder.build();
    }

    /** Adds the Apollo Federation _service { sdl } field so gateways/Apollo Studio can fetch the schema. */
    private void addApolloFederationServiceField(GraphQLObjectType.Builder queryBuilder) {
        GraphQLObjectType serviceType = newObject().name("_Service")
            .field(newFieldDefinition().name("sdl").type(GraphQLString))
            .build();
        builtTypes.put("_Service", serviceType);
        queryBuilder.field(newFieldDefinition()
            .name("_service")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("_Service")))
            .build());
    }

    /** Builds the Mutation root type, grouping fields into per-entity XxxMutations namespaces. */
    private GraphQLObjectType buildMutationType(Map<Class<?>, List<MutationDefinition>> mutationsByEntity) {
        GraphQLObjectType.Builder builder = newObject().name("Mutation");

        for (var entry : mutationsByEntity.entrySet()) {
            String entityName = entry.getKey().getSimpleName();
            String mutationsTypeName = entityName + "Mutations";
            String fieldName = pluralize(CaseFormat.UPPER_CAMEL.to(CaseFormat.LOWER_CAMEL, entityName));

            GraphQLObjectType.Builder mutationsTypeBuilder = newObject().name(mutationsTypeName);
            for (MutationDefinition md : entry.getValue()) {
                mutationsTypeBuilder.field(buildMutationField(md));
            }
            GraphQLObjectType mutationsType = mutationsTypeBuilder.build();
            builtTypes.put(mutationsTypeName, mutationsType);

            builder.field(newFieldDefinition().name(fieldName).type(mutationsType).build());
        }

        addGlobalPropertyMutationField(builder);
        addAuthMutationFields(builder);

        return builder.build();
    }

    private GraphQLCodeRegistry buildCodeRegistry(
            SchemaDefinition schemaDef,
            Map<Class<?>, List<QueryDefinition>> queriesByEntity,
            Map<Class<?>, List<MutationDefinition>> mutationsByEntity,
            DataFetcherProvider fetchers,
            DynamicDataFetchers globalPropertyFetchers,
            AuthDataFetchers authFetchers) {

        GraphQLCodeRegistry.Builder codeRegistry = GraphQLCodeRegistry.newCodeRegistry();

        registerApolloFederationFetcher(codeRegistry);
        registerQueryFetchers(codeRegistry, queriesByEntity, fetchers);
        registerMutationFetchers(codeRegistry, mutationsByEntity, fetchers);
        registerRelationFetchers(codeRegistry, schemaDef.getTypes(), fetchers);
        if (globalPropertyFetchers != null) {
            registerGlobalPropertyFetchers(codeRegistry, globalPropertyFetchers);
        }
        if (authFetchers != null) {
            registerAuthFetchers(codeRegistry, authFetchers);
        }

        return codeRegistry.build();
    }

    private GraphQLSchema assembleSchema(
            GraphQLObjectType queryType,
            GraphQLObjectType mutationType,
            GraphQLCodeRegistry codeRegistry) {

        Set<GraphQLType> additionalTypes = new LinkedHashSet<>();
        additionalTypes.addAll(builtTypes.values());
        additionalTypes.addAll(builtInputTypes.values());
        additionalTypes.addAll(builtEnumTypes.values());

        return GraphQLSchema.newSchema()
            .query(queryType)
            .mutation(mutationType)
            .additionalTypes(additionalTypes)
            .codeRegistry(codeRegistry)
            .build();
    }

    // -------------------------------------------------------------------------
    // Code registry helpers
    // -------------------------------------------------------------------------

    private void registerApolloFederationFetcher(GraphQLCodeRegistry.Builder codeRegistry) {
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "_service"),
            (DataFetcher<Object>) env -> Map.of("sdl", new SchemaPrinter().print(env.getGraphQLSchema())));
    }

    private void registerQueryFetchers(
            GraphQLCodeRegistry.Builder codeRegistry,
            Map<Class<?>, List<QueryDefinition>> queriesByEntity,
            DataFetcherProvider fetchers) {

        for (var entry : queriesByEntity.entrySet()) {
            String entityName = entry.getKey().getSimpleName();
            String queriesTypeName = entityName + "Queries";
            String fieldName = pluralize(CaseFormat.UPPER_CAMEL.to(CaseFormat.LOWER_CAMEL, entityName));

            codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", fieldName), fetchers.namespace());

            for (QueryDefinition qd : entry.getValue()) {
                DataFetcher<?> fetcher = qd.getQueryType() == QueryDefinition.QueryType.CONNECTION
                    ? fetchers.connection(qd) : fetchers.query(qd);
                codeRegistry.dataFetcher(FieldCoordinates.coordinates(queriesTypeName, qd.getName()), fetcher);
            }
        }
    }

    private void registerMutationFetchers(
            GraphQLCodeRegistry.Builder codeRegistry,
            Map<Class<?>, List<MutationDefinition>> mutationsByEntity,
            DataFetcherProvider fetchers) {

        for (var entry : mutationsByEntity.entrySet()) {
            String entityName = entry.getKey().getSimpleName();
            String mutationsTypeName = entityName + "Mutations";
            String fieldName = pluralize(CaseFormat.UPPER_CAMEL.to(CaseFormat.LOWER_CAMEL, entityName));

            codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", fieldName), fetchers.namespace());

            for (MutationDefinition md : entry.getValue()) {
                codeRegistry.dataFetcher(
                    FieldCoordinates.coordinates(mutationsTypeName, md.getName()),
                    fetchers.mutation(md));
            }
        }
    }

    private void registerRelationFetchers(
            GraphQLCodeRegistry.Builder codeRegistry,
            List<TypeDefinition> typeDefs,
            DataFetcherProvider fetchers) {

        for (TypeDefinition typeDef : typeDefs) {
            String typeName = resolveTypeName(typeDef);
            EntityMetadata metadata = metadataRegistry.getMetadata(typeDef.getEntityClass());
            for (TypeDefinition.RelationFieldDefinition relField : typeDef.getRelationFields()) {
                RelationMetadata rel = metadata.getRelation(relField.fieldName());
                if (rel != null) {
                    codeRegistry.dataFetcher(
                        FieldCoordinates.coordinates(typeName, relField.fieldName()),
                        fetchers.relation(typeName, rel));
                }
            }
        }
    }

    /**
     * Registers fetchers for the hand-rolled GlobalProperty query/mutation fields (see {@link
     * #buildGlobalPropertyTypes()}). {@code fetchers} is the concrete {@link DynamicDataFetchers}
     * (not the generic {@link DataFetcherProvider} interface) because these methods aren't part of
     * that interface — they're one-off additions for the one entity that doesn't fit the generic,
     * id-keyed CRUD model.
     */
    private void registerGlobalPropertyFetchers(GraphQLCodeRegistry.Builder codeRegistry, DynamicDataFetchers fetchers) {
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "globalProperties"), fetchers.namespace());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("GlobalPropertyQueries", "list"), fetchers.globalPropertyList());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("GlobalPropertyQueries", "globalProperty"), fetchers.globalProperty());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "globalProperties"), fetchers.namespace());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("GlobalPropertyMutations", "updateGlobalProperty"), fetchers.updateGlobalProperty());
    }

    // -------------------------------------------------------------------------
    // Type builders
    // -------------------------------------------------------------------------

    private GraphQLObjectType buildPageInfoType() {
        return newObject().name("ConnectionPageInfo")
            .field(newFieldDefinition().name("total").type(GraphQLNonNull.nonNull(GraphQLInt))
                .description("The total number of nodes, ignoring pagination"))
            .field(newFieldDefinition().name("nextPageOffset").type(GraphQLInt)
                .description("Offset for getting next page of nodes"))
            .field(newFieldDefinition().name("hasNextPage").type(GraphQLNonNull.nonNull(GraphQLBoolean))
                .description("Flag that indicates whether there are more nodes"))
            .build();
    }

    /**
     * Hand-rolled schema for {@code global_properties}: a generic name/type/value settings table,
     * keyed by {@code name} rather than the conventional numeric {@code id} the rest of this builder
     * assumes (see {@link #buildObjectType}, which always adds an {@code id: ID!} field). Since the
     * reflective entity-metadata system can't represent that, these types, and the query/mutation
     * root fields that expose them (see {@link #addGlobalPropertyQueryField} /
     * {@link #addGlobalPropertyMutationField}), are built directly instead of going through {@code
     * SchemaDefinition}/{@code TypeDefinition} — mirroring how {@code ConnectionPageInfo} and the
     * Apollo Federation {@code _service} field are hand-added above.
     */
    private void buildGlobalPropertyTypes() {
        GraphQLObjectType globalPropertyType = newObject().name("GlobalProperty")
            .field(newFieldDefinition().name("name").type(GraphQLNonNull.nonNull(GraphQLID))
                .description("Property name (primary key)"))
            .field(newFieldDefinition().name("type").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("How to interpret value: INTEGER, DECIMAL, STRING, BOOLEAN or ENUM"))
            .field(newFieldDefinition().name("value").type(GraphQLNonNull.nonNull(GraphQLString)))
            .build();
        builtTypes.put("GlobalProperty", globalPropertyType);

        GraphQLObjectType globalPropertyQueries = newObject().name("GlobalPropertyQueries")
            .field(newFieldDefinition().name("list")
                .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("GlobalProperty"))))))
            .field(newFieldDefinition().name("globalProperty")
                .type(GraphQLTypeReference.typeRef("GlobalProperty"))
                .argument(newArgument().name("name").type(GraphQLNonNull.nonNull(GraphQLID))))
            .build();
        builtTypes.put("GlobalPropertyQueries", globalPropertyQueries);

        GraphQLEnumType errorStatusEnum = newEnum().name("UpdateGlobalPropertyErrorStatus")
            .value("GLOBALPROPERTY_NOT_FOUND", "GLOBALPROPERTY_NOT_FOUND", "Property not found")
            .value("INVALID_VALUE", "INVALID_VALUE", "Value doesn't match the property's declared type")
            .value("INTERNAL_SERVER_ERROR", "INTERNAL_SERVER_ERROR", "Unexpected server error")
            .build();
        builtEnumTypes.put("UpdateGlobalPropertyErrorStatus", errorStatusEnum);

        GraphQLObjectType updateResponse = newObject().name("UpdateGlobalPropertyResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean))
                .description("Flag that indicates whether the operation was successful"))
            .field(newFieldDefinition().name("errorStatus").type(GraphQLTypeReference.typeRef("UpdateGlobalPropertyErrorStatus"))
                .description("Indicates the type of error"))
            .build();
        builtTypes.put("UpdateGlobalPropertyResponse", updateResponse);

        GraphQLObjectType globalPropertyMutations = newObject().name("GlobalPropertyMutations")
            .field(newFieldDefinition().name("updateGlobalProperty")
                .type(GraphQLTypeReference.typeRef("UpdateGlobalPropertyResponse"))
                .argument(newArgument().name("name").type(GraphQLNonNull.nonNull(GraphQLID)))
                .argument(newArgument().name("value").type(GraphQLNonNull.nonNull(GraphQLString))))
            .build();
        builtTypes.put("GlobalPropertyMutations", globalPropertyMutations);
    }

    private void addGlobalPropertyQueryField(GraphQLObjectType.Builder queryBuilder) {
        queryBuilder.field(newFieldDefinition().name("globalProperties")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("GlobalPropertyQueries"))));
    }

    private void addGlobalPropertyMutationField(GraphQLObjectType.Builder mutationBuilder) {
        mutationBuilder.field(newFieldDefinition().name("globalProperties")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("GlobalPropertyMutations"))));
    }

    /**
     * Hand-rolled schema for authentication and user/group/permission management (see
     * {@code org.lnu.timetable.security.AuthDataFetchers}). Like {@link #buildGlobalPropertyTypes()},
     * this bypasses the reflective entity-metadata system entirely — a {@code User}'s password hash
     * must never be reachable through the fully-generic query/mutation machinery, and operations
     * like {@code login} or {@code grantPermission} don't fit the generic id-keyed CRUD shape.
     */
    private void buildAuthTypes() {
        GraphQLObjectType userType = newObject().name("User")
            .field(newFieldDefinition().name("id").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("email").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("firstName").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("lastName").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("mustChangePassword").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("isActive").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("groups").type(GraphQLNonNull.nonNull(
                GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("Group"))))))
            .build();
        builtTypes.put("User", userType);

        GraphQLObjectType groupType = newObject().name("Group")
            .field(newFieldDefinition().name("id").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("name").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("description").type(GraphQLString))
            .field(newFieldDefinition().name("members").type(GraphQLNonNull.nonNull(
                GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("User"))))))
            .build();
        builtTypes.put("Group", groupType);

        GraphQLObjectType permissionGrantType = newObject().name("PermissionGrant")
            .field(newFieldDefinition().name("id").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("granteeType").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("USER or GROUP"))
            .field(newFieldDefinition().name("user").type(GraphQLTypeReference.typeRef("User")))
            .field(newFieldDefinition().name("group").type(GraphQLTypeReference.typeRef("Group")))
            .field(newFieldDefinition().name("resourceType").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("The entity type this grant covers (e.g. FACULTY), or GLOBAL for full admin access"))
            .field(newFieldDefinition().name("resourceId").type(GraphQLID))
            .field(newFieldDefinition().name("resourceLabel").type(GraphQLString)
                .description("Best-effort human-readable label for the target resource"))
            .field(newFieldDefinition().name("grantedBy").type(GraphQLTypeReference.typeRef("User")))
            .build();
        builtTypes.put("PermissionGrant", permissionGrantType);

        GraphQLObjectType currentUserType = newObject().name("CurrentUser")
            .field(newFieldDefinition().name("id").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("email").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("firstName").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("lastName").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("mustChangePassword").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("isAdmin").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("groups").type(GraphQLNonNull.nonNull(
                GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("Group"))))))
            .field(newFieldDefinition().name("permissions").type(GraphQLNonNull.nonNull(
                GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("PermissionGrant"))))))
            .build();
        builtTypes.put("CurrentUser", currentUserType);

        GraphQLEnumType loginErrorEnum = newEnum().name("LoginErrorStatus")
            .value("INVALID_CREDENTIALS", "INVALID_CREDENTIALS", "Unknown email or wrong password")
            .value("ACCOUNT_DISABLED", "ACCOUNT_DISABLED", "The account has been deactivated")
            .build();
        builtEnumTypes.put("LoginErrorStatus", loginErrorEnum);

        builtTypes.put("LoginResponse", newObject().name("LoginResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("token").type(GraphQLString))
            .field(newFieldDefinition().name("mustChangePassword").type(GraphQLBoolean))
            .field(newFieldDefinition().name("errorStatus").type(GraphQLTypeReference.typeRef("LoginErrorStatus")))
            .build());

        GraphQLEnumType changePasswordErrorEnum = newEnum().name("ChangePasswordErrorStatus")
            .value("INVALID_CURRENT_PASSWORD", "INVALID_CURRENT_PASSWORD", "Current password doesn't match")
            .value("WEAK_PASSWORD", "WEAK_PASSWORD", "New password is too short (minimum 8 characters)")
            .build();
        builtEnumTypes.put("ChangePasswordErrorStatus", changePasswordErrorEnum);

        builtTypes.put("ChangePasswordResponse", newObject().name("ChangePasswordResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("errorStatus").type(GraphQLTypeReference.typeRef("ChangePasswordErrorStatus")))
            .build());

        GraphQLEnumType createUserErrorEnum = newEnum().name("CreateUserErrorStatus")
            .value("DUPLICATE_EMAIL", "DUPLICATE_EMAIL", "A user with this email already exists")
            .build();
        builtEnumTypes.put("CreateUserErrorStatus", createUserErrorEnum);

        builtTypes.put("CreateUserResponse", newObject().name("CreateUserResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("data").type(GraphQLTypeReference.typeRef("User")))
            .field(newFieldDefinition().name("errorStatus").type(GraphQLTypeReference.typeRef("CreateUserErrorStatus")))
            .build());

        GraphQLEnumType createGroupErrorEnum = newEnum().name("CreateGroupErrorStatus")
            .value("DUPLICATE_NAME", "DUPLICATE_NAME", "A group with this name already exists")
            .build();
        builtEnumTypes.put("CreateGroupErrorStatus", createGroupErrorEnum);

        builtTypes.put("CreateGroupResponse", newObject().name("CreateGroupResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("data").type(GraphQLTypeReference.typeRef("Group")))
            .field(newFieldDefinition().name("errorStatus").type(GraphQLTypeReference.typeRef("CreateGroupErrorStatus")))
            .build());

        builtTypes.put("SimpleResponse", newObject().name("SimpleResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("errorStatus").type(GraphQLString))
            .build());
    }

    private void addAuthQueryFields(GraphQLObjectType.Builder queryBuilder) {
        queryBuilder.field(newFieldDefinition().name("me").type(GraphQLTypeReference.typeRef("CurrentUser"))
            .description("The signed-in user, or null if not authenticated"));
        queryBuilder.field(newFieldDefinition().name("users")
            .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("User")))))
            .description("Administrator-only: all user accounts"));
        queryBuilder.field(newFieldDefinition().name("groups")
            .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("Group"))))));
        queryBuilder.field(newFieldDefinition().name("canModifyResources")
            .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLID))))
            .description("Given a resource type and a list of candidate ids, returns the subset the caller may modify")
            .argument(newArgument().name("resourceType").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("resourceIds").type(GraphQLNonNull.nonNull(
                GraphQLList.list(GraphQLNonNull.nonNull(GraphQLID))))));
        queryBuilder.field(newFieldDefinition().name("grantsForResource")
            .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("PermissionGrant")))))
            .description("Lists who currently has modify access granted directly on this resource; requires the " +
                "caller to already be able to manage grants on it themselves (see grantPermission)")
            .argument(newArgument().name("resourceType").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("resourceId").type(GraphQLID)));
    }

    private void addAuthMutationFields(GraphQLObjectType.Builder mutationBuilder) {
        mutationBuilder.field(newFieldDefinition().name("login").type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("LoginResponse")))
            .argument(newArgument().name("email").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("password").type(GraphQLNonNull.nonNull(GraphQLString))));

        mutationBuilder.field(newFieldDefinition().name("changePassword").type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("ChangePasswordResponse")))
            .argument(newArgument().name("currentPassword").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("newPassword").type(GraphQLNonNull.nonNull(GraphQLString))));

        mutationBuilder.field(newFieldDefinition().name("createUser").type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("CreateUserResponse")))
            .description("Administrator-only: creates a user with a temporary password they must change on first login")
            .argument(newArgument().name("email").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("firstName").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("lastName").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("temporaryPassword").type(GraphQLNonNull.nonNull(GraphQLString))));

        mutationBuilder.field(newFieldDefinition().name("setUserActive").type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("SimpleResponse")))
            .description("Administrator-only: activates or deactivates a user account")
            .argument(newArgument().name("userId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .argument(newArgument().name("active").type(GraphQLNonNull.nonNull(GraphQLBoolean))));

        mutationBuilder.field(newFieldDefinition().name("createGroup").type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("CreateGroupResponse")))
            .description("Administrator-only")
            .argument(newArgument().name("name").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("description").type(GraphQLString)));

        mutationBuilder.field(newFieldDefinition().name("addUserToGroup").type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("SimpleResponse")))
            .description("Administrator-only")
            .argument(newArgument().name("userId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .argument(newArgument().name("groupId").type(GraphQLNonNull.nonNull(GraphQLID))));

        mutationBuilder.field(newFieldDefinition().name("removeUserFromGroup").type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("SimpleResponse")))
            .description("Administrator-only")
            .argument(newArgument().name("userId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .argument(newArgument().name("groupId").type(GraphQLNonNull.nonNull(GraphQLID))));

        mutationBuilder.field(newFieldDefinition().name("grantPermission").type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("SimpleResponse")))
            .description("Grants modify access on a resource to a user or group; requires the caller to already " +
                "be able to modify that resource themselves (or be an administrator)")
            .argument(newArgument().name("granteeType").type(GraphQLNonNull.nonNull(GraphQLString)).description("USER or GROUP"))
            .argument(newArgument().name("userId").type(GraphQLID))
            .argument(newArgument().name("groupId").type(GraphQLID))
            .argument(newArgument().name("resourceType").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("resourceId").type(GraphQLID).description("Omit (null) only when resourceType is GLOBAL")));

        mutationBuilder.field(newFieldDefinition().name("revokePermission").type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("SimpleResponse")))
            .argument(newArgument().name("permissionId").type(GraphQLNonNull.nonNull(GraphQLID))));
    }

    private void registerAuthFetchers(GraphQLCodeRegistry.Builder codeRegistry, AuthDataFetchers fetchers) {
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "me"), fetchers.me());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "users"), fetchers.users());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "groups"), fetchers.groups());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "canModifyResources"), fetchers.canModifyResources());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "grantsForResource"), fetchers.grantsForResource());

        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "login"), fetchers.login());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "changePassword"), fetchers.changePassword());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "createUser"), fetchers.createUser());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "setUserActive"), fetchers.setUserActive());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "createGroup"), fetchers.createGroup());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "addUserToGroup"), fetchers.addUserToGroup());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "removeUserFromGroup"), fetchers.removeUserFromGroup());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "grantPermission"), fetchers.grantPermission());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "revokePermission"), fetchers.revokePermission());

        codeRegistry.dataFetcher(FieldCoordinates.coordinates("User", "groups"), fetchers.userGroupsField());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Group", "members"), fetchers.groupMembersField());
        // Note: CurrentUser.groups/permissions are pre-resolved directly into the map returned by
        // AuthDataFetchers#me() (no extra round trip needed), so no explicit fetcher is registered
        // for them here — the default PropertyDataFetcher reads them straight off that map.
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("PermissionGrant", "user"), fetchers.grantUserField());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("PermissionGrant", "group"), fetchers.grantGroupField());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("PermissionGrant", "grantedBy"), fetchers.grantGrantedByField());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("PermissionGrant", "resourceLabel"), fetchers.grantResourceLabelField());
    }

    private void buildObjectType(TypeDefinition typeDef) {
        EntityMetadata metadata = metadataRegistry.getMetadata(typeDef.getEntityClass());
        String typeName = resolveTypeName(typeDef);

        GraphQLObjectType.Builder builder = newObject().name(typeName);

        // Always include id
        builder.field(newFieldDefinition().name("id").type(GraphQLNonNull.nonNull(GraphQLID)));

        List<String> fieldsToInclude = typeDef.isIncludeAllFields()
            ? metadata.selectableColumns()
            : typeDef.getIncludedFields();

        for (String fieldName : fieldsToInclude) {
            EntityFieldMetadata fieldMeta = metadata.getField(fieldName);
            if (fieldMeta != null) {
                GraphQLOutputType gqlType = mapJavaTypeToGraphQL(fieldMeta.type());
                if (!fieldMeta.nullable()) {
                    gqlType = GraphQLNonNull.nonNull(gqlType);
                }
                var fieldBuilder = newFieldDefinition().name(fieldName).type(gqlType);
                if (fieldMeta.description() != null) {
                    fieldBuilder.description(fieldMeta.description());
                }
                builder.field(fieldBuilder);
            }
        }

        // Add relation fields
        for (TypeDefinition.RelationFieldDefinition relField : typeDef.getRelationFields()) {
            RelationMetadata rel = metadata.getRelation(relField.fieldName());
            if (rel != null) {
                String targetTypeName = relField.targetTypeName() != null
                    ? relField.targetTypeName()
                    : rel.targetEntity().getSimpleName();
                GraphQLTypeReference typeRef = GraphQLTypeReference.typeRef(targetTypeName);

                if (rel.type() == RelationType.ONE_TO_MANY || rel.type() == RelationType.MANY_TO_MANY) {
                    builder.field(newFieldDefinition().name(relField.fieldName())
                        .type(GraphQLList.list(GraphQLNonNull.nonNull(typeRef))));
                } else {
                    GraphQLOutputType relType = relField.nullable() ? typeRef : GraphQLNonNull.nonNull(typeRef);
                    builder.field(newFieldDefinition().name(relField.fieldName()).type(relType));
                }
            }
        }

        builtTypes.put(typeName, builder.build());
    }

    private void buildConnectionType(QueryDefinition queryDef) {
        String entityName = queryDef.getReturnTypeName() != null
            ? queryDef.getReturnTypeName()
            : queryDef.getEntityClass().getSimpleName();
        String connectionTypeName = entityName + "Connection";

        if (builtTypes.containsKey(connectionTypeName)) return;

        GraphQLObjectType connectionType = newObject().name(connectionTypeName)
            .field(newFieldDefinition().name("nodes")
                .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(
                    GraphQLTypeReference.typeRef(entityName))))))
            .field(newFieldDefinition().name("pageInfo")
                .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("ConnectionPageInfo"))))
            .build();

        builtTypes.put(connectionTypeName, connectionType);
    }

    private void buildMutationTypes(MutationDefinition mutDef) {
        EntityMetadata metadata = metadataRegistry.getMetadata(mutDef.getEntityClass());
        String entityName = mutDef.getEntityClass().getSimpleName();

        // Build error status enum if there are error statuses
        if (!mutDef.getErrorStatuses().isEmpty()) {
            String enumName = capitalize(mutDef.getName()) + "ErrorStatus";
            if (!builtEnumTypes.containsKey(enumName)) {
                var enumBuilder = newEnum().name(enumName);
                for (MutationDefinition.ErrorStatus es : mutDef.getErrorStatuses()) {
                    enumBuilder.value(es.name(), es.name(), es.description());
                }
                builtEnumTypes.put(enumName, enumBuilder.build());
            }
        }

        // Build input type for create/update
        if (mutDef.getMutationType() != MutationDefinition.MutationType.DELETE) {
            String inputTypeName = entityName + "InputPayload";
            boolean hasContent = !mutDef.getInputFields().isEmpty() || !mutDef.getNestedLists().isEmpty()
                || !mutDef.getManyToManyLists().isEmpty();
            if (!builtInputTypes.containsKey(inputTypeName) && hasContent) {
                var inputBuilder = newInputObject().name(inputTypeName);
                for (String fieldName : mutDef.getInputFields()) {
                    EntityFieldMetadata fieldMeta = metadata.getField(fieldName);
                    if (fieldMeta != null) {
                        GraphQLInputType inputType = mapJavaTypeToGraphQLInput(fieldMeta.type());
                        if (!fieldMeta.nullable()) {
                            inputType = GraphQLNonNull.nonNull(inputType);
                        }
                        inputBuilder.field(newInputObjectField().name(fieldName).type(inputType));
                    } else {
                        // Relation FK field (e.g. "facultyId") — nullable so optional relations are supported
                        inputBuilder.field(newInputObjectField().name(fieldName).type(GraphQLID));
                    }
                }
                for (MutationDefinition.NestedListDefinition nl : mutDef.getNestedLists()) {
                    String nestedTypeName = buildNestedInputType(nl);
                    inputBuilder.field(newInputObjectField().name(nl.fieldName())
                        .type(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef(nestedTypeName)))));
                }
                for (MutationDefinition.ManyToManyDefinition mm : mutDef.getManyToManyLists()) {
                    inputBuilder.field(newInputObjectField().name(mm.fieldName())
                        .type(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLID))));
                }
                builtInputTypes.put(inputTypeName, inputBuilder.build());
            }
        }
    }

    /**
     * Builds (once per child entity) the input type used for nested one-to-many list items, e.g.
     * {@code CurriculumItemHoursNestedInput}. Includes an optional {@code id} so updates can match
     * an item to an existing child row; see {@link MutationDefinition#nestedList}.
     */
    private String buildNestedInputType(MutationDefinition.NestedListDefinition nl) {
        String nestedTypeName = nl.childEntityClass().getSimpleName() + "NestedInput";
        if (builtInputTypes.containsKey(nestedTypeName)) {
            return nestedTypeName;
        }

        EntityMetadata childMetadata = metadataRegistry.getMetadata(nl.childEntityClass());
        var inputBuilder = newInputObject().name(nestedTypeName)
            .field(newInputObjectField().name("id").type(GraphQLID)
                .description("Existing row id to update; omit (or use an id that doesn't match an existing row) to create a new row"));

        for (String fieldName : nl.childInputFields()) {
            EntityFieldMetadata fieldMeta = childMetadata.getField(fieldName);
            if (fieldMeta != null) {
                GraphQLInputType inputType = mapJavaTypeToGraphQLInput(fieldMeta.type());
                if (!fieldMeta.nullable()) {
                    inputType = GraphQLNonNull.nonNull(inputType);
                }
                inputBuilder.field(newInputObjectField().name(fieldName).type(inputType));
            } else {
                inputBuilder.field(newInputObjectField().name(fieldName).type(GraphQLID));
            }
        }

        builtInputTypes.put(nestedTypeName, inputBuilder.build());
        return nestedTypeName;
    }

    private GraphQLFieldDefinition buildQueryField(QueryDefinition queryDef) {
        String entityName = queryDef.getReturnTypeName() != null
            ? queryDef.getReturnTypeName()
            : queryDef.getEntityClass().getSimpleName();

        return switch (queryDef.getQueryType()) {
            case FIND_BY_ID -> newFieldDefinition()
                .name(queryDef.getName())
                .type(GraphQLTypeReference.typeRef(entityName))
                .argument(newArgument().name("id").type(GraphQLNonNull.nonNull(GraphQLID)))
                .build();
            case CONNECTION -> {
                var connectionField = newFieldDefinition()
                    .name(queryDef.getName())
                    .type(GraphQLTypeReference.typeRef(entityName + "Connection"))
                    .argument(newArgument().name("limit").type(GraphQLNonNull.nonNull(GraphQLInt))
                        .defaultValueProgrammatic(queryDef.getDefaultLimit()))
                    .argument(newArgument().name("offset").type(GraphQLNonNull.nonNull(GraphQLInt))
                        .defaultValueProgrammatic(queryDef.getDefaultOffset()));
                for (QueryDefinition.FilterParam fp : queryDef.getFilters()) {
                    connectionField.argument(newArgument().name(fp.paramName()).type(GraphQLID)); // nullable
                }
                for (QueryDefinition.RelationFilter rf : queryDef.getRelationFilters()) {
                    GraphQLInputType argType = switch (rf.argType()) {
                        case ID_LIST -> GraphQLList.list(GraphQLNonNull.nonNull(GraphQLID));
                        case STRING -> GraphQLString;
                        case ID -> GraphQLID;
                    };
                    connectionField.argument(newArgument().name(rf.paramName()).type(argType)); // nullable
                }
                yield connectionField.build();
            }
            case LIST -> newFieldDefinition()
                .name(queryDef.getName())
                .type(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef(entityName))))
                .build();
        };
    }

    private GraphQLFieldDefinition buildMutationField(MutationDefinition mutDef) {
        String entityName = mutDef.getEntityClass().getSimpleName();
        String responseName = capitalize(mutDef.getName()) + "Response";

        // Build response type
        GraphQLObjectType.Builder responseBuilder = newObject().name(responseName)
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean))
                .description("Flag that indicates whether the operation was successful"));

        if (mutDef.getMutationType() == MutationDefinition.MutationType.CREATE) {
            responseBuilder.field(newFieldDefinition().name("data")
                .type(GraphQLTypeReference.typeRef(entityName))
                .description("Created " + entityName));
        }

        if (!mutDef.getErrorStatuses().isEmpty()) {
            String enumName = capitalize(mutDef.getName()) + "ErrorStatus";
            responseBuilder.field(newFieldDefinition().name("errorStatus")
                .type(GraphQLTypeReference.typeRef(enumName))
                .description("Indicates the type of error"));
        }

        builtTypes.put(responseName, responseBuilder.build());

        // Build mutation field with arguments
        var fieldBuilder = newFieldDefinition()
            .name(mutDef.getName())
            .type(GraphQLTypeReference.typeRef(responseName));

        if (mutDef.getMutationType() == MutationDefinition.MutationType.UPDATE ||
            mutDef.getMutationType() == MutationDefinition.MutationType.DELETE) {
            fieldBuilder.argument(newArgument().name("id").type(GraphQLNonNull.nonNull(GraphQLID)));
        }

        String inputTypeName = entityName + "InputPayload";
        if (builtInputTypes.containsKey(inputTypeName) &&
            mutDef.getMutationType() != MutationDefinition.MutationType.DELETE) {
            String argName = CaseFormat.UPPER_CAMEL.to(CaseFormat.LOWER_CAMEL, entityName);
            fieldBuilder.argument(newArgument().name(argName)
                .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef(inputTypeName))));
        }

        return fieldBuilder.build();
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private GraphQLOutputType mapJavaTypeToGraphQL(Class<?> type) {
        if (type == String.class) return GraphQLString;
        if (type == Long.class || type == long.class) return GraphQLID;
        if (type == Integer.class || type == int.class) return GraphQLInt;
        if (type == Boolean.class || type == boolean.class) return GraphQLBoolean;
        if (type == Double.class || type == double.class || type == Float.class || type == float.class) return GraphQLFloat;
        return GraphQLString;
    }

    private GraphQLInputType mapJavaTypeToGraphQLInput(Class<?> type) {
        if (type == String.class) return GraphQLString;
        if (type == Long.class || type == long.class) return GraphQLID;
        if (type == Integer.class || type == int.class) return GraphQLInt;
        if (type == Boolean.class || type == boolean.class) return GraphQLBoolean;
        if (type == Double.class || type == double.class || type == Float.class || type == float.class) return GraphQLFloat;
        return GraphQLString;
    }

    private String resolveTypeName(TypeDefinition typeDef) {
        return typeDef.getTypeName() != null ? typeDef.getTypeName() : typeDef.getEntityClass().getSimpleName();
    }

    private String capitalize(String s) {
        return s.substring(0, 1).toUpperCase() + s.substring(1);
    }

    private String pluralize(String word) {
        if (word.endsWith("y") && word.length() > 1 && "aeiou".indexOf(word.charAt(word.length() - 2)) < 0) {
            return word.substring(0, word.length() - 1) + "ies";
        }
        return word + "s";
    }
}
