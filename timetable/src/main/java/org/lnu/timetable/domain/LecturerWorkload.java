package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

/**
 * Assignment of a specific lecturer to deliver a working-curriculum-item
 * to an academic group or combined group.
 */
@Data
@GraphQLEntity(table = "lecturer_workloads")
public class LecturerWorkload {

    private Long id;

    @ManyToOne(joinColumn = "lecturer_id")
    private Lecturer lecturer;

    @Nullable
    @ManyToOne(joinColumn = "academic_group_id")
    private AcademicGroup academicGroup;

    @Nullable
    @ManyToOne(joinColumn = "combined_group_id")
    private CombinedGroup combinedGroup;

    @ManyToOne(joinColumn = "working_curriculum_item_id")
    private WorkingCurriculumItem workingCurriculumItem;

    @OneToMany(mappedBy = "workload_id")
    private List<TimetableEntry> timetableEntries;
}
