package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToMany;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

import java.util.List;

@Data
@GraphQLEntity(table = "working_curriculum_items")
@PermissionParent(value = Department.class, joinColumn = "department_id")
@PermissionParent(value = CurriculumItemHours.class, joinColumn = "curriculum_item_hours_id")
@PermissionParent(value = Course.class, joinColumn = "course_id", nullable = true)
public class WorkingCurriculumItem {

    private Long id;

    @Description("Number of lecturers assigned to deliver this item")
    private Integer lecturerCount;

    @PgEnum("teaching_format")
    @Description("Whether all lecturers teach together (TOGETHER) or each group separately (SEPARATELY)")
    private String teachingFormat;

    @ManyToOne(joinColumn = "curriculum_item_hours_id")
    private CurriculumItemHours curriculumItemHours;

    @ManyToOne(joinColumn = "department_id")
    private Department department;

    @Nullable
    @Description("Specific elective chosen by the group; set only when curriculum item is an ELECTIVE_GROUP")
    @ManyToOne(joinColumn = "course_id")
    private Course course;

    @ManyToMany(joinTable = "working_curriculum_item_groups",
        joinColumn = "working_curriculum_item_id", inverseJoinColumn = "academic_group_id")
    private List<AcademicGroup> academicGroups;

    @ManyToMany(joinTable = "combined_working_curriculum_item_members",
        joinColumn = "working_curriculum_item_id", inverseJoinColumn = "combined_working_curriculum_item_id")
    private List<CombinedWorkingCurriculumItem> combinedWorkingCurriculumItems;

    @OneToMany(mappedBy = "working_curriculum_item_id")
    private List<LecturerWorkload> workloads;
}
