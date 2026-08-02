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
        configureLecturerWorkloadConstraint(s);
        configureLecturerTimetableConstraint(s);
        configureStudent(s);
        configureAcademicGroup(s);
        configureAcademicGroupTimetableConstraint(s);
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
            .fields("firstName", "middleName", "lastName", "email", "position")
            .nullableRelation("academicDegree")
            .relation("department").relation("workloads").relation("workloadConstraints")
            .relation("timetableConstraints");

        // lecturers has no faculty_id of its own - a lecturer's faculty is only known through their
        // department - so facultyId is an EXISTS subquery rather than a plain column filter (see
        // QueryDefinition.RelationFilter; same approach as academicGroupConnection's facultyId).
        // The schedule generator needs it: it reads every lecturer of a faculty together with their
        // scheduling constraints in one request, rather than one request per department.
        s.query("lecturerConnection").entity(Lecturer.class).connection().orderBy("lastName")
            .filter("departmentId", "department_id")
            .relationFilter("facultyId",
                "EXISTS (SELECT 1 FROM departments d " +
                "WHERE d.id = lecturers.department_id AND d.faculty_id = :facultyId)");
        s.query("lecturer").entity(Lecturer.class).findById();

        s.mutation("createLecturer").entity(Lecturer.class).create()
            .inputFields("firstName", "middleName", "lastName", "email", "position", "academicDegreeId", "departmentId")
            .nestedList("workloadConstraints", LecturerWorkloadConstraint.class, "lecturerId", "constraintType", "value")
            .nestedList("timetableConstraints", LecturerTimetableConstraint.class, "lecturerId",
                "constraintType", "dayOfWeek", "constraintValue")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateLecturer").entity(Lecturer.class).update()
            .inputFields("firstName", "middleName", "lastName", "email", "position", "academicDegreeId", "departmentId")
            .nestedList("workloadConstraints", LecturerWorkloadConstraint.class, "lecturerId", "constraintType", "value")
            .nestedList("timetableConstraints", LecturerTimetableConstraint.class, "lecturerId",
                "constraintType", "dayOfWeek", "constraintValue")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("LECTURER_NOT_FOUND", "Lecturer not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteLecturer").entity(Lecturer.class).delete()
            .errorStatus("LECTURER_NOT_FOUND", "Lecturer not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // LecturerWorkloadConstraint
    // -------------------------------------------------------------------------

    /**
     * Registered as a type so Lecturer.workloadConstraints resolves, but with no queries or
     * mutations of its own: a lecturer's constraints are only meaningful (and only validatable)
     * as a set, so they are written through Lecturer's "workloadConstraints" nestedList above.
     */
    private void configureLecturerWorkloadConstraint(SchemaDefinition s) {
        s.type(LecturerWorkloadConstraint.class)
            .fields("constraintType", "value");
    }

    // -------------------------------------------------------------------------
    // LecturerTimetableConstraint
    // -------------------------------------------------------------------------

    /**
     * Registered as a type so Lecturer.timetableConstraints resolves, with no queries or mutations
     * of its own: a lecturer's scheduling rules are only meaningful as a set — a day-specific rule
     * overrides the every-day one, so they have to be read and written together — and are written
     * through Lecturer's "timetableConstraints" nestedList above.
     */
    private void configureLecturerTimetableConstraint(SchemaDefinition s) {
        s.type(LecturerTimetableConstraint.class)
            .fields("constraintType", "dayOfWeek", "constraintValue");
    }

    // -------------------------------------------------------------------------
    // Student
    // -------------------------------------------------------------------------

    private void configureStudent(SchemaDefinition s) {
        s.type(Student.class)
            .fields("firstName", "middleName", "lastName", "email", "recordBookNumber")
            .relation("academicGroup");

        s.query("studentConnection").entity(Student.class).connection().orderBy("lastName").filter("academicGroupId", "academic_group_id");
        s.query("student").entity(Student.class).findById();

        s.mutation("createStudent").entity(Student.class).create()
            .inputFields("firstName", "middleName", "lastName", "email", "recordBookNumber", "academicGroupId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateStudent").entity(Student.class).update()
            .inputFields("firstName", "middleName", "lastName", "email", "recordBookNumber", "academicGroupId")
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
            .relation("specialty").relation("students").relation("combinedGroups")
            .relation("timetableConstraints");

        // academic_groups has no faculty_id of its own — a group's faculty is only known through
        // its specialty — so facultyId is an EXISTS subquery rather than a plain column filter
        // (see QueryDefinition.RelationFilter; same approach as workingCurriculumItemConnection's
        // facultyId, which reaches its faculty through departments).
        s.query("academicGroupConnection").entity(AcademicGroup.class).connection().orderBy("name")
            .filter("specialtyId", "specialty_id")
            .relationFilter("facultyId",
                "EXISTS (SELECT 1 FROM specialties sp " +
                "WHERE sp.id = academic_groups.specialty_id AND sp.faculty_id = :facultyId)");
        s.query("academicGroup").entity(AcademicGroup.class).findById();

        s.mutation("createAcademicGroup").entity(AcademicGroup.class).create()
            .inputFields("name", "courseYear", "studyForm", "studentsCount", "specialtyId")
            .nestedList("timetableConstraints", AcademicGroupTimetableConstraint.class, "academicGroupId",
                "constraintType", "dayOfWeek", "constraintValue")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateAcademicGroup").entity(AcademicGroup.class).update()
            .inputFields("name", "courseYear", "studyForm", "studentsCount", "specialtyId")
            .nestedList("timetableConstraints", AcademicGroupTimetableConstraint.class, "academicGroupId",
                "constraintType", "dayOfWeek", "constraintValue")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("ACADEMICGROUP_NOT_FOUND", "AcademicGroup not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteAcademicGroup").entity(AcademicGroup.class).delete()
            .errorStatus("ACADEMICGROUP_NOT_FOUND", "AcademicGroup not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // AcademicGroupTimetableConstraint
    // -------------------------------------------------------------------------

    /** As LecturerTimetableConstraint: a type only, written through AcademicGroup's nestedList. */
    private void configureAcademicGroupTimetableConstraint(SchemaDefinition s) {
        s.type(AcademicGroupTimetableConstraint.class)
            .fields("constraintType", "dayOfWeek", "constraintValue");
    }

    // -------------------------------------------------------------------------
    // CombinedGroup
    // -------------------------------------------------------------------------

    private void configureCombinedGroup(SchemaDefinition s) {
        s.type(CombinedGroup.class)
            .fields("name", "purpose")
            .relation("academicGroups").relation("workloads");

        // A combined group has no faculty of its own — its faculty is whatever its member academic
        // groups' specialties belong to. EXISTS gives "any member belongs to this faculty", so a
        // group spanning two faculties shows up under both, which is the point of combining them.
        s.query("combinedGroupConnection").entity(CombinedGroup.class).connection().orderBy("name")
            .relationFilter("facultyId",
                "EXISTS (SELECT 1 FROM combined_group_academic_groups cga " +
                "JOIN academic_groups ag ON ag.id = cga.academic_group_id " +
                "JOIN specialties sp ON sp.id = ag.specialty_id " +
                "WHERE cga.combined_group_id = combined_groups.id AND sp.faculty_id = :facultyId)");
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
