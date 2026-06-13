package org.lnu.timetable.config;

import org.lnu.timetable.domain.*;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.config.SchemaDefinition;
import org.springframework.stereotype.Component;

/**
 * GraphQL types, queries and mutations for scheduling entities:
 * LecturerWorkload, TimeSlot, TimetableEntry.
 */
@Component
public class SchedulingSchemaConfig implements GraphQLSchemaConfig {

    @Override
    public void configure(SchemaDefinition s) {
        configureLecturerWorkload(s);
        configureTimeSlot(s);
        configureTimetableEntry(s);
    }

    // -------------------------------------------------------------------------
    // LecturerWorkload
    // -------------------------------------------------------------------------

    private void configureLecturerWorkload(SchemaDefinition s) {
        s.type(LecturerWorkload.class)
            .fields("classType", "periodicity", "hoursPerWeek")
            .relation("lecturer").relation("course")
            .nullableRelation("academicGroup").nullableRelation("combinedGroup").nullableRelation("workingCurriculum")
            .relation("timetableEntries");

        s.query("lecturerWorkloadConnection").entity(LecturerWorkload.class).connection().orderBy("id").filter("lecturerId", "lecturer_id");
        s.query("lecturerWorkload").entity(LecturerWorkload.class).findById();

        s.mutation("createLecturerWorkload").entity(LecturerWorkload.class).create()
            .inputFields("classType", "periodicity", "hoursPerWeek", "lecturerId", "courseId",
                "academicGroupId", "combinedGroupId", "workingCurriculumId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateLecturerWorkload").entity(LecturerWorkload.class).update()
            .inputFields("classType", "periodicity", "hoursPerWeek", "lecturerId", "courseId",
                "academicGroupId", "combinedGroupId", "workingCurriculumId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("LECTURERWORKLOAD_NOT_FOUND", "LecturerWorkload not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteLecturerWorkload").entity(LecturerWorkload.class).delete()
            .errorStatus("LECTURERWORKLOAD_NOT_FOUND", "LecturerWorkload not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // TimeSlot
    // -------------------------------------------------------------------------

    private void configureTimeSlot(SchemaDefinition s) {
        s.type(TimeSlot.class)
            .fields("ordinal", "startTime", "endTime");

        s.query("timeSlotConnection").entity(TimeSlot.class).connection().orderBy("ordinal");
        s.query("timeSlot").entity(TimeSlot.class).findById();

        s.mutation("createTimeSlot").entity(TimeSlot.class).create()
            .inputFields("ordinal", "startTime", "endTime")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateTimeSlot").entity(TimeSlot.class).update()
            .inputFields("ordinal", "startTime", "endTime")
            .errorStatus("TIMESLOT_NOT_FOUND", "TimeSlot not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteTimeSlot").entity(TimeSlot.class).delete()
            .errorStatus("TIMESLOT_NOT_FOUND", "TimeSlot not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }

    // -------------------------------------------------------------------------
    // TimetableEntry
    // -------------------------------------------------------------------------

    private void configureTimetableEntry(SchemaDefinition s) {
        s.type(TimetableEntry.class)
            .fields("dayOfWeek", "weekParity")
            .relation("workload").relation("timeSlot").relation("room");

        s.query("timetableEntryConnection").entity(TimetableEntry.class).connection().orderBy("dayOfWeek").filter("workloadId", "workload_id");
        s.query("timetableEntry").entity(TimetableEntry.class).findById();

        s.mutation("createTimetableEntry").entity(TimetableEntry.class).create()
            .inputFields("dayOfWeek", "weekParity", "workloadId", "timeSlotId", "roomId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("updateTimetableEntry").entity(TimetableEntry.class).update()
            .inputFields("dayOfWeek", "weekParity", "workloadId", "timeSlotId", "roomId")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("TIMETABLEENTRY_NOT_FOUND", "TimetableEntry not found")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");

        s.mutation("deleteTimetableEntry").entity(TimetableEntry.class).delete()
            .errorStatus("TIMETABLEENTRY_NOT_FOUND", "TimetableEntry not found")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
    }
}
