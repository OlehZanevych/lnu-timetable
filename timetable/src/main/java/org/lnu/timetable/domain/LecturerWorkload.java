package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToMany;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

/**
 * Assignment of one or more lecturers to deliver a working-curriculum-item (or a
 * combined-working-curriculum-item, for lecturers who simultaneously teach several working
 * curriculum items at once, e.g. groups from different specialties attending one shared lecture)
 * to one or more academic groups and/or combined groups.
 */
@Data
@GraphQLEntity(table = "lecturer_workloads")
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

    // Exactly one of workingCurriculumItem / combinedWorkingCurriculumItem is set (enforced by
    // the lecturer_workloads_target_check DB constraint).
    @Nullable
    @ManyToOne(joinColumn = "working_curriculum_item_id")
    private WorkingCurriculumItem workingCurriculumItem;

    @Nullable
    @ManyToOne(joinColumn = "combined_working_curriculum_item_id")
    private CombinedWorkingCurriculumItem combinedWorkingCurriculumItem;

    @Description("Duration of each class for this workload, in academic hours (1-4)")
    private Integer durationHours;

    @OneToMany(mappedBy = "workload_id")
    private List<TimetableEntry> timetableEntries;
}
