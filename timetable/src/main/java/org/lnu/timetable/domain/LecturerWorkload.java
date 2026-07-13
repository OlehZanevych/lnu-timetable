package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToMany;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

/**
 * Assignment of a specific lecturer to deliver a working-curriculum-item
 * to one or more academic groups and/or combined groups.
 */
@Data
@GraphQLEntity(table = "lecturer_workloads")
public class LecturerWorkload {

    private Long id;

    @ManyToOne(joinColumn = "lecturer_id")
    private Lecturer lecturer;

    @ManyToMany(joinTable = "lecturer_workload_academic_groups",
        joinColumn = "lecturer_workload_id", inverseJoinColumn = "academic_group_id")
    private List<AcademicGroup> academicGroups;

    @ManyToMany(joinTable = "lecturer_workload_combined_groups",
        joinColumn = "lecturer_workload_id", inverseJoinColumn = "combined_group_id")
    private List<CombinedGroup> combinedGroups;

    @ManyToOne(joinColumn = "working_curriculum_item_id")
    private WorkingCurriculumItem workingCurriculumItem;

    @OneToMany(mappedBy = "workload_id")
    private List<TimetableEntry> timetableEntries;
}
