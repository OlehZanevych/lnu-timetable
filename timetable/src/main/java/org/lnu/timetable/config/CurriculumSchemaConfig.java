package org.lnu.timetable.config;

import org.lnu.timetable.domain.*;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.config.SchemaDefinition;
import org.springframework.stereotype.Component;

/**
 * GraphQL types, queries and mutations for academic curriculum entities:
 * Course, CurriculumItem, CurriculumItemHours, WorkingCurriculumItem.
 */
@Component
public class CurriculumSchemaConfig implements GraphQLSchemaConfig {

    @Override
    public void configure(SchemaDefinition s) {
        configureCourse(s);
        configureCurriculumItem(s);
        configureCurriculumItemHours(s);
        configureWorkingCurriculumItem(s);
    }

    // -------------------------------------------------------------------------
    // Course
    // -------------------------------------------------------------------------

    private void configureCourse(SchemaDefinition s) {
        s.type(Course.class)
            .fields("name", "courseType")
            .nullableRelation("faculty")
            .nullableRelation("department")
            .nullableRelation("parentCourse")
            .relation("childCourses");

        s.query("courseConnection").entity(Course.class).connection().orderBy("name")
            .filter("departmentId", "department_id")
            .filter("facultyId", "faculty_id");
        s.query("course").entity(Course.class).findById();

        s.mutation("createCourse").entity(Course.class).create()
            .inputFields("name", "courseType", "departmentId", "facultyId", "parentCourseId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateCourse").entity(Course.class).update()
            .inputFields("name", "courseType", "departmentId", "facultyId", "parentCourseId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("COURSE_NOT_FOUND", "Course not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteCourse").entity(Course.class).delete()
            .errorStatus("COURSE_NOT_FOUND", "Course not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // CurriculumItem
    // -------------------------------------------------------------------------

    private void configureCurriculumItem(SchemaDefinition s) {
        s.type(CurriculumItem.class)
            .fields("semester", "controlForm", "ectsCredits")
            .relation("specialty").relation("course").relation("hours");

        s.query("curriculumItemConnection").entity(CurriculumItem.class).connection().orderBy("semester").filter("specialtyId", "specialty_id");
        s.query("curriculumItem").entity(CurriculumItem.class).findById();

        s.mutation("createCurriculumItem").entity(CurriculumItem.class).create()
            .inputFields("semester", "controlForm", "ectsCredits", "specialtyId", "courseId")
            .nestedList("hours", CurriculumItemHours.class, "curriculumItemId", "hourType", "hours")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateCurriculumItem").entity(CurriculumItem.class).update()
            .inputFields("semester", "controlForm", "ectsCredits", "specialtyId", "courseId")
            .nestedList("hours", CurriculumItemHours.class, "curriculumItemId", "hourType", "hours")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("CURRICULUMITEM_NOT_FOUND", "CurriculumItem not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteCurriculumItem").entity(CurriculumItem.class).delete()
            .errorStatus("CURRICULUMITEM_NOT_FOUND", "CurriculumItem not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // CurriculumItemHours
    // -------------------------------------------------------------------------

    private void configureCurriculumItemHours(SchemaDefinition s) {
        s.type(CurriculumItemHours.class)
            .fields("hourType", "hours")
            .relation("curriculumItem")
            .relation("workingCurriculumItems");

        s.query("curriculumItemHoursConnection").entity(CurriculumItemHours.class).connection().orderBy("hourType").filter("curriculumItemId", "curriculum_item_id");
        s.query("curriculumItemHours").entity(CurriculumItemHours.class).findById();

        s.mutation("createCurriculumItemHours").entity(CurriculumItemHours.class).create()
            .inputFields("hourType", "hours", "curriculumItemId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateCurriculumItemHours").entity(CurriculumItemHours.class).update()
            .inputFields("hourType", "hours", "curriculumItemId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("CURRICULUMITEMHOURS_NOT_FOUND", "CurriculumItemHours not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteCurriculumItemHours").entity(CurriculumItemHours.class).delete()
            .errorStatus("CURRICULUMITEMHOURS_NOT_FOUND", "CurriculumItemHours not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // WorkingCurriculumItem
    // -------------------------------------------------------------------------

    private void configureWorkingCurriculumItem(SchemaDefinition s) {
        s.type(WorkingCurriculumItem.class)
            .fields("lecturerCount", "teachingFormat")
            .relation("curriculumItemHours")
            .relation("department")
            .nullableRelation("course")
            .relation("academicGroups")
            .relation("workloads");

        s.query("workingCurriculumItemConnection").entity(WorkingCurriculumItem.class).connection().orderBy("id").filter("departmentId", "department_id");
        s.query("workingCurriculumItem").entity(WorkingCurriculumItem.class).findById();

        s.mutation("createWorkingCurriculumItem").entity(WorkingCurriculumItem.class).create()
            .inputFields("lecturerCount", "teachingFormat", "curriculumItemHoursId", "departmentId", "courseId")
            .manyToMany("academicGroupIds", "working_curriculum_item_groups", "working_curriculum_item_id", "academic_group_id")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateWorkingCurriculumItem").entity(WorkingCurriculumItem.class).update()
            .inputFields("lecturerCount", "teachingFormat", "curriculumItemHoursId", "departmentId", "courseId")
            .manyToMany("academicGroupIds", "working_curriculum_item_groups", "working_curriculum_item_id", "academic_group_id")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("WORKINGCURRICULUMITEM_NOT_FOUND", "WorkingCurriculumItem not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteWorkingCurriculumItem").entity(WorkingCurriculumItem.class).delete()
            .errorStatus("WORKINGCURRICULUMITEM_NOT_FOUND", "WorkingCurriculumItem not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }
}
