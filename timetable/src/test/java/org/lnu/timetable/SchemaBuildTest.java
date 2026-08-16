package org.lnu.timetable;

import graphql.schema.DataFetcher;
import graphql.schema.GraphQLSchema;
import graphql.schema.idl.SchemaPrinter;
import org.junit.jupiter.api.Test;
import org.lnu.timetable.config.CurriculumSchemaConfig;
import org.lnu.timetable.config.OrganizationSchemaConfig;
import org.lnu.timetable.config.PeopleSchemaConfig;
import org.lnu.timetable.config.SchedulingSchemaConfig;
import org.lnu.timetable.framework.config.MutationDefinition;
import org.lnu.timetable.framework.config.QueryDefinition;
import org.lnu.timetable.framework.metadata.EntityMetadataRegistry;
import org.lnu.timetable.framework.metadata.PermissionTypeGraph;
import org.lnu.timetable.framework.metadata.RelationMetadata;
import org.lnu.timetable.framework.schema.DataFetcherProvider;
import org.lnu.timetable.framework.schema.DynamicGraphQLSchemaBuilder;
import org.lnu.timetable.security.AccessModelSchema;
import org.lnu.timetable.security.SelfServiceDataFetchers;
import org.lnu.timetable.security.SelfServiceSchema;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SchemaBuildTest {

    private final DataFetcherProvider noop = new DataFetcherProvider() {
        public DataFetcher<?> namespace() { return env -> new Object(); }
        public DataFetcher<?> query(QueryDefinition def) { return env -> null; }
        public DataFetcher<?> connection(QueryDefinition def) { return env -> null; }
        public DataFetcher<?> mutation(MutationDefinition def) { return env -> null; }
        public DataFetcher<?> relation(String ownerTypeName, RelationMetadata rel) { return env -> null; }
    };

    @Test
    void buildsTimetableSchema() {
        EntityMetadataRegistry registry = new EntityMetadataRegistry();
        DynamicGraphQLSchemaBuilder builder = new DynamicGraphQLSchemaBuilder(registry);

        GraphQLSchema schema = builder.buildSchema(
            List.of(
                new OrganizationSchemaConfig(),
                new CurriculumSchemaConfig(),
                new PeopleSchemaConfig(),
                new SchedulingSchemaConfig()
            ),
            noop, null, null, List.of(selfService(), new AccessModelSchema(new PermissionTypeGraph(registry)))
        );
        String sdl = new SchemaPrinter().print(schema);
        System.out.println(sdl);

        // Federation service
        assertTrue(sdl.contains("_service: _Service!"));
        // Query namespaces
        assertTrue(sdl.contains("buildings: BuildingQueries"));
        assertTrue(sdl.contains("degreePrograms: DegreeProgramQueries"));
        assertTrue(sdl.contains("lecturerWorkloads: LecturerWorkloadQueries"));
        assertTrue(sdl.contains("timetableEntries: TimetableEntryQueries"));
        assertTrue(sdl.contains("combinedGroups: CombinedGroupQueries"));
        // Many-to-many relations (list)
        assertTrue(sdl.contains("academicGroups: [AcademicGroup!]"));
        assertTrue(sdl.contains("combinedGroups: [CombinedGroup!]"));
        // Non-null to-one relations (a Student always belongs to an AcademicGroup;
        // a TimetableEntry always references a LecturerWorkload)
        assertTrue(sdl.contains("academicGroup: AcademicGroup!"));
        assertTrue(sdl.contains("workload: LecturerWorkload!"));
        // Connection shape
        assertTrue(sdl.contains("type LecturerWorkloadConnection"));
        assertTrue(sdl.contains("nodes: [LecturerWorkload!]!"));
        // Input payloads + mutations
        assertTrue(sdl.contains("createTimetableEntry"));
        assertTrue(sdl.contains("TimetableEntryInputPayload"));
        assertTrue(sdl.contains("workloadId: ID"));
        // Filter arguments on connection fields. SchemaPrinter sorts arguments alphabetically
        // regardless of the order they were declared in, and a relation filter (.relationFilter,
        // an EXISTS subquery) is printed exactly like a plain column filter — lecturerConnection's
        // facultyId below is one, reached through lecturers.department_id -> departments.faculty_id.
        assertTrue(sdl.contains("departmentConnection(facultyId: ID, limit: Int! = 1000, offset: Int! = 0)"));
        assertTrue(sdl.contains("degreeProgramConnection(facultyId: ID, limit: Int! = 1000, offset: Int! = 0)"));
        assertTrue(sdl.contains("lecturerConnection(departmentId: ID, facultyId: ID, limit: Int! = 1000, offset: Int! = 0)"));

        // The hand-written self-service area, reached through the HandWrittenApi plug-in point
        // rather than through anything hardcoded in the builder. Asserting the *printed* shape is
        // what makes this worth a test: every one of these fields refers to its types by
        // GraphQLTypeReference, and a reference naming a type nobody registered fails when the
        // schema is assembled — at application startup, which is where this test exists to avoid
        // finding out.
        assertTrue(sdl.contains("registrationLink(token: String!): AccountLinkCheck!"));
        assertTrue(sdl.contains("passwordResetLink(token: String!): AccountLinkCheck!"));
        assertTrue(sdl.contains("requestRegistration(email: String!): RegistrationRequestResponse!"));
        assertTrue(sdl.contains("completeRegistration(password: String!, token: String!): AccountLinkResponse!"));
        assertTrue(sdl.contains("requestPasswordReset(email: String!): PasswordResetRequestResponse!"));
        assertTrue(sdl.contains("resetPassword(password: String!, token: String!): AccountLinkResponse!"));
        assertTrue(sdl.contains("enum RegistrationRequestStatus"));
        assertTrue(sdl.contains("NOT_ELIGIBLE"));
        assertTrue(sdl.contains("enum PersonRole"));

        // The published permission cascade, and the two fields on `me` that are read against it.
        // Building the graph at all is half the assertion: PermissionTypeGraph is constructed from
        // the registry above, and EntityMetadataRegistry now refuses an entity that declares neither
        // a permission parent nor @PermissionRoot — so a forgotten edge fails here, in a test that
        // needs no database, rather than at the first denial in production.
        assertTrue(sdl.contains("accessModel: [ResourceTypeAccess!]!"));
        assertTrue(sdl.contains("type ResourceTypeAccess"));
        assertTrue(sdl.contains("isRoot: Boolean!"));
        assertTrue(sdl.contains("creatableResourceTypes: [String!]!"));
        assertTrue(sdl.contains("globalLevel: AccessLevel"));
    }

    /**
     * The cascade, read the way the client reads it. BUILDING is a declared {@code @PermissionRoot}
     * — the entity behind the bug this was written for, where a викладач holding one кафедра was
     * shown «Редагувати» on every корпус — so nothing but a GLOBAL grant may create one, and a grant
     * on a факультет must not put it within reach. A grant on a FACULTY, meanwhile, has to reach a
     * DEPARTMENT and everything under it, or half the client's screens would hide themselves from
     * the deanery who owns them.
     */
    @Test
    void publishesThePermissionCascadeByType() {
        PermissionTypeGraph graph = new PermissionTypeGraph(new EntityMetadataRegistry());

        assertTrue(graph.node("BUILDING").root());
        assertTrue(graph.node("ACADEMIC_DEGREE").root());
        assertFalse(graph.node("FACULTY").root());

        assertTrue(graph.coveredBy("FACULTY").contains("DEPARTMENT"));
        assertTrue(graph.coveredBy("FACULTY").contains("LECTURER_WORKLOAD"));
        assertFalse(graph.coveredBy("FACULTY").contains("BUILDING"));

        // Holding EDIT on a кафедра: лектори and their навантаження, yes; корпуси and факультети, no.
        assertTrue(graph.creatableFrom(List.of("DEPARTMENT")).contains("LECTURER"));
        assertFalse(graph.creatableFrom(List.of("DEPARTMENT")).contains("BUILDING"));
        assertFalse(graph.creatableFrom(List.of("DEPARTMENT")).contains("FACULTY"));
        // A root is never creatable from any grant — only from GLOBAL, which the caller handles.
        assertFalse(graph.creatableFrom(graph.allTypes()).contains("BUILDING"));
    }

    /**
     * The self-service area with nothing behind it. Building a schema only ever asks it for types,
     * field definitions and fetcher <em>lambdas</em> — none of which touch a repository, a mailer or
     * a signing key — so the five collaborators can all be null.
     * <p>
     * The four values that follow them are the {@code @Value}-injected settings, in order: the base
     * URL links would be built from, the token's lifetime in minutes, the per-address cooldown in
     * seconds, and the cap on links issued per minute across every address. None of them is read
     * while a schema is being built; they are here because this is the only constructor, and adding
     * a fifth setting to it breaks this line — which is the intended way to find out.
     */
    private SelfServiceSchema selfService() {
        return new SelfServiceSchema(new SelfServiceDataFetchers(
            null, null, null, null, null, "http://localhost", 30, 60, 20));
    }
}
