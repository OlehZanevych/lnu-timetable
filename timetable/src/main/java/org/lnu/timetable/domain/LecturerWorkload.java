package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToMany;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.OneToOne;
import org.lnu.timetable.framework.annotation.PermissionJoinParent;
import org.lnu.timetable.framework.annotation.PermissionParent;

import java.util.List;

/**
 * Assignment of one or more lecturers to deliver a working-curriculum-item (or a
 * combined-working-curriculum-item, for lecturers who simultaneously teach several working
 * curriculum items at once, e.g. groups from different specialties attending one shared lecture)
 * to one or more academic groups and/or combined groups.
 */
@Data
@GraphQLEntity(table = "lecturer_workloads")
@PermissionParent(value = WorkingCurriculumItem.class, joinColumn = "working_curriculum_item_id", nullable = true)
@PermissionParent(value = CombinedWorkingCurriculumItem.class, joinColumn = "combined_working_curriculum_item_id", nullable = true)
@PermissionJoinParent(value = Lecturer.class, joinTable = "lecturer_workload_lecturers",
    selfColumn = "lecturer_workload_id", parentColumn = "lecturer_id")
@PermissionJoinParent(value = AcademicGroup.class, joinTable = "lecturer_workload_academic_groups",
    selfColumn = "lecturer_workload_id", parentColumn = "academic_group_id")
@PermissionJoinParent(value = CombinedGroup.class, joinTable = "lecturer_workload_combined_groups",
    selfColumn = "lecturer_workload_id", parentColumn = "combined_group_id")
// Rooms and room groups are intentionally *not* permission parents: being able to modify a room,
// or the list of rooms in a group, must not confer the right to modify every workload that happens
// to be allowed to use it.
public class LecturerWorkload {

    private Long id;

    @ManyToMany(joinTable = "lecturer_workload_lecturers",
        joinColumn = "lecturer_workload_id", inverseJoinColumn = "lecturer_id")
    private List<Lecturer> lecturers;

    @ManyToMany(joinTable = "lecturer_workload_academic_groups",
        joinColumn = "lecturer_workload_id", inverseJoinColumn = "academic_group_id")
    private List<AcademicGroup> academicGroups;

    @ManyToMany(joinTable = "lecturer_workload_combined_groups",
        joinColumn = "lecturer_workload_id", inverseJoinColumn = "combined_group_id")
    private List<CombinedGroup> combinedGroups;

    /**
     * Rooms this workload's classes may be held in, named individually — for the lecture that must
     * happen in the one hall big enough for it.
     *
     * Together with {@link #roomGroups} these form the eligible set, as a **union**; when both are
     * empty the workload is unrestricted and may be scheduled anywhere, which is the right default
     * for the many ordinary classes with no particular requirement.
     */
    @ManyToMany(joinTable = "lecturer_workload_rooms",
        joinColumn = "lecturer_workload_id", inverseJoinColumn = "room_id")
    private List<Room> rooms;

    /**
     * Whole reusable room groups this workload may use — for the lab that can run in any computer
     * class, which stays correct when a room is later added to the group.
     */
    @ManyToMany(joinTable = "lecturer_workload_room_groups",
        joinColumn = "lecturer_workload_id", inverseJoinColumn = "room_group_id")
    private List<RoomGroup> roomGroups;

    /**
     * The one place that is not a room this workload may be held in — «Спортивні зали» and the
     * like, shared with the other classes sitting in it that hour (see {@link AbstractRoom}).
     *
     * A list in GraphQL because the framework reads a join table as a many-to-many, but
     * lecturer_workload_abstract_rooms is keyed on the workload alone, so the database guarantees
     * at most one element. Setting it is the alternative to naming rooms, not an addition to them.
     */
    @ManyToMany(joinTable = "lecturer_workload_abstract_rooms",
        joinColumn = "lecturer_workload_id", inverseJoinColumn = "abstract_room_id")
    private List<AbstractRoom> abstractRooms;

    /**
     * Present when this workload is held online and absent when it is not — the row *is* the fact
     * (see {@link LecturerWorkloadOnlineClass}). The inverse side of the one-to-one: the foreign
     * key is the child's own primary key, which is what limits it to one row per workload.
     */
    @Nullable
    @OneToOne(mappedBy = "lecturer_workload_id")
    private LecturerWorkloadOnlineClass onlineClass;

    // Exactly one of workingCurriculumItem / combinedWorkingCurriculumItem is set (enforced by
    // the lecturer_workloads_target_check DB constraint).
    @Nullable
    @ManyToOne(joinColumn = "working_curriculum_item_id")
    private WorkingCurriculumItem workingCurriculumItem;

    @Nullable
    @ManyToOne(joinColumn = "combined_working_curriculum_item_id")
    private CombinedWorkingCurriculumItem combinedWorkingCurriculumItem;

    /**
     * Lecturer&harr;student pairings, used only when the underlying working curriculum item is
     * taught INDIVIDUALLY; empty for TOGETHER/SEPARATELY items, which assign academic groups
     * instead. Written exclusively through this entity's create/update mutations.
     */
    @OneToMany(mappedBy = "lecturer_workload_id")
    private List<LecturerWorkloadStudent> studentAssignments;

    /**
     * Lecturers who could deliver this workload, scored by desirability — the candidate pool
     * automatic generation chooses from. Independent of {@link #lecturers}, which is who was
     * actually assigned.
     */
    @OneToMany(mappedBy = "lecturer_workload_id")
    private List<LecturerWorkloadCandidate> candidates;

    @Description("Duration of each class for this workload, in academic hours (1-4)")
    private Integer durationHours;

    /**
     * The grid of start times this workload's classes are scheduled on — a property of the class
     * rather than of one weekly occurrence, since e.g. physical education runs on its own bells
     * for all of its classes. Every {@link TimetableEntry} below must pick a time out of this set.
     *
     * Non-null: the UI defaults it to the set marked as default (see ClassStartTimeSet.isDefault),
     * so it is one fewer decision at the point of assigning a lecturer.
     */
    @ManyToOne(joinColumn = "class_start_time_set_id")
    private ClassStartTimeSet classStartTimeSet;

    @OneToMany(mappedBy = "workload_id")
    private List<TimetableEntry> timetableEntries;
}
