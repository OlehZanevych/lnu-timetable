package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

/**
 * A scheduled class — the timetabling output (the article's "gene"):
 * a class requirement assigned to a day, class start time, room and week parity.
 */
@Data
@GraphQLEntity(table = "timetable_entries")
@PermissionParent(value = LecturerWorkload.class, joinColumn = "workload_id")
// Nullable since V7: an entry need not have a room. The workload edge above is unconditional, so a
// roomless entry is still covered by a grant — this path simply does not apply to it.
//
// authority = false: the edge exists so that whoever administers a room can reach the classes held
// in it, NOT so that scheduling a class into a room requires administering the room. A кафедра's
// timetabler books shared lecture halls all day and administers none of them; the workload edge
// above is the one that says who owns this entry.
@PermissionParent(value = Room.class, joinColumn = "room_id", nullable = true, authority = false)
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

    /**
     * Where the class is, when the answer is a room. Null when it is not: a class in a shared
     * {@link AbstractRoom} has nothing to allocate, and one held online has nowhere to be. Which of
     * the two it is is read from the workload rather than copied onto the entry, since a second
     * copy could only ever disagree with the first — see V7__abstract_rooms_and_online_classes.sql.
     */
    @Nullable
    @ManyToOne(joinColumn = "room_id")
    private Room room;
}
