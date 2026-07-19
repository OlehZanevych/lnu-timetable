package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToMany;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.PermissionJoinParent;

import java.util.List;

@Data
@GraphQLEntity(table = "combined_groups")
@PermissionJoinParent(value = AcademicGroup.class, joinTable = "combined_group_academic_groups",
    selfColumn = "combined_group_id", parentColumn = "academic_group_id")
public class CombinedGroup {

    private Long id;

    @Description("Combined group name, built from several academic groups for elective disciplines")
    private String name;

    @Nullable
    @Description("Elective discipline / purpose this combined group attends")
    private String purpose;

    @ManyToMany(joinTable = "combined_group_academic_groups",
        joinColumn = "combined_group_id", inverseJoinColumn = "academic_group_id")
    private List<AcademicGroup> academicGroups;

    @ManyToMany(joinTable = "lecturer_workload_combined_groups",
        joinColumn = "combined_group_id", inverseJoinColumn = "lecturer_workload_id")
    private List<LecturerWorkload> workloads;
}
