package org.lnu.timetable.security;

import graphql.schema.DataFetcher;
import graphql.schema.FieldCoordinates;
import graphql.schema.GraphQLCodeRegistry;
import graphql.schema.GraphQLList;
import graphql.schema.GraphQLNonNull;
import graphql.schema.GraphQLObjectType;
import graphql.schema.GraphQLTypeReference;
import org.lnu.timetable.framework.metadata.PermissionTypeGraph;
import org.lnu.timetable.framework.schema.HandWrittenApi;
import org.lnu.timetable.framework.schema.SchemaTypeRegistry;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static graphql.Scalars.GraphQLBoolean;
import static graphql.Scalars.GraphQLString;
import static graphql.schema.GraphQLFieldDefinition.newFieldDefinition;
import static graphql.schema.GraphQLObjectType.newObject;

/**
 * One query, {@code Query.accessModel}: the permission cascade as the client needs to read it.
 *
 * <h2>What it is for</h2>
 * The client hides what a user cannot do — an «+ Додати» it may not press, a page of nothing but
 * controls it may not use. Deciding that needs two things: what this caller holds (which
 * {@code Query.me} already answers, and now answers more precisely) and what the hierarchy looks
 * like, so that "may create a {@code ClassStartTime}" can be worked out from a grant on a факультет.
 * <p>
 * The second half used to have nowhere to come from, so the client either guessed — «holds a grant
 * somewhere, show every button» — or would have had to keep its own copy of the hierarchy in
 * TypeScript. A copy is the worse of the two: it is correct on the day it is written and silently
 * wrong the first time an entity is added, and nothing would fail until somebody saw a button that
 * did not work. Publishing the graph the server actually enforces means the two sides cannot
 * disagree, and that adding an entity keeps the client honest with no edit at all.
 *
 * <h2>Why it is a HandWrittenApi</h2>
 * It is not a row keyed by an id, so it cannot be generated; and it is metadata about the schema
 * rather than about the data, so it belongs beside the schema rather than inside any namespace. It
 * still requires a signed-in caller — the shape of the hierarchy is not secret, but nothing else in
 * this API answers an anonymous request either, and the exceptions to that
 * ({@code login}, the self-service fields) exist for people who cannot sign in yet, which is not
 * this.
 */
@Component
public class AccessModelSchema implements HandWrittenApi {

    private final PermissionTypeGraph typeGraph;

    public AccessModelSchema(PermissionTypeGraph typeGraph) {
        this.typeGraph = typeGraph;
    }

    @Override
    public void buildTypes(SchemaTypeRegistry types) {
        types.object(newObject().name("ResourceParent")
            .description("One upward foreign key, named as the create input names it")
            .field(newFieldDefinition().name("resourceType").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("field").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("The input field carrying this parent's id — faculty_id is sent as facultyId"))
            .field(newFieldDefinition().name("isNullable").type(GraphQLNonNull.nonNull(GraphQLBoolean))
                .description("Whether the column may be unset, in which case this path simply does not apply"))
            .build());

        types.object(newObject().name("ResourceTypeAccess")
            .description("One entity type, and where a grant covering it can sit. Derived from the "
                + "@PermissionParent / @PermissionJoinParent / @PermissionRoot annotations on the domain "
                + "classes — the same declarations the server authorizes writes with")
            .field(newFieldDefinition().name("resourceType").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("The value this entity takes in permissions.resource_type, e.g. WORKING_CURRICULUM_ITEM"))
            .field(newFieldDefinition().name("parents")
                .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(
                    GraphQLTypeReference.typeRef("ResourceParent")))))
                .description("Foreign keys on this entity's own table. These are the only edges a create can use: "
                    + "nothing points at a row that does not exist yet, so creating one needs EDIT on a parent "
                    + "named in the input"))
            .field(newFieldDefinition().name("joinParentResourceTypes")
                .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLString))))
                .description("Types reached through a join table. They cover rows that already exist — a grant on "
                    + "a Lecturer covers the workloads assigned to them — but never a create"))
            .field(newFieldDefinition().name("isRoot").type(GraphQLNonNull.nonNull(GraphQLBoolean))
                .description("Declared @PermissionRoot: nothing owns this, so only a GLOBAL grant reaches it. "
                    + "True for BUILDING and ACADEMIC_DEGREE"))
            .build());
    }

    @Override
    public void addQueryFields(GraphQLObjectType.Builder queryBuilder) {
        queryBuilder.field(newFieldDefinition().name("accessModel")
            .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(
                GraphQLTypeReference.typeRef("ResourceTypeAccess")))))
            .description("The permission cascade, by entity type. Constant for the lifetime of the service, so a "
                + "client fetches it once; combined with CurrentUser.permissions it answers every question about "
                + "which controls to draw, without the client keeping its own copy of the hierarchy"));
    }

    @Override
    public void registerFetchers(GraphQLCodeRegistry.Builder codeRegistry) {
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "accessModel"), accessModel());
    }

    /**
     * The graph, as maps. Computed once at startup by {@link PermissionTypeGraph} and merely shaped
     * here, so answering this costs no query and no walk.
     */
    private DataFetcher<?> accessModel() {
        return env -> {
            if (AuthorizingDataFetcherProvider.principalOf(env) == null) {
                throw new GraphQlAuthException("You must be signed in to do this.");
            }
            List<Map<String, Object>> rows = typeGraph.nodes().stream().map(node -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("resourceType", node.resourceType());
                m.put("parents", node.parentTypes().stream().map(parent -> {
                    Map<String, Object> pm = new LinkedHashMap<>();
                    pm.put("resourceType", parent.resourceType());
                    pm.put("field", parent.field());
                    pm.put("isNullable", parent.nullable());
                    return pm;
                }).toList());
                m.put("joinParentResourceTypes", node.joinParentTypes());
                m.put("isRoot", node.root());
                return m;
            }).toList();
            return rows;
        };
    }
}
