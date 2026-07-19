package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

/**
 * A scheduled class — the timetabling output (the article's "gene"):
 * a class requirement assigned to a day, class start time, room and week parity.
 */
@Data
@GraphQLEntity(table = "timetable_entries")
@PermissionParent(value = LecturerWorkload.class, joinColumn = "workload_id")
@PermissionParent(value = Room.class, joinColumn = "room_id")
public class TimetableEntry {

    private Long id;

    @Description("Day of week, 1 = Monday .. 6 = Saturday")
    private Integer dayOfWeek;

    @PgEnum("week_parity")
    @Description("Week parity: WEEKLY, NUMERATOR or DENOMINATOR")
    private String weekParity;

    @ManyToOne(joinColumn = "workload_id")
    private LecturerWorkload workload;

    @ManyToOne(joinColumn = "class_start_time_id")
    private ClassStartTime classStartTime;

    @ManyToOne(joinColumn = "room_id")
    private Room room;
}
