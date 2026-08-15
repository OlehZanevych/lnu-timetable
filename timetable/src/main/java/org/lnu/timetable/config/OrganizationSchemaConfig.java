package org.lnu.timetable.config;

import org.lnu.timetable.domain.*;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.config.SchemaDefinition;
import org.springframework.stereotype.Component;

/**
 * GraphQL types, queries and mutations for the core organizational entities:
 * Building, BuildingTravelTime, Faculty, Department, DegreeProgram, Room, RoomGroup, AbstractRoom.
 */
@Component
public class OrganizationSchemaConfig implements GraphQLSchemaConfig {

    @Override
    public void configure(SchemaDefinition s) {
        configureBuilding(s);
        configureBuildingTravelTime(s);
        configureFaculty(s);
        configureDepartment(s);
        configureDegreeProgram(s);
        configureRoom(s);
        configureRoomTimetableConstraint(s);
        configureRoomGroup(s);
        configureAbstractRoom(s);
    }

    // -------------------------------------------------------------------------
    // Building
    // -------------------------------------------------------------------------

    private void configureBuilding(SchemaDefinition s) {
        s.type(Building.class)
            .fields("name", "address", "city", "postalCode")
            .relation("rooms").relation("faculties");

        s.query("buildingConnection").entity(Building.class).connection().orderBy("name");
        s.query("building").entity(Building.class).findById();

        s.mutation("createBuilding").entity(Building.class).create()
            .inputFields("name", "address", "city", "postalCode")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateBuilding").entity(Building.class).update()
            .inputFields("name", "address", "city", "postalCode")
            .errorStatus("BUILDING_NOT_FOUND", "Building not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteBuilding").entity(Building.class).delete()
            .errorStatus("BUILDING_NOT_FOUND", "Building not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // Faculty
    // -------------------------------------------------------------------------

    /**
     * How long it takes to get from one корпус to another — see {@link BuildingTravelTime}.
     *
     * <p>The connection carries a filter on each end of the journey. The client's matrix reads the
     * whole table in one request and never uses either, but a caller asking "what does it cost to
     * leave this building?" — which is the question the scheduler will ask, once per group move —
     * should not have to fetch 342 rows to answer it.
     *
     * <p>Ordered by `from_building_id`: the rows come back grouped by where the journey starts,
     * which is the order a matrix fills its cells in.
     */
    private void configureBuildingTravelTime(SchemaDefinition s) {
        s.type(BuildingTravelTime.class)
            .fields("minutes")
            .relation("fromBuilding")
            .relation("toBuilding");

        s.query("buildingTravelTimeConnection").entity(BuildingTravelTime.class).connection()
            .orderBy("from_building_id")
            .filter("fromBuildingId", "from_building_id")
            .filter("toBuildingId", "to_building_id");
        s.query("buildingTravelTime").entity(BuildingTravelTime.class).findById();

        s.mutation("createBuildingTravelTime").entity(BuildingTravelTime.class).create()
            .inputFields("minutes", "fromBuildingId", "toBuildingId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateBuildingTravelTime").entity(BuildingTravelTime.class).update()
            .inputFields("minutes", "fromBuildingId", "toBuildingId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("BUILDING_TRAVEL_TIME_NOT_FOUND", "Building travel time not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteBuildingTravelTime").entity(BuildingTravelTime.class).delete()
            .errorStatus("BUILDING_TRAVEL_TIME_NOT_FOUND", "Building travel time not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    private void configureFaculty(SchemaDefinition s) {
        s.type(Faculty.class)
            .fields("name", "abbreviation", "website", "email", "phone")
            .nullableRelation("building")
            .relation("departments").relation("degreePrograms").relation("rooms");

        s.query("facultyConnection").entity(Faculty.class).connection().orderBy("name");
        s.query("faculty").entity(Faculty.class).findById();

        s.mutation("createFaculty").entity(Faculty.class).create()
            .inputFields("name", "abbreviation", "website", "email", "phone", "buildingId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateFaculty").entity(Faculty.class).update()
            .inputFields("name", "abbreviation", "website", "email", "phone", "buildingId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("FACULTY_NOT_FOUND", "Faculty not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteFaculty").entity(Faculty.class).delete()
            .errorStatus("FACULTY_NOT_FOUND", "Faculty not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // Department
    // -------------------------------------------------------------------------

    private void configureDepartment(SchemaDefinition s) {
        s.type(Department.class)
            .fields("name", "abbreviation", "email", "phone")
            .relation("faculty").relation("lecturers").relation("courses");

        s.query("departmentConnection").entity(Department.class).connection().orderBy("name").filter("facultyId", "faculty_id");
        s.query("department").entity(Department.class).findById();

        s.mutation("createDepartment").entity(Department.class).create()
            .inputFields("name", "abbreviation", "email", "phone", "facultyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateDepartment").entity(Department.class).update()
            .inputFields("name", "abbreviation", "email", "phone", "facultyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DEPARTMENT_NOT_FOUND", "Department not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteDepartment").entity(Department.class).delete()
            .errorStatus("DEPARTMENT_NOT_FOUND", "Department not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // DegreeProgram
    // -------------------------------------------------------------------------

    private void configureDegreeProgram(SchemaDefinition s) {
        s.type(DegreeProgram.class)
            .fields("code", "name", "degree")
            .relation("faculty").relation("groups");

        s.query("degreeProgramConnection").entity(DegreeProgram.class).connection().orderBy("code").filter("facultyId", "faculty_id");
        s.query("degreeProgram").entity(DegreeProgram.class).findById();

        s.mutation("createDegreeProgram").entity(DegreeProgram.class).create()
            .inputFields("code", "name", "degree", "facultyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateDegreeProgram").entity(DegreeProgram.class).update()
            .inputFields("code", "name", "degree", "facultyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DEGREE_PROGRAM_NOT_FOUND", "Degree programme not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteDegreeProgram").entity(DegreeProgram.class).delete()
            .errorStatus("DEGREE_PROGRAM_NOT_FOUND", "Degree programme not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // Room
    // -------------------------------------------------------------------------

    private void configureRoom(SchemaDefinition s) {
        s.type(Room.class)
            .fields("number", "name", "capacity", "kind")
            .nullableRelation("faculty")
            .nullableRelation("building")
            .relation("timetableConstraints");

        s.query("roomConnection").entity(Room.class).connection().orderBy("number")
            .filter("facultyId", "faculty_id")
            .filter("buildingId", "building_id");
        s.query("room").entity(Room.class).findById();

        s.mutation("createRoom").entity(Room.class).create()
            .inputFields("number", "name", "capacity", "kind", "facultyId", "buildingId")
            .nestedList("timetableConstraints", RoomTimetableConstraint.class, "roomId",
                "constraintType", "dayOfWeek", "constraintValue")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateRoom").entity(Room.class).update()
            .inputFields("number", "name", "capacity", "kind", "facultyId", "buildingId")
            .nestedList("timetableConstraints", RoomTimetableConstraint.class, "roomId",
                "constraintType", "dayOfWeek", "constraintValue")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("ROOM_NOT_FOUND", "Room not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteRoom").entity(Room.class).delete()
            .errorStatus("ROOM_NOT_FOUND", "Room not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // RoomGroup
    // -------------------------------------------------------------------------

    /**
     * A reusable set of rooms a workload can point at instead of naming rooms one by one.
     *
     * `facultyId` and `departmentId` scope the group; they are mutually exclusive, and the database
     * rejects a row that sets both (room_groups_scope_check) rather than the check living here —
     * it is a condition on the row, and the client filters the list it offers accordingly.
     *
     * Note the connection's `facultyId` filter matches the column exactly, so it returns *only*
     * that faculty's groups — not the university-wide ones a caller almost always wants as well.
     * Clients that need both fetch unfiltered and narrow client-side, as LecturerWorkloadList does.
     */
    /** As LecturerTimetableConstraint: a type only, written through Room's nestedList. */
    private void configureRoomTimetableConstraint(SchemaDefinition s) {
        s.type(RoomTimetableConstraint.class)
            .fields("constraintType", "dayOfWeek", "constraintValue");
    }

    // -------------------------------------------------------------------------
    // RoomGroup
    // -------------------------------------------------------------------------

    private void configureRoomGroup(SchemaDefinition s) {
        s.type(RoomGroup.class)
            .fields("name", "purpose")
            .nullableRelation("faculty")
            .nullableRelation("department")
            .relation("rooms")
            .relation("workloads");

        s.query("roomGroupConnection").entity(RoomGroup.class).connection().orderBy("name")
            .filter("facultyId", "faculty_id")
            .filter("departmentId", "department_id");
        s.query("roomGroup").entity(RoomGroup.class).findById();

        s.mutation("createRoomGroup").entity(RoomGroup.class).create()
            .inputFields("name", "purpose", "facultyId", "departmentId")
            .manyToMany("roomIds", "room_group_rooms", "room_group_id", "room_id")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateRoomGroup").entity(RoomGroup.class).update()
            .inputFields("name", "purpose", "facultyId", "departmentId")
            .manyToMany("roomIds", "room_group_rooms", "room_group_id", "room_id")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("ROOMGROUP_NOT_FOUND", "RoomGroup not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteRoomGroup").entity(RoomGroup.class).delete()
            .errorStatus("ROOMGROUP_NOT_FOUND", "RoomGroup not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // AbstractRoom
    // -------------------------------------------------------------------------

    /**
     * A place that is not a room — «Спортивні зали» and the like, which several classes share in
     * one slot without that being a clash. Declared beside Room and shaped like it, and separate
     * from it for exactly the reason {@link AbstractRoom} gives: everything that reasons about room
     * exclusivity reads `rooms` and must not see these.
     *
     * `facultyId` scopes the entry the way it scopes a room group, and matches the column exactly —
     * so, as there, it returns that faculty's entries and not the university-wide ones a caller
     * usually wants as well.
     */
    private void configureAbstractRoom(SchemaDefinition s) {
        s.type(AbstractRoom.class)
            .fields("name", "purpose", "capacity")
            .nullableRelation("building")
            .nullableRelation("faculty")
            .relation("workloads");

        s.query("abstractRoomConnection").entity(AbstractRoom.class).connection().orderBy("name")
            .filter("facultyId", "faculty_id")
            .filter("buildingId", "building_id");
        s.query("abstractRoom").entity(AbstractRoom.class).findById();

        s.mutation("createAbstractRoom").entity(AbstractRoom.class).create()
            .inputFields("name", "purpose", "capacity", "facultyId", "buildingId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateAbstractRoom").entity(AbstractRoom.class).update()
            .inputFields("name", "purpose", "capacity", "facultyId", "buildingId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("ABSTRACTROOM_NOT_FOUND", "AbstractRoom not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteAbstractRoom").entity(AbstractRoom.class).delete()
            .errorStatus("ABSTRACTROOM_NOT_FOUND", "AbstractRoom not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }
}
