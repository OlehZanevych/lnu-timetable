package org.lnu.timetable.config;

import org.lnu.timetable.domain.*;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.config.SchemaDefinition;
import org.springframework.stereotype.Component;

/**
 * GraphQL types, queries and mutations for academic curriculum entities:
 * Course, Curriculum, CurriculumItem, WorkingCurriculum, WorkingCurriculumItem.
 */
@Component
public class CurriculumSchemaConfig implements GraphQLSchemaConfig {

    @Override
    public void configure(SchemaDefinition s) {
        configureCourse(s);
        configureCurriculum(s);
        configureCurriculumItem(s);
        configureWorkingCurriculum(s);
        configureWorkingCurriculumItem(s);
    }

    // -------------------------------------------------------------------------
    // Course
    // -------------------------------------------------------------------------

    private void configureCourse(SchemaDefinition s) {
        s.type(Course.class)
            .fields("code", "name", "ectsCredits")
            .relation("department");

        s.query("courseConnection").entity(Course.class).connection().orderBy("name").filter("departmentId", "department_id");
        s.query("course").entity(Course.class).findById();

        s.mutation("createCourse").entity(Course.class).create()
            .inputFields("code", "name", "ectsCredits", "departmentId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateCourse").entity(Course.class).update()
            .inputFields("code", "name", "ectsCredits", "departmentId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("COURSE_NOT_FOUND", "Course not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteCourse").entity(Course.class).delete()
            .errorStatus("COURSE_NOT_FOUND", "Course not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // Curriculum
    // -------------------------------------------------------------------------

    private void configureCurriculum(SchemaDefinition s) {
        s.type(Curriculum.class)
            .fields("name", "admissionYear", "degree")
            .relation("specialty").relation("items").relation("workingCurricula");

        s.query("curriculumConnection").entity(Curriculum.class).connection().orderBy("name").filter("specialtyId", "specialty_id");
        s.query("curriculum").entity(Curriculum.class).findById();

        s.mutation("createCurriculum").entity(Curriculum.class).create()
            .inputFields("name", "admissionYear", "degree", "specialtyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateCurriculum").entity(Curriculum.class).update()
            .inputFields("name", "admissionYear", "degree", "specialtyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("CURRICULUM_NOT_FOUND", "Curriculum not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteCurriculum").entity(Curriculum.class).delete()
            .errorStatus("CURRICULUM_NOT_FOUND", "Curriculum not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // CurriculumItem
    // -------------------------------------------------------------------------

    private void configureCurriculumItem(SchemaDefinition s) {
        s.type(CurriculumItem.class)
            .fields("semester", "controlForm", "ectsCredits")
            .relation("curriculum").relation("course");

        s.query("curriculumItemConnection").entity(CurriculumItem.class).connection().orderBy("semester").filter("curriculumId", "curriculum_id");
        s.query("curriculumItem").entity(CurriculumItem.class).findById();

        s.mutation("createCurriculumItem").entity(CurriculumItem.class).create()
            .inputFields("semester", "controlForm", "ectsCredits", "curriculumId", "courseId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateCurriculumItem").entity(CurriculumItem.class).update()
            .inputFields("semester", "controlForm", "ectsCredits", "curriculumId", "courseId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("CURRICULUMITEM_NOT_FOUND", "CurriculumItem not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteCurriculumItem").entity(CurriculumItem.class).delete()
            .errorStatus("CURRICULUMITEM_NOT_FOUND", "CurriculumItem not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // WorkingCurriculum
    // -------------------------------------------------------------------------

    private void configureWorkingCurriculum(SchemaDefinition s) {
        s.type(WorkingCurriculum.class)
            .fields("academicYear", "semester")
            .relation("curriculum").relation("items");

        s.query("workingCurriculumConnection").entity(WorkingCurriculum.class).connection().orderBy("academicYear").filter("curriculumId", "curriculum_id");
        s.query("workingCurriculum").entity(WorkingCurriculum.class).findById();

        s.mutation("createWorkingCurriculum").entity(WorkingCurriculum.class).create()
            .inputFields("academicYear", "semester", "curriculumId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateWorkingCurriculum").entity(WorkingCurriculum.class).update()
            .inputFields("academicYear", "semester", "curriculumId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("WORKINGCURRICULUM_NOT_FOUND", "WorkingCurriculum not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteWorkingCurriculum").entity(WorkingCurriculum.class).delete()
            .errorStatus("WORKINGCURRICULUM_NOT_FOUND", "WorkingCurriculum not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // WorkingCurriculumItem
    // -------------------------------------------------------------------------

    private void configureWorkingCurriculumItem(SchemaDefinition s) {
        s.type(WorkingCurriculumItem.class)
            .fields("lectureHours", "practicalHours", "labHours", "seminarHours")
            .relation("workingCurriculum").relation("course");

        s.query("workingCurriculumItemConnection").entity(WorkingCurriculumItem.class).connection().orderBy("id").filter("workingCurriculumId", "working_curriculum_id");
        s.query("workingCurriculumItem").entity(WorkingCurriculumItem.class).findById();

        s.mutation("createWorkingCurriculumItem").entity(WorkingCurriculumItem.class).create()
            .inputFields("lectureHours", "practicalHours", "labHours", "seminarHours", "workingCurriculumId", "courseId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateWorkingCurriculumItem").entity(WorkingCurriculumItem.class).update()
            .inputFields("lectureHours", "practicalHours", "labHours", "seminarHours", "workingCurriculumId", "courseId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("WORKINGCURRICULUMITEM_NOT_FOUND", "WorkingCurriculumItem not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteWorkingCurriculumItem").entity(WorkingCurriculumItem.class).delete()
            .errorStatus("WORKINGCURRICULUMITEM_NOT_FOUND", "WorkingCurriculumItem not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }
}
