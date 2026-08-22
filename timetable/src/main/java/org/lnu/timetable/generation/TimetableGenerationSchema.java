package org.lnu.timetable.generation;

import graphql.schema.FieldCoordinates;
import graphql.schema.GraphQLCodeRegistry;
import graphql.schema.GraphQLList;
import graphql.schema.GraphQLNonNull;
import graphql.schema.GraphQLObjectType;
import graphql.schema.GraphQLTypeReference;
import org.lnu.timetable.framework.schema.HandWrittenApi;
import org.lnu.timetable.framework.schema.SchemaTypeRegistry;
import org.springframework.stereotype.Component;

import static graphql.Scalars.GraphQLBoolean;
import static graphql.Scalars.GraphQLID;
import static graphql.Scalars.GraphQLInt;
import static graphql.Scalars.GraphQLString;
import static graphql.schema.GraphQLArgument.newArgument;
import static graphql.schema.GraphQLFieldDefinition.newFieldDefinition;
import static graphql.schema.GraphQLInputObjectField.newInputObjectField;
import static graphql.schema.GraphQLInputObjectType.newInputObject;
import static graphql.schema.GraphQLObjectType.newObject;

/**
 * One query that hands a solver everything it needs, and one mutation that takes the answer back.
 *
 * <h2>Why this is not the generated API</h2>
 *
 * Nothing here is a row keyed by an id, which is the shape the entity framework generates for. A
 * <em>class session</em> — the thing being scheduled — has no table: it is derived by arithmetic
 * from a workload's hours and the length of the semester, and there are between zero and four of
 * them per {@code lecturer_workloads} row. And the payload as a whole is a <em>view</em> assembled
 * across eleven tables with three different faculty paths through them, which no connection can
 * express and which the client currently assembles from nine round trips plus a browser-side merge.
 *
 * <p>That price is reasonable for a page somebody is looking at. It is not reasonable for a solver
 * that is about to spend an hour on the answer, and it is not available at all for the thing the
 * desktop generator does that the tab cannot: schedule <em>every</em> faculty at once, around one
 * another, rather than one faculty at a time around the others.
 *
 * <h2>The contract</h2>
 *
 * The payload mirrors the {@code SolverProblem} of {@code timetable-ui/src/app/timetable-solver.ts}
 * field for field, deliberately. The two are inputs to the same problem, and a shape that merely
 * resembled the client's would produce a timetable that differed from «Згенерувати розклад» for
 * reasons nobody could see.
 *
 * <p>{@code facultyId} is nullable and that is the whole feature: named, it is one faculty
 * scheduled around everybody else, exactly as the tab does it; omitted, it is the university, and
 * every class in the half-year is movable at once.
 */
@Component
public class TimetableGenerationSchema implements HandWrittenApi {

    private final TimetableGenerationDataFetchers fetchers;

    public TimetableGenerationSchema(TimetableGenerationDataFetchers fetchers) {
        this.fetchers = fetchers;
    }

    @Override
    public void buildTypes(SchemaTypeRegistry types) {
        types.object(newObject().name("GenFaculty")
            .field(newFieldDefinition().name("id").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("name").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("abbreviation").type(GraphQLString))
            .build());

        types.object(newObject().name("GenClassTime")
            .field(newFieldDefinition().name("id").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("setId").type(GraphQLNonNull.nonNull(GraphQLID))
                .description("The grid of bells this time belongs to — a workload may only be placed on its own"))
            .field(newFieldDefinition().name("ordinal").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("startTime").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("HH:MM. The end is this plus durationHours × academicHourMinutes — it is stored nowhere"))
            .build());

        types.object(newObject().name("GenRoomBuilding")
            .field(newFieldDefinition().name("roomId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("buildingId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .build());

        types.object(newObject().name("GenBuildingTravel")
            .field(newFieldDefinition().name("fromBuildingId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("toBuildingId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("minutes").type(GraphQLNonNull.nonNull(GraphQLInt))
                .description("Directed: the return leg is a row of its own and routinely differs"))
            .build());

        types.object(newObject().name("GenAbstractRoom")
            .field(newFieldDefinition().name("id").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("name").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("capacity").type(GraphQLInt)
                .description("A ceiling on the total students of everything sharing the place at once, not on classes"))
            .field(newFieldDefinition().name("buildingId").type(GraphQLID)
                .description("Null when the place has no address at all — then the flat abstractRoomTravelMinutes applies"))
            .build());

        types.object(newObject().name("GenPlacement")
            .field(newFieldDefinition().name("dayOfWeek").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("classStartTimeId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("roomId").type(GraphQLID))
            .field(newFieldDefinition().name("weekParity").type(GraphQLNonNull.nonNull(GraphQLString)))
            .build());

        types.object(newObject().name("GenRequirement")
            .description("One class session to place. Not a row: how many a workload needs is hours ÷ "
                + "(semesterDurationWeeks × durationHours), with a remainder of at least half becoming one biweekly class")
            .field(newFieldDefinition().name("key").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("workloadId::wk|bi::index — position-based, so it survives a reload"))
            .field(newFieldDefinition().name("workloadId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("entryId").type(GraphQLID)
                .description("The timetable_entries row this session already has, claimed positionally by ascending id"))
            .field(newFieldDefinition().name("courseName").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("hourType").type(GraphQLString))
            .field(newFieldDefinition().name("durationHours").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("classStartTimeSetId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("lecturerIds").type(idList()))
            .field(newFieldDefinition().name("groupIds").type(idList())
                .description("Every group actually attending: the workload's own plus every combined group's members"))
            .field(newFieldDefinition().name("roomIds").type(idList())
                .description("The union of lecturer_workload_rooms and the rooms of its room groups. "
                    + "EMPTY MEANS UNRESTRICTED — any room in `rooms` — not «nowhere»"))
            .field(newFieldDefinition().name("abstractRoomId").type(GraphQLID)
                .description("Replaces roomIds rather than joining it"))
            .field(newFieldDefinition().name("isOnline").type(GraphQLNonNull.nonNull(GraphQLBoolean))
                .description("Overrides everything else: an online class is held nowhere"))
            .field(newFieldDefinition().name("studentsCount").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("isBiweekly").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("current").type(GraphQLTypeReference.typeRef("GenPlacement")))
            .field(newFieldDefinition().name("locked").type(GraphQLNonNull.nonNull(GraphQLBoolean))
                .description("This caller may not move it. Reported rather than dropped, so the search "
                    + "schedules around the slot it still occupies"))
            .field(newFieldDefinition().name("facultyId").type(GraphQLID))
            .build());

        types.object(newObject().name("GenFixedEntry")
            .description("A class this run must schedule around and may never rewrite")
            .field(newFieldDefinition().name("id").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("dayOfWeek").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("weekParity").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("startTime").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("durationHours").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("lecturerIds").type(idList()))
            .field(newFieldDefinition().name("groupIds").type(idList()))
            .field(newFieldDefinition().name("roomId").type(GraphQLID))
            .field(newFieldDefinition().name("abstractRoomId").type(GraphQLID))
            .field(newFieldDefinition().name("isOnline").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("studentsCount").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .build());

        types.object(newObject().name("GenConstraint")
            .field(newFieldDefinition().name("type").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("NOT_BEFORE | NOT_AFTER | UNAVAILABLE | MAX_CLASSES_PER_DAY"))
            .field(newFieldDefinition().name("dayOfWeek").type(GraphQLInt)
                .description("Null = every day. A day-specific row overrides the every-day row of its type, "
                    + "except UNAVAILABLE, whose windows accumulate"))
            .field(newFieldDefinition().name("value").type(GraphQLNonNull.nonNull(GraphQLString)))
            .build());

        types.object(newObject().name("GenConstraintSet")
            .field(newFieldDefinition().name("subjectId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("constraints")
                .type(nonNullList(GraphQLTypeReference.typeRef("GenConstraint"))))
            .build());

        types.object(newObject().name("TimetableGenerationInput")
            .field(newFieldDefinition().name("academicHourMinutes").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("semesterDurationWeeks").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("semesterParity").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("abstractRoomTravelMinutes").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("universityCommuteMinutes").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("days").type(nonNullList(GraphQLInt)))
            .field(newFieldDefinition().name("faculties").type(nonNullList(GraphQLTypeReference.typeRef("GenFaculty"))))
            .field(newFieldDefinition().name("classTimes").type(nonNullList(GraphQLTypeReference.typeRef("GenClassTime"))))
            .field(newFieldDefinition().name("rooms").type(idList())
                .description("The rooms this run may schedule into freely — rooms.faculty_id, and nothing wider"))
            .field(newFieldDefinition().name("roomBuilding").type(nonNullList(GraphQLTypeReference.typeRef("GenRoomBuilding"))))
            .field(newFieldDefinition().name("buildingTravel").type(nonNullList(GraphQLTypeReference.typeRef("GenBuildingTravel"))))
            .field(newFieldDefinition().name("abstractRooms").type(nonNullList(GraphQLTypeReference.typeRef("GenAbstractRoom"))))
            .field(newFieldDefinition().name("requirements").type(nonNullList(GraphQLTypeReference.typeRef("GenRequirement"))))
            .field(newFieldDefinition().name("fixedEntries").type(nonNullList(GraphQLTypeReference.typeRef("GenFixedEntry"))))
            .field(newFieldDefinition().name("lecturerConstraints").type(nonNullList(GraphQLTypeReference.typeRef("GenConstraintSet"))))
            .field(newFieldDefinition().name("groupConstraints").type(nonNullList(GraphQLTypeReference.typeRef("GenConstraintSet"))))
            .field(newFieldDefinition().name("roomConstraints").type(nonNullList(GraphQLTypeReference.typeRef("GenConstraintSet"))))
            .build());

        types.input(newInputObject().name("GeneratedPlacementInput")
            .field(newInputObjectField().name("key").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newInputObjectField().name("workloadId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newInputObjectField().name("entryId").type(GraphQLID)
                .description("Set to update that row; omitted to create one"))
            .field(newInputObjectField().name("dayOfWeek").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newInputObjectField().name("classStartTimeId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newInputObjectField().name("roomId").type(GraphQLID))
            .field(newInputObjectField().name("weekParity").type(GraphQLNonNull.nonNull(GraphQLString)))
            .build());

        types.input(newInputObject().name("SaveGeneratedTimetableInput")
            .field(newInputObjectField().name("facultyId").type(GraphQLID))
            .field(newInputObjectField().name("mode").type(GraphQLString)
                .description("REPLACE or KEEP — reported back for the log; what is actually written is "
                    + "whatever the placement list says, because the generator has already decided"))
            .field(newInputObjectField().name("placements")
                .type(nonNullInputList(GraphQLTypeReference.typeRef("GeneratedPlacementInput"))))
            .field(newInputObjectField().name("deleteEntryIds").type(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLID)))
                .description("Rows to remove. Needs FULL over every workload in the batch, not EDIT"))
            .build());

        types.object(newObject().name("GeneratedPlacementRejection")
            .field(newFieldDefinition().name("key").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("reason").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("NO_EDIT_ACCESS | BAD_DAY_OF_WEEK | BAD_WEEK_PARITY | BELL_NOT_IN_WORKLOAD_SET"))
            .build());

        types.object(newObject().name("SaveGeneratedTimetableResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("created").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("updated").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("deleted").type(GraphQLNonNull.nonNull(GraphQLInt)))
            .field(newFieldDefinition().name("errorStatus").type(GraphQLString)
                .description("NO_DELETE_ACCESS when deletion was asked for without FULL over every "
                    + "workload involved, ENTRY_NOT_FOUND when a deleteEntryIds member names no row"))
            .field(newFieldDefinition().name("rejected")
                .type(nonNullList(GraphQLTypeReference.typeRef("GeneratedPlacementRejection")))
                .description("Named per class rather than failing the batch: one unreachable room must not "
                    + "turn an hour of search into «нічого не збережено»"))
            .build());
    }

    @Override
    public void addQueryFields(GraphQLObjectType.Builder queryBuilder) {
        queryBuilder.field(newFieldDefinition().name("timetableGenerationInput")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("TimetableGenerationInput")))
            .description("Everything a timetable solver needs, in one request: the class sessions to place, "
                + "the timetable around them, the bells, the places, the walks between корпуси and every "
                + "scheduling rule that applies. Omit facultyId to take the whole university at once")
            .argument(newArgument().name("facultyId").type(GraphQLID)
                .description("One faculty, scheduled around everybody else; omitted, the whole university"))
            .argument(newArgument().name("semesterParity").type(GraphQLString)
                .description("ODD or EVEN. Defaults to the current_semester_parity global property")));
    }

    @Override
    public void addMutationFields(GraphQLObjectType.Builder mutationBuilder) {
        mutationBuilder.field(newFieldDefinition().name("saveGeneratedTimetable")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("SaveGeneratedTimetableResponse")))
            .description("Writes a generated timetable back in one request. Each placement needs EDIT over "
                + "its workload and is checked against the workload's own grid of bells; a placement that "
                + "fails is reported by key and the rest still land")
            .argument(newArgument().name("input")
                .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("SaveGeneratedTimetableInput")))));
    }

    @Override
    public void registerFetchers(GraphQLCodeRegistry.Builder codeRegistry) {
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "timetableGenerationInput"),
            fetchers.generationInput());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "saveGeneratedTimetable"),
            fetchers.saveGeneratedTimetable());
    }

    private static graphql.schema.GraphQLOutputType idList() {
        return GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLID)));
    }

    private static graphql.schema.GraphQLOutputType nonNullList(graphql.schema.GraphQLOutputType of) {
        return GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(of)));
    }

    private static graphql.schema.GraphQLInputType nonNullInputList(graphql.schema.GraphQLInputType of) {
        return GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(of)));
    }
}
