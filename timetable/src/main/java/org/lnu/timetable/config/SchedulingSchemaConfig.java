package org.lnu.timetable.config;

import org.lnu.timetable.domain.*;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.config.SchemaDefinition;
import org.springframework.stereotype.Component;

/**
 * GraphQL types, queries and mutations for scheduling entities:
 * LecturerWorkload, ClassStartTime, TimetableEntry.
 */
@Component
public class SchedulingSchemaConfig implements GraphQLSchemaConfig {

    @Override
    public void configure(SchemaDefinition s) {
        configureLecturerWorkload(s);
        configureLecturerWorkloadStudent(s);
        configureClassStartTime(s);
        configureTimetableEntry(s);
    }

    // -------------------------------------------------------------------------
    // LecturerWorkload
    // -------------------------------------------------------------------------

    private void configureLecturerWorkload(SchemaDefinition s) {
        s.type(LecturerWorkload.class)
            .fields("durationHours")
            .relation("lecturers")
            .relation("academicGroups")
            .relation("combinedGroups")
            .relation("studentAssignments")
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
            .inputFields("workingCurriculumItemId", "combinedWorkingCurriculumItemId", "durationHours")
            .manyToMany("lecturerIds", "lecturer_workload_lecturers", "lecturer_workload_id", "lecturer_id")
            .manyToMany("academicGroupIds", "lecturer_workload_academic_groups", "lecturer_workload_id", "academic_group_id")
            .manyToMany("combinedGroupIds", "lecturer_workload_combined_groups", "lecturer_workload_id", "combined_group_id")
            .nestedList("studentAssignments", LecturerWorkloadStudent.class, "lecturerWorkloadId", "lecturerId", "studentId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateLecturerWorkload").entity(LecturerWorkload.class).update()
            .inputFields("workingCurriculumItemId", "combinedWorkingCurriculumItemId", "durationHours")
            .manyToMany("lecturerIds", "lecturer_workload_lecturers", "lecturer_workload_id", "lecturer_id")
            .manyToMany("academicGroupIds", "lecturer_workload_academic_groups", "lecturer_workload_id", "academic_group_id")
            .manyToMany("combinedGroupIds", "lecturer_workload_combined_groups", "lecturer_workload_id", "combined_group_id")
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
    // ClassStartTime
    // -------------------------------------------------------------------------

    private void configureClassStartTime(SchemaDefinition s) {
        s.type(ClassStartTime.class)
            .fields("ordinal", "startTime");

        s.query("classStartTimeConnection").entity(ClassStartTime.class).connection().orderBy("ordinal");
        s.query("classStartTime").entity(ClassStartTime.class).findById();

        s.mutation("createClassStartTime").entity(ClassStartTime.class).create()
            .inputFields("ordinal", "startTime")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateClassStartTime").entity(ClassStartTime.class).update()
            .inputFields("ordinal", "startTime")
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

        s.query("timetableEntryConnection").entity(TimetableEntry.class).connection().orderBy("dayOfWeek").filter("workloadId", "workload_id");
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
