package org.lnu.timetable.config;

import org.lnu.timetable.domain.*;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.config.SchemaDefinition;
import org.springframework.stereotype.Component;

/**
 * GraphQL types, queries and mutations for scheduling entities:
 * LecturerWorkload, ClassStartTimeSet, ClassStartTime, TimetableEntry.
 */
@Component
public class SchedulingSchemaConfig implements GraphQLSchemaConfig {

    @Override
    public void configure(SchemaDefinition s) {
        configureLecturerWorkload(s);
        configureLecturerWorkloadStudent(s);
        configureLecturerWorkloadCandidate(s);
        configureLecturerWorkloadCandidateConstraint(s);
        configureClassStartTimeSet(s);
        configureClassStartTime(s);
        configureTimetableEntry(s);
    }

    // -------------------------------------------------------------------------
    // LecturerWorkload
    // -------------------------------------------------------------------------

    private void configureLecturerWorkload(SchemaDefinition s) {
        s.type(LecturerWorkload.class)
            .fields("durationHours")
            .relation("classStartTimeSet")
            .relation("rooms")
            .relation("roomGroups")
            .relation("lecturers")
            .relation("academicGroups")
            .relation("combinedGroups")
            .relation("studentAssignments")
            .relation("candidates")
            .nullableRelation("workingCurriculumItem")
            .nullableRelation("combinedWorkingCurriculumItem")
            .relation("timetableEntries");

        s.query("lecturerWorkloadConnection").entity(LecturerWorkload.class).connection().orderBy("id");
        s.query("lecturerWorkload").entity(LecturerWorkload.class).findById();

        // Exactly one of workingCurriculumItemId / combinedWorkingCurriculumItemId must be given
        // (enforced by the lecturer_workloads_target_check DB constraint) — the latter is for
        // lecturers who simultaneously teach several working curriculum items at once (e.g. a
        // shared lecture across specialties).
        s.mutation("createLecturerWorkload").entity(LecturerWorkload.class).create()
            .inputFields("workingCurriculumItemId", "combinedWorkingCurriculumItemId", "durationHours",
                         "classStartTimeSetId")
            .manyToMany("lecturerIds", "lecturer_workload_lecturers", "lecturer_workload_id", "lecturer_id")
            .manyToMany("academicGroupIds", "lecturer_workload_academic_groups", "lecturer_workload_id", "academic_group_id")
            .manyToMany("combinedGroupIds", "lecturer_workload_combined_groups", "lecturer_workload_id", "combined_group_id")
            .manyToMany("roomIds", "lecturer_workload_rooms", "lecturer_workload_id", "room_id")
            .manyToMany("roomGroupIds", "lecturer_workload_room_groups", "lecturer_workload_id", "room_group_id")
            .nestedList("studentAssignments", LecturerWorkloadStudent.class, "lecturerWorkloadId", "lecturerId", "studentId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateLecturerWorkload").entity(LecturerWorkload.class).update()
            .inputFields("workingCurriculumItemId", "combinedWorkingCurriculumItemId", "durationHours",
                         "classStartTimeSetId")
            .manyToMany("lecturerIds", "lecturer_workload_lecturers", "lecturer_workload_id", "lecturer_id")
            .manyToMany("academicGroupIds", "lecturer_workload_academic_groups", "lecturer_workload_id", "academic_group_id")
            .manyToMany("combinedGroupIds", "lecturer_workload_combined_groups", "lecturer_workload_id", "combined_group_id")
            .manyToMany("roomIds", "lecturer_workload_rooms", "lecturer_workload_id", "room_id")
            .manyToMany("roomGroupIds", "lecturer_workload_room_groups", "lecturer_workload_id", "room_group_id")
            .nestedList("studentAssignments", LecturerWorkloadStudent.class, "lecturerWorkloadId", "lecturerId", "studentId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("LECTURERWORKLOAD_NOT_FOUND", "LecturerWorkload not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteLecturerWorkload").entity(LecturerWorkload.class).delete()
            .errorStatus("LECTURERWORKLOAD_NOT_FOUND", "LecturerWorkload not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // LecturerWorkloadStudent
    // -------------------------------------------------------------------------

    /**
     * LecturerWorkloadStudent has no standalone queries/mutations of its own — pairings are only
     * ever created, updated and deleted as part of LecturerWorkload's create/update mutations (see
     * the "studentAssignments" nestedList above). It still needs to be registered as a GraphQL type
     * so LecturerWorkload.studentAssignments can resolve to it.
     */
    private void configureLecturerWorkloadStudent(SchemaDefinition s) {
        s.type(LecturerWorkloadStudent.class)
            .relation("lecturer")
            .relation("student");
    }

    // -------------------------------------------------------------------------
    // LecturerWorkloadCandidate
    // -------------------------------------------------------------------------

    /**
     * Unlike the other children of LecturerWorkload, a candidate has children of its own (its
     * student-count limits), and the framework's nested lists only go one level deep — so a
     * candidate is written through its own mutations, carrying `constraints` as *its* nested list,
     * rather than through LecturerWorkload's input payload. That also keeps a single writer for
     * these rows: a nested list on the workload would reconcile (and delete) candidates behind the
     * back of the mutations below.
     */
    private void configureLecturerWorkloadCandidate(SchemaDefinition s) {
        s.type(LecturerWorkloadCandidate.class)
            .fields("desirability")
            .relation("lecturer")
            .relation("constraints");

        s.mutation("createLecturerWorkloadCandidate").entity(LecturerWorkloadCandidate.class).create()
            .inputFields("lecturerWorkloadId", "lecturerId", "desirability")
            .nestedList("constraints", LecturerWorkloadCandidateConstraint.class,
                "lecturerWorkloadCandidateId", "constraintType", "value")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateLecturerWorkloadCandidate").entity(LecturerWorkloadCandidate.class).update()
            .inputFields("lecturerWorkloadId", "lecturerId", "desirability")
            .nestedList("constraints", LecturerWorkloadCandidateConstraint.class,
                "lecturerWorkloadCandidateId", "constraintType", "value")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("LECTURERWORKLOADCANDIDATE_NOT_FOUND", "LecturerWorkloadCandidate not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteLecturerWorkloadCandidate").entity(LecturerWorkloadCandidate.class).delete()
            .errorStatus("LECTURERWORKLOADCANDIDATE_NOT_FOUND", "LecturerWorkloadCandidate not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    /**
     * Registered so LecturerWorkloadCandidate.constraints resolves; written only through the
     * `constraints` nested list above.
     */
    private void configureLecturerWorkloadCandidateConstraint(SchemaDefinition s) {
        s.type(LecturerWorkloadCandidateConstraint.class)
            .fields("constraintType", "value");
    }

    // -------------------------------------------------------------------------
    // ClassStartTimeSet
    // -------------------------------------------------------------------------

    /**
     * A named grid of start times ("розклад дзвінків"), which a LecturerWorkload picks and its
     * timetable entries then choose a time out of.
     *
     * Two invariants live in the database rather than here, because they are conditions on the
     * whole table that a per-row payload cannot see: at most one set may be the default
     * (class_start_time_sets_single_default), and a faculty-scoped set may never be the default
     * (class_start_time_sets_default_scope_check). Both surface to the client as DUPLICATED_KEY
     * and CONSTRAINT_VIOLATION respectively.
     *
     * Moving the default is likewise a whole-table operation — the old default has to be cleared
     * before, or in the same statement as, the new one is set — so the client updates the outgoing
     * set first and only then the incoming one.
     */
    private void configureClassStartTimeSet(SchemaDefinition s) {
        s.type(ClassStartTimeSet.class)
            .fields("name", "isDefault")
            .nullableRelation("faculty")
            .relation("classStartTimes");

        s.query("classStartTimeSetConnection").entity(ClassStartTimeSet.class).connection().orderBy("name")
            .filter("facultyId", "faculty_id");
        s.query("classStartTimeSet").entity(ClassStartTimeSet.class).findById();

        s.mutation("createClassStartTimeSet").entity(ClassStartTimeSet.class).create()
            .inputFields("name", "isDefault", "facultyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateClassStartTimeSet").entity(ClassStartTimeSet.class).update()
            .inputFields("name", "isDefault", "facultyId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("CLASSSTARTTIMESET_NOT_FOUND", "ClassStartTimeSet not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteClassStartTimeSet").entity(ClassStartTimeSet.class).delete()
            .errorStatus("CLASSSTARTTIMESET_NOT_FOUND", "ClassStartTimeSet not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // ClassStartTime
    // -------------------------------------------------------------------------

    private void configureClassStartTime(SchemaDefinition s) {
        s.type(ClassStartTime.class)
            .fields("ordinal", "startTime")
            .relation("classStartTimeSet");

        // Ordered by ordinal, which is only unique *within* a set — so a caller listing more than
        // one set's times at a time gets them interleaved, and should filter by set.
        s.query("classStartTimeConnection").entity(ClassStartTime.class).connection().orderBy("ordinal")
            .filter("classStartTimeSetId", "class_start_time_set_id");
        s.query("classStartTime").entity(ClassStartTime.class).findById();

        s.mutation("createClassStartTime").entity(ClassStartTime.class).create()
            .inputFields("ordinal", "startTime", "classStartTimeSetId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateClassStartTime").entity(ClassStartTime.class).update()
            .inputFields("ordinal", "startTime", "classStartTimeSetId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("CLASSSTARTTIME_NOT_FOUND", "ClassStartTime not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteClassStartTime").entity(ClassStartTime.class).delete()
            .errorStatus("CLASSSTARTTIME_NOT_FOUND", "ClassStartTime not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // TimetableEntry
    // -------------------------------------------------------------------------

    private void configureTimetableEntry(SchemaDefinition s) {
        s.type(TimetableEntry.class)
            .fields("dayOfWeek", "weekParity")
            .relation("workload").relation("classStartTime").relation("room");

        // timetable_entries carries no semester and no room/lecturer/group of its own - those live
        // on the workload behind it - so everything a scheduler needs to read the *current* state of
        // the timetable around a faculty is an EXISTS subquery (see QueryDefinition.RelationFilter).
        //
        // The three id-list filters exist because a faculty never schedules in isolation: its rooms
        // also host other faculties' classes, its lecturers also teach other faculties' specialties,
        // and its groups are also taught by other faculties' departments. A generator has to see
        // those entries to avoid clashing with them, and must not move them. They are declared
        // separately (rather than as one OR-ed filter) because filters compose with AND: a caller
        // asks for each slice under its own alias in one request and merges them client-side.
        //
        // semesterParity narrows to one half of the year, which any query over this table must do -
        // both halves are stored at once and share rooms, so an unfiltered read reports clashes that
        // do not exist. It reaches the semester through whichever target the workload has: a single
        // working curriculum item, or the members of a combined one.
        s.query("timetableEntryConnection").entity(TimetableEntry.class).connection().orderBy("dayOfWeek")
            .filter("workloadId", "workload_id")
            .filter("roomId", "room_id")
            .relationFilterList("roomIds", "timetable_entries.room_id = ANY(:roomIds)")
            .relationFilterList("lecturerIds",
                "EXISTS (SELECT 1 FROM lecturer_workload_lecturers lwl " +
                "WHERE lwl.lecturer_workload_id = timetable_entries.workload_id " +
                "AND lwl.lecturer_id = ANY(:lecturerIds))")
            .relationFilterList("academicGroupIds",
                "(EXISTS (SELECT 1 FROM lecturer_workload_academic_groups lwag " +
                "WHERE lwag.lecturer_workload_id = timetable_entries.workload_id " +
                "AND lwag.academic_group_id = ANY(:academicGroupIds)) " +
                "OR EXISTS (SELECT 1 FROM lecturer_workload_combined_groups lwcg " +
                "JOIN combined_group_academic_groups cga ON cga.combined_group_id = lwcg.combined_group_id " +
                "WHERE lwcg.lecturer_workload_id = timetable_entries.workload_id " +
                "AND cga.academic_group_id = ANY(:academicGroupIds)))")
            .relationFilterString("semesterParity",
                "EXISTS (SELECT 1 FROM lecturer_workloads lw " +
                "LEFT JOIN working_curriculum_items w ON w.id = lw.working_curriculum_item_id " +
                "LEFT JOIN combined_working_curriculum_item_members m " +
                "ON m.combined_working_curriculum_item_id = lw.combined_working_curriculum_item_id " +
                "LEFT JOIN working_curriculum_items wm ON wm.id = m.working_curriculum_item_id " +
                "JOIN curriculum_item_hours cih " +
                "ON cih.id = COALESCE(w.curriculum_item_hours_id, wm.curriculum_item_hours_id) " +
                "JOIN curriculum_items ci ON ci.id = cih.curriculum_item_id " +
                "WHERE lw.id = timetable_entries.workload_id " +
                "AND ((:semesterParity = 'ODD' AND ci.semester % 2 = 1) " +
                "OR (:semesterParity = 'EVEN' AND ci.semester % 2 = 0)))");
        s.query("timetableEntry").entity(TimetableEntry.class).findById();

        s.mutation("createTimetableEntry").entity(TimetableEntry.class).create()
            .inputFields("dayOfWeek", "weekParity", "workloadId", "classStartTimeId", "roomId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateTimetableEntry").entity(TimetableEntry.class).update()
            .inputFields("dayOfWeek", "weekParity", "workloadId", "classStartTimeId", "roomId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("TIMETABLEENTRY_NOT_FOUND", "TimetableEntry not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteTimetableEntry").entity(TimetableEntry.class).delete()
            .errorStatus("TIMETABLEENTRY_NOT_FOUND", "TimetableEntry not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }
}
