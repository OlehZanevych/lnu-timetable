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
            noop, null, null
        );
        String sdl = new SchemaPrinter().print(schema);
        System.out.println(sdl);

        // Federation service
        assertTrue(sdl.contains("_service: _Service!"));
        // Query namespaces
        assertTrue(sdl.contains("buildings: BuildingQueries"));
        assertTrue(sdl.contains("specialties: SpecialtyQueries"));
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
        // Filter arguments on connection fields (graphql-java prints arguments in alphabetical order)
        assertTrue(sdl.contains("departmentConnection(facultyId: ID, limit: Int! = 1000, offset: Int! = 0)"));
        assertTrue(sdl.contains("specialtyConnection(facultyId: ID, limit: Int! = 1000, offset: Int! = 0)"));
        assertTrue(sdl.contains("lecturerConnection(departmentId: ID, limit: Int! = 1000, offset: Int! = 0)"));
    }
}
