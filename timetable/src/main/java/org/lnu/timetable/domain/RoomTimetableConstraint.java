package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

/**
 * One scheduling restriction on a room — when, and how densely, it may be given classes.
 * These do not describe a timetable; they restrict the ones a scheduler is allowed to build.
 * <p>
 * Four types cover the eight rules the faculty asks for, because each either applies to every day
 * or to one named day — {@code dayOfWeek} null means "every day":
 * <ul>
 *   <li>{@code MAX_CLASSES_PER_DAY} — at most N classes; value is the count, e.g. {@code "3"}</li>
 *   <li>{@code NOT_BEFORE} — nothing may start before this time, e.g. {@code "12:30"}</li>
 *   <li>{@code NOT_AFTER} — nothing may end after this time, e.g. {@code "17:00"}</li>
 *   <li>{@code UNAVAILABLE} — nothing may overlap the window, e.g. {@code "13:10-14:00"}</li>
 * </ul>
 * A day-specific row overrides the every-day row of the same type for that day; UNAVAILABLE
 * windows accumulate instead, several disjoint gaps in a day being a normal thing to want. The
 * value's form per type is enforced by room_timetable_constraints_value_check in schema.sql, so a
 * malformed string is rejected by the database rather than silently mis-read.
 * <p>
 * Rows are written exclusively through Room's create/update mutations via the
 * {@code timetableConstraints} nested list — there are no standalone mutations, so a
 * room's whole constraint set is replaced in one call and can be validated as a whole,
 * the same arrangement {@link LecturerWorkloadConstraint} uses.
 */
@Data
@GraphQLEntity(table = "room_timetable_constraints")
@PermissionParent(value = Room.class, joinColumn = "room_id")
public class RoomTimetableConstraint {

    private Long id;

    @PgEnum("timetable_constraint_type")
    @Description("MAX_CLASSES_PER_DAY, NOT_BEFORE, NOT_AFTER, UNAVAILABLE")
    private String constraintType;

    @Nullable
    @Description("Day of week the rule applies to, 1..7 with Monday = 1; null means every day")
    private Integer dayOfWeek;

    @Description("Serialized per constraintType: a count for MAX_CLASSES_PER_DAY, "
        + "HH:MM for NOT_BEFORE and NOT_AFTER, HH:MM-HH:MM for UNAVAILABLE")
    private String constraintValue;

    @ManyToOne(joinColumn = "room_id")
    private Room room;
}
