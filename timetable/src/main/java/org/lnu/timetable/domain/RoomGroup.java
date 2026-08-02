package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToMany;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.PermissionParent;

import java.util.List;

/**
 * A named, reusable set of rooms — "Комп'ютерні класи", "Спортивні зали", "Потокові аудиторії".
 *
 * A {@link LecturerWorkload} may name individual rooms, whole room groups, or both; the rooms it
 * may actually be scheduled in are the union. Groups exist for reuse: the same handful of rooms is
 * eligible for dozens of workloads, and a room later added to the group widens every workload that
 * points at it without any of them being edited.
 *
 * A group may be scoped so that it is only offered where it belongs: {@link #faculty} limits it to
 * that faculty's departments, {@link #department} to a single department, and both null makes it
 * university-wide. The two are mutually exclusive (a department already implies its faculty) —
 * enforced by room_groups_scope_check in the database. The scope governs who may *reach for* the
 * group, not what may be in it: a department's group routinely holds rooms owned by the faculty
 * or by nobody at all.
 */
@Data
@GraphQLEntity(table = "room_groups")
@PermissionParent(value = Faculty.class, joinColumn = "faculty_id", nullable = true)
@PermissionParent(value = Department.class, joinColumn = "department_id", nullable = true)
public class RoomGroup {

    private Long id;

    @Description("Room group name, e.g. \"Комп'ютерні класи\"")
    private String name;

    @Nullable
    @Description("What this set of rooms is for")
    private String purpose;

    /** Limits the group to one faculty's departments; null means university-wide. */
    @Nullable
    @ManyToOne(joinColumn = "faculty_id")
    private Faculty faculty;

    /** Limits the group to a single department; never set together with {@link #faculty}. */
    @Nullable
    @ManyToOne(joinColumn = "department_id")
    private Department department;

    @ManyToMany(joinTable = "room_group_rooms",
        joinColumn = "room_group_id", inverseJoinColumn = "room_id")
    private List<Room> rooms;

    @ManyToMany(joinTable = "lecturer_workload_room_groups",
        joinColumn = "room_group_id", inverseJoinColumn = "lecturer_workload_id")
    private List<LecturerWorkload> workloads;
}
