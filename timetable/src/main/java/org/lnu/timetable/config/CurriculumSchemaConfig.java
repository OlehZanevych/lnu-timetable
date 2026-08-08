package org.lnu.timetable.config;

import org.lnu.timetable.domain.*;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.config.SchemaDefinition;
import org.springframework.stereotype.Component;

/**
 * GraphQL types, queries and mutations for academic curriculum entities:
 * Course, CurriculumItem, CurriculumItemHours, WorkingCurriculumItem, CombinedWorkingCurriculumItem.
 */
@Component
public class CurriculumSchemaConfig implements GraphQLSchemaConfig {

    @Override
    public void configure(SchemaDefinition s) {
        configureCourse(s);
        configureCourseTag(s);
        configureCurriculumItem(s);
        configureCurriculumItemHours(s);
        configureWorkingCurriculumItem(s);
        configureCombinedWorkingCurriculumItem(s);
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
            .relation("childCourses")
            .relation("specialties")
            .relation("tags");

        // specialtyId narrows the list to courses allowed for that specialty (see the
        // course_specialties join table) — used when picking a course for a curriculum item so
        // only courses actually permitted for the current specialty are offered, regardless of
        // any faculty/department sub-filter also applied on the same connection.
        s.query("courseConnection").entity(Course.class).connection().orderBy("name")
            .filter("departmentId", "department_id")
            .filter("facultyId", "faculty_id")
            // An ELECTIVE_GROUP's own electives, for the course page's «Вибіркові дисципліни»
            // section. Course *does* carry a childCourses relation, but a relation cannot be
            // paged, filtered or created into; the section adds and detaches rows, so it wants a
            // connection like every other editable list.
            .filter("parentCourseId", "parent_course_id")
            .relationFilter("specialtyId",
                "EXISTS (SELECT 1 FROM course_specialties cs " +
                "WHERE cs.course_id = courses.id AND cs.specialty_id = :specialtyId)");
        s.query("course").entity(Course.class).findById();

        s.mutation("createCourse").entity(Course.class).create()
            .inputFields("name", "courseType", "departmentId", "facultyId", "parentCourseId")
            .manyToMany("specialtyIds", "course_specialties", "course_id", "specialty_id")
            .nestedList("tags", CourseTag.class, "courseId", "tag")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateCourse").entity(Course.class).update()
            .inputFields("name", "courseType", "departmentId", "facultyId", "parentCourseId")
            .manyToMany("specialtyIds", "course_specialties", "course_id", "specialty_id")
            .nestedList("tags", CourseTag.class, "courseId", "tag")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("COURSE_NOT_FOUND", "Course not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteCourse").entity(Course.class).delete()
            .errorStatus("COURSE_NOT_FOUND", "Course not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // CourseTag
    // -------------------------------------------------------------------------

    /**
     * CourseTag has no standalone queries/mutations of its own — it's only ever created, updated
     * and deleted as part of Course's create/update mutations (see the "tags" nestedList above).
     * It still needs to be registered as a GraphQL type so Course.tags can resolve to it.
     */
    private void configureCourseTag(SchemaDefinition s) {
        s.type(CourseTag.class).fields("tag");
    }

    // -------------------------------------------------------------------------
    // CurriculumItem
    // -------------------------------------------------------------------------

    private void configureCurriculumItem(SchemaDefinition s) {
        s.type(CurriculumItem.class)
            .fields("semester", "controlForm", "ectsCredits")
            .relation("specialty").relation("course").relation("hours");

        s.query("curriculumItemConnection").entity(CurriculumItem.class).connection().orderBy("semester")
            .filter("specialtyId", "specialty_id")
            // The course detail page asks "where is this discipline taught?"; Course carries no
            // curriculumItems relation, so the connection is the only way in.
            .filter("courseId", "course_id");
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
            .relation("combinedWorkingCurriculumItems")
            .relation("workloads");

        // working_curriculum_items has no faculty_id of its own — it's only known via its
        // department — so this is an EXISTS subquery through departments rather than a plain column
        // filter (see QueryDefinition.RelationFilter; same approach used for
        // combinedWorkingCurriculumItemConnection's facultyId filter).
        // semesterParity ('ODD'/'EVEN') filters by the parity of the linked curriculum item's
        // semester (1,3,5.. vs 2,4,6..) — also an EXISTS subquery, through curriculum_item_hours.
        s.query("workingCurriculumItemConnection").entity(WorkingCurriculumItem.class).connection().orderBy("id")
            .filter("departmentId", "department_id")
            .relationFilter("facultyId",
                "EXISTS (SELECT 1 FROM departments d " +
                "WHERE d.id = working_curriculum_items.department_id AND d.faculty_id = :facultyId)")
            .relationFilterString("semesterParity",
                "EXISTS (SELECT 1 FROM curriculum_item_hours cih " +
                "JOIN curriculum_items ci ON ci.id = cih.curriculum_item_id " +
                "WHERE cih.id = working_curriculum_items.curriculum_item_hours_id " +
                "AND ((:semesterParity = 'ODD' AND ci.semester % 2 = 1) OR (:semesterParity = 'EVEN' AND ci.semester % 2 = 0)))")
            // Everything that delivers one discipline, for the course page's editors. A working
            // item names a course in two different senses and both belong here:
            //   * the discipline it delivers — the curriculum item's course, two joins away;
            //   * the elective actually chosen — its own course_id, set only when that curriculum
            //     item's course is an ELECTIVE_GROUP (see WorkingCurriculumItem.course).
            // Filtering on only the first would hide an elective's own deliveries from its page;
            // on only the second, every ordinary discipline's. Hence the OR.
            .relationFilter("courseId",
                "(working_curriculum_items.course_id = :courseId " +
                "OR EXISTS (SELECT 1 FROM curriculum_item_hours cih " +
                "JOIN curriculum_items ci ON ci.id = cih.curriculum_item_id " +
                "WHERE cih.id = working_curriculum_items.curriculum_item_hours_id " +
                "AND ci.course_id = :courseId))");
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

    // -------------------------------------------------------------------------
    // CombinedWorkingCurriculumItem
    // -------------------------------------------------------------------------

    private void configureCombinedWorkingCurriculumItem(SchemaDefinition s) {
        s.type(CombinedWorkingCurriculumItem.class)
            .relation("workingCurriculumItems")
            .relation("workloads");

        // combined_working_curriculum_items has no department_id/faculty_id of its own — a combined
        // item's departments/faculty are only known via its members' working_curriculum_items, so
        // these filters are EXISTS subqueries through the member join table rather than plain column
        // filters (see QueryDefinition.RelationFilter).
        s.query("combinedWorkingCurriculumItemConnection").entity(CombinedWorkingCurriculumItem.class).connection().orderBy("id")
            .relationFilterList("departmentIds",
                "EXISTS (SELECT 1 FROM combined_working_curriculum_item_members m " +
                "JOIN working_curriculum_items w ON w.id = m.working_curriculum_item_id " +
                "WHERE m.combined_working_curriculum_item_id = combined_working_curriculum_items.id " +
                "AND w.department_id = ANY(:departmentIds))")
            .relationFilter("facultyId",
                "EXISTS (SELECT 1 FROM combined_working_curriculum_item_members m " +
                "JOIN working_curriculum_items w ON w.id = m.working_curriculum_item_id " +
                "JOIN departments d ON d.id = w.department_id " +
                "WHERE m.combined_working_curriculum_item_id = combined_working_curriculum_items.id " +
                "AND d.faculty_id = :facultyId)")
            .relationFilterString("semesterParity",
                "EXISTS (SELECT 1 FROM combined_working_curriculum_item_members m " +
                "JOIN working_curriculum_items w ON w.id = m.working_curriculum_item_id " +
                "JOIN curriculum_item_hours cih ON cih.id = w.curriculum_item_hours_id " +
                "JOIN curriculum_items ci ON ci.id = cih.curriculum_item_id " +
                "WHERE m.combined_working_curriculum_item_id = combined_working_curriculum_items.id " +
                "AND ((:semesterParity = 'ODD' AND ci.semester % 2 = 1) OR (:semesterParity = 'EVEN' AND ci.semester % 2 = 0)))");
        s.query("combinedWorkingCurriculumItem").entity(CombinedWorkingCurriculumItem.class).findById();

        s.mutation("createCombinedWorkingCurriculumItem").entity(CombinedWorkingCurriculumItem.class).create()
            .manyToMany("workingCurriculumItemIds", "combined_working_curriculum_item_members", "combined_working_curriculum_item_id", "working_curriculum_item_id")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateCombinedWorkingCurriculumItem").entity(CombinedWorkingCurriculumItem.class).update()
            .manyToMany("workingCurriculumItemIds", "combined_working_curriculum_item_members", "combined_working_curriculum_item_id", "working_curriculum_item_id")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("COMBINEDWORKINGCURRICULUMITEM_NOT_FOUND", "CombinedWorkingCurriculumItem not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteCombinedWorkingCurriculumItem").entity(CombinedWorkingCurriculumItem.class).delete()
            .errorStatus("COMBINEDWORKINGCURRICULUMITEM_NOT_FOUND", "CombinedWorkingCurriculumItem not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }
}
