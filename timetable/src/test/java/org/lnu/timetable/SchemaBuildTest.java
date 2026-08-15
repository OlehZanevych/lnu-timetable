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
import org.lnu.timetable.framework.metadata.RelationMetadata;
import org.lnu.timetable.framework.schema.DataFetcherProvider;
import org.lnu.timetable.framework.schema.DynamicGraphQLSchemaBuilder;
import org.lnu.timetable.security.SelfServiceDataFetchers;
import org.lnu.timetable.security.SelfServiceSchema;

import java.util.List;

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
            noop, null, null, List.of(selfService())
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
    }

    /**
     * The self-service area with nothing behind it. Building a schema only ever asks it for types,
     * field definitions and fetcher <em>lambdas</em> — none of which touch a repository, a mailer or
     * a signing key — so the collaborators can all be null and the constructor's one real argument
     * is the base URL it would build links from.
     */
    private SelfServiceSchema selfService() {
        return new SelfServiceSchema(
            new SelfServiceDataFetchers(null, null, null, null, null, "http://localhost", 30, 60));
    }
}
