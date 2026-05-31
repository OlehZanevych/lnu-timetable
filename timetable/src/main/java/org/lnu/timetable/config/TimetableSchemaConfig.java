package org.lnu.timetable.config;

import org.lnu.timetable.domain.*;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.config.SchemaDefinition;
import org.springframework.stereotype.Component;

/**
 * Declares all GraphQL types, queries and mutations for the LNU timetabling domain
 * by referencing entities and their fields. No controllers/services/repositories needed.
 */
@Component
public class TimetableSchemaConfig implements GraphQLSchemaConfig {

    @Override
    public void configure(SchemaDefinition s) {
        // ---------- Types ----------
        s.type(Faculty.class).fields("name", "abbreviation", "website", "email", "phone", "address", "info")
            .relation("departments").relation("specialties").relation("rooms");

        s.type(Department.class).fields("name", "abbreviation", "email", "phone", "info")
            .relation("faculty").relation("lecturers").relation("courses");

        s.type(Specialty.class).fields("code", "name", "degree", "qualification")
            .relation("faculty").relation("groups").relation("curricula");

        s.type(Course.class).fields("code", "name", "ectsCredits").relation("department");

        s.type(Curriculum.class).fields("name", "admissionYear", "degree")
            .relation("specialty").relation("items").relation("workingCurricula");

        s.type(CurriculumItem.class).fields("semester", "controlForm", "ectsCredits")
            .relation("curriculum").relation("course");

        s.type(WorkingCurriculum.class).fields("academicYear", "semester")
            .relation("curriculum").relation("items");

        s.type(WorkingCurriculumItem.class).fields("lectureHours", "practicalHours", "labHours", "seminarHours")
            .relation("workingCurriculum").relation("course");

        s.type(Lecturer.class).fields("firstName", "lastName", "email", "position", "academicDegree", "maxHoursPerWeek")
            .relation("department").relation("workloads");

        s.type(LecturerWorkload.class).fields("classType", "periodicity", "hoursPerWeek")
            .relation("lecturer").relation("course")
            .nullableRelation("academicGroup").nullableRelation("combinedGroup").nullableRelation("workingCurriculum")
            .relation("timetableEntries");

        s.type(Student.class).fields("firstName", "lastName", "email", "recordBookNumber").relation("academicGroup");

        s.type(AcademicGroup.class).fields("name", "courseYear", "studyForm", "studentsCount")
            .relation("specialty").relation("students").relation("combinedGroups");

        s.type(CombinedGroup.class).fields("name", "purpose").relation("academicGroups").relation("workloads");

        s.type(Room.class).fields("number", "name", "building", "capacity", "kind").nullableRelation("faculty");

        s.type(TimeSlot.class).fields("ordinal", "startTime", "endTime");

        s.type(TimetableEntry.class).fields("dayOfWeek", "weekParity")
            .relation("workload").relation("timeSlot").relation("room");

        // ---------- Queries + Mutations (CRUD for every entity) ----------
        crud(s, Faculty.class, "name", "name", "abbreviation", "website", "email", "phone", "address", "info");
        crud(s, Department.class, "name", "name", "abbreviation", "email", "phone", "info", "facultyId");
        crud(s, Specialty.class, "code", "code", "name", "degree", "qualification", "facultyId");
        crud(s, Course.class, "name", "code", "name", "ectsCredits", "departmentId");
        crud(s, Curriculum.class, "name", "name", "admissionYear", "degree", "specialtyId");
        crud(s, CurriculumItem.class, "semester", "semester", "controlForm", "ectsCredits", "curriculumId", "courseId");
        crud(s, WorkingCurriculum.class, "academicYear", "academicYear", "semester", "curriculumId");
        crud(s, WorkingCurriculumItem.class, "id", "lectureHours", "practicalHours", "labHours", "seminarHours", "workingCurriculumId", "courseId");
        crud(s, Lecturer.class, "lastName", "firstName", "lastName", "email", "position", "academicDegree", "maxHoursPerWeek", "departmentId");
        crud(s, LecturerWorkload.class, "id", "classType", "periodicity", "hoursPerWeek", "lecturerId", "courseId", "academicGroupId", "combinedGroupId", "workingCurriculumId");
        crud(s, Student.class, "lastName", "firstName", "lastName", "email", "recordBookNumber", "academicGroupId");
        crud(s, AcademicGroup.class, "name", "name", "courseYear", "studyForm", "studentsCount", "specialtyId");
        crud(s, CombinedGroup.class, "name", "name", "purpose");
        crud(s, Room.class, "number", "number", "name", "building", "capacity", "kind", "facultyId");
        crud(s, TimeSlot.class, "ordinal", "ordinal", "startTime", "endTime");
        crud(s, TimetableEntry.class, "dayOfWeek", "dayOfWeek", "weekParity", "workloadId", "timeSlotId", "roomId");
    }

    /** Registers connection + findById queries and create/update/delete mutations for an entity. */
    private void crud(SchemaDefinition s, Class<?> entity, String orderBy, String... inputFields) {
        String n = entity.getSimpleName();
        String lower = Character.toLowerCase(n.charAt(0)) + n.substring(1);
        String notFound = n.toUpperCase() + "_NOT_FOUND";

        s.query(lower + "Connection").entity(entity).connection().orderBy(orderBy);
        s.query(lower).entity(entity).findById();

        s.mutation("create" + n).entity(entity).create().inputFields(inputFields)
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("update" + n).entity(entity).update().inputFields(inputFields)
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus(notFound, n + " not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("delete" + n).entity(entity).delete()
            .errorStatus(notFound, n + " not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }
}
