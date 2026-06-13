package org.lnu.timetable.config;

import org.lnu.timetable.domain.*;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.config.SchemaDefinition;
import org.springframework.stereotype.Component;

/**
 * GraphQL types, queries and mutations for the core organizational entities:
 * Building, Faculty, Department, Specialty, Room.
 */
@Component
public class OrganizationSchemaConfig implements GraphQLSchemaConfig {

    @Override
    public void configure(SchemaDefinition s) {
        configureBuilding(s);
        configureFaculty(s);
        configureDepartment(s);
        configureSpecialty(s);
        configureRoom(s);
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

    private void configureFaculty(SchemaDefinition s) {
        s.type(Faculty.class)
            .fields("name", "abbreviation", "website", "email", "phone", "info")
            .nullableRelation("building")
            .relation("departments").relation("specialties").relation("rooms");

        s.query("facultyConnection").entity(Faculty.class).connection().orderBy("name");
        s.query("faculty").entity(Faculty.class).findById();

        s.mutation("createFaculty").entity(Faculty.class).create()
            .inputFields("name", "abbreviation", "website", "email", "phone", "info", "buildingId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateFaculty").entity(Faculty.class).update()
            .inputFields("name", "abbreviation", "website", "email", "phone", "info", "buildingId")
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
            .fields("name", "abbreviation", "email", "phone", "info")
            .relation("faculty").relation("lecturers").relation("courses");

        s.query("departmentConnection").entity(Department.class).connection().orderBy("name").filter("facultyId", "faculty_id");
        s.query("department").entity(Department.class).findById();

        s.mutation("createDepartment").entity(Department.class).create()
            .inputFields("name", "abbreviation", "email", "phone", "info", "facultyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateDepartment").entity(Department.class).update()
            .inputFields("name", "abbreviation", "email", "phone", "info", "facultyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DEPARTMENT_NOT_FOUND", "Department not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteDepartment").entity(Department.class).delete()
            .errorStatus("DEPARTMENT_NOT_FOUND", "Department not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // Specialty
    // -------------------------------------------------------------------------

    private void configureSpecialty(SchemaDefinition s) {
        s.type(Specialty.class)
            .fields("code", "name", "degree", "qualification")
            .relation("faculty").relation("groups").relation("curricula");

        s.query("specialtyConnection").entity(Specialty.class).connection().orderBy("code").filter("facultyId", "faculty_id");
        s.query("specialty").entity(Specialty.class).findById();

        s.mutation("createSpecialty").entity(Specialty.class).create()
            .inputFields("code", "name", "degree", "qualification", "facultyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateSpecialty").entity(Specialty.class).update()
            .inputFields("code", "name", "degree", "qualification", "facultyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("SPECIALTY_NOT_FOUND", "Specialty not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteSpecialty").entity(Specialty.class).delete()
            .errorStatus("SPECIALTY_NOT_FOUND", "Specialty not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // Room
    // -------------------------------------------------------------------------

    private void configureRoom(SchemaDefinition s) {
        s.type(Room.class)
            .fields("number", "name", "capacity", "kind")
            .nullableRelation("faculty")
            .nullableRelation("building");

        s.query("roomConnection").entity(Room.class).connection().orderBy("number")
            .filter("facultyId", "faculty_id")
            .filter("buildingId", "building_id");
        s.query("room").entity(Room.class).findById();

        s.mutation("createRoom").entity(Room.class).create()
            .inputFields("number", "name", "capacity", "kind", "facultyId", "buildingId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateRoom").entity(Room.class).update()
            .inputFields("number", "name", "capacity", "kind", "facultyId", "buildingId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("ROOM_NOT_FOUND", "Room not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteRoom").entity(Room.class).delete()
            .errorStatus("ROOM_NOT_FOUND", "Room not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }
}
