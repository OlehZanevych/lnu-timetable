package org.lnu.timetable.config;

import org.lnu.timetable.domain.*;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.config.SchemaDefinition;
import org.springframework.stereotype.Component;

/**
 * GraphQL types, queries and mutations for people and group entities:
 * Lecturer, Student, AcademicGroup, CombinedGroup.
 */
@Component
public class PeopleSchemaConfig implements GraphQLSchemaConfig {

    @Override
    public void configure(SchemaDefinition s) {
        configureAcademicDegree(s);
        configureLecturer(s);
        configureStudent(s);
        configureAcademicGroup(s);
        configureCombinedGroup(s);
    }

    // -------------------------------------------------------------------------
    // AcademicDegree
    // -------------------------------------------------------------------------

    private void configureAcademicDegree(SchemaDefinition s) {
        s.type(AcademicDegree.class)
            .fields("name", "abbreviation", "level")
            .relation("lecturers");

        s.query("academicDegreeConnection").entity(AcademicDegree.class).connection().orderBy("level");
        s.query("academicDegree").entity(AcademicDegree.class).findById();

        s.mutation("createAcademicDegree").entity(AcademicDegree.class).create()
            .inputFields("name", "abbreviation", "level")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateAcademicDegree").entity(AcademicDegree.class).update()
            .inputFields("name", "abbreviation", "level")
            .errorStatus("ACADEMICDEGREE_NOT_FOUND", "AcademicDegree not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteAcademicDegree").entity(AcademicDegree.class).delete()
            .errorStatus("ACADEMICDEGREE_NOT_FOUND", "AcademicDegree not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // Lecturer
    // -------------------------------------------------------------------------

    private void configureLecturer(SchemaDefinition s) {
        s.type(Lecturer.class)
            .fields("firstName", "middleName", "lastName", "email", "position", "maxHoursPerWeek")
            .nullableRelation("academicDegree")
            .relation("department").relation("workloads");

        s.query("lecturerConnection").entity(Lecturer.class).connection().orderBy("lastName").filter("departmentId", "department_id");
        s.query("lecturer").entity(Lecturer.class).findById();

        s.mutation("createLecturer").entity(Lecturer.class).create()
            .inputFields("firstName", "middleName", "lastName", "email", "position", "academicDegreeId", "maxHoursPerWeek", "departmentId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateLecturer").entity(Lecturer.class).update()
            .inputFields("firstName", "middleName", "lastName", "email", "position", "academicDegreeId", "maxHoursPerWeek", "departmentId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("LECTURER_NOT_FOUND", "Lecturer not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteLecturer").entity(Lecturer.class).delete()
            .errorStatus("LECTURER_NOT_FOUND", "Lecturer not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // Student
    // -------------------------------------------------------------------------

    private void configureStudent(SchemaDefinition s) {
        s.type(Student.class)
            .fields("firstName", "lastName", "email", "recordBookNumber")
            .relation("academicGroup");

        s.query("studentConnection").entity(Student.class).connection().orderBy("lastName").filter("academicGroupId", "academic_group_id");
        s.query("student").entity(Student.class).findById();

        s.mutation("createStudent").entity(Student.class).create()
            .inputFields("firstName", "lastName", "email", "recordBookNumber", "academicGroupId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateStudent").entity(Student.class).update()
            .inputFields("firstName", "lastName", "email", "recordBookNumber", "academicGroupId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("STUDENT_NOT_FOUND", "Student not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteStudent").entity(Student.class).delete()
            .errorStatus("STUDENT_NOT_FOUND", "Student not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // AcademicGroup
    // -------------------------------------------------------------------------

    private void configureAcademicGroup(SchemaDefinition s) {
        s.type(AcademicGroup.class)
            .fields("name", "courseYear", "studyForm", "studentsCount")
            .relation("specialty").relation("students").relation("combinedGroups");

        s.query("academicGroupConnection").entity(AcademicGroup.class).connection().orderBy("name").filter("specialtyId", "specialty_id");
        s.query("academicGroup").entity(AcademicGroup.class).findById();

        s.mutation("createAcademicGroup").entity(AcademicGroup.class).create()
            .inputFields("name", "courseYear", "studyForm", "studentsCount", "specialtyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateAcademicGroup").entity(AcademicGroup.class).update()
            .inputFields("name", "courseYear", "studyForm", "studentsCount", "specialtyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("ACADEMICGROUP_NOT_FOUND", "AcademicGroup not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteAcademicGroup").entity(AcademicGroup.class).delete()
            .errorStatus("ACADEMICGROUP_NOT_FOUND", "AcademicGroup not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // CombinedGroup
    // -------------------------------------------------------------------------

    private void configureCombinedGroup(SchemaDefinition s) {
        s.type(CombinedGroup.class)
            .fields("name", "purpose")
            .relation("academicGroups").relation("workloads");

        s.query("combinedGroupConnection").entity(CombinedGroup.class).connection().orderBy("name");
        s.query("combinedGroup").entity(CombinedGroup.class).findById();

        s.mutation("createCombinedGroup").entity(CombinedGroup.class).create()
            .inputFields("name", "purpose")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateCombinedGroup").entity(CombinedGroup.class).update()
            .inputFields("name", "purpose")
            .errorStatus("COMBINEDGROUP_NOT_FOUND", "CombinedGroup not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteCombinedGroup").entity(CombinedGroup.class).delete()
            .errorStatus("COMBINEDGROUP_NOT_FOUND", "CombinedGroup not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }
}
