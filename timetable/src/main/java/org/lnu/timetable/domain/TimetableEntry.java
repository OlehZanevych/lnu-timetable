package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;

/**
 * A scheduled class — the timetabling output (the article's "gene"):
 * a class requirement assigned to a day, timeslot, room and week parity.
 */
@Data
@GraphQLEntity(table = "timetable_entries")
public class TimetableEntry {

    private Long id;

    @Description("Day of week, 1 = Monday .. 6 = Saturday")
    private Integer dayOfWeek;

    @Description("Week parity: WEEKLY, NUMERATOR or DENOMINATOR")
    private String weekParity;

    @ManyToOne(joinColumn = "workload_id")
    private LecturerWorkload workload;

    @ManyToOne(joinColumn = "time_slot_id")
    private TimeSlot timeSlot;

    @ManyToOne(joinColumn = "room_id")
    private Room room;
}
