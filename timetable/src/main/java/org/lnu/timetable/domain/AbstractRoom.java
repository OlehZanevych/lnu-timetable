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
 * A place a class is held in that is not one room — «Спортивні зали», «Басейн», «Дистанційно з
 * кафедри». One line on the розклад that the classes of half a faculty legitimately share at the
 * same hour.
 *
 * Deliberately not a {@link Room}: everything reasoning about rooms is built on one room holding
 * one class at a time, so recording this as a room would be a lie the scheduler believes. Nothing
 * that tests room exclusivity reads this table.
 *
 * It may belong to a {@link Building}, and then the journey to it is that building's out of
 * {@link BuildingTravelTime} exactly as for a room; when it does not, there is no address to
 * measure from and the journey is the flat {@code abstract_room_travel_time_minutes} global
 * property. {@link #capacity} is unlike a room's in the same way the place is: it caps the
 * *total* students of the classes sharing it in one slot, not the size of any one of them.
 */
@Data
@GraphQLEntity(table = "abstract_rooms")
@PermissionParent(value = Faculty.class, joinColumn = "faculty_id", nullable = true)
@PermissionParent(value = Building.class, joinColumn = "building_id", nullable = true)
public class AbstractRoom {

    private Long id;

    @Description("Name of the place, e.g. \"Спортивні зали\"")
    private String name;

    @Nullable
    @Description("What this place is for")
    private String purpose;

    @Nullable
    @Description("Ceiling on the total students of all classes sharing this place in one slot")
    private Integer capacity;

    /** Where the place is; null means it has no address, and the flat travel time applies. */
    @Nullable
    @ManyToOne(joinColumn = "building_id")
    private Building building;

    /** Limits the place to one faculty; null means university-wide. */
    @Nullable
    @ManyToOne(joinColumn = "faculty_id")
    private Faculty faculty;

    /**
     * The workloads held here. The join table keys on the workload alone, so a workload names at
     * most one abstract room while an abstract room hosts as many workloads as fit inside
     * {@link #capacity} — which is the whole asymmetry this entity exists for.
     */
    @ManyToMany(joinTable = "lecturer_workload_abstract_rooms",
        joinColumn = "abstract_room_id", inverseJoinColumn = "lecturer_workload_id")
    private List<LecturerWorkload> workloads;
}
