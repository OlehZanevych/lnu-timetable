package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToMany;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionJoinParent;

import java.util.List;

/**
 * Bundles several working curriculum items that relate to the same course, semester, and hour
 * type (typically the same discipline taught to groups from different degree programmes) into one
 * whole, so a single lecturer_workloads assignment can cover all of them at once (e.g. lecturers
 * who deliver one shared lecture to several degree programmes simultaneously).
 */
@Data
@GraphQLEntity(table = "combined_working_curriculum_items")
@PermissionJoinParent(value = WorkingCurriculumItem.class, joinTable = "combined_working_curriculum_item_members",
    selfColumn = "combined_working_curriculum_item_id", parentColumn = "working_curriculum_item_id")
public class CombinedWorkingCurriculumItem {

    private Long id;

    @ManyToMany(joinTable = "combined_working_curriculum_item_members",
        joinColumn = "combined_working_curriculum_item_id", inverseJoinColumn = "working_curriculum_item_id")
    private List<WorkingCurriculumItem> workingCurriculumItems;

    @OneToMany(mappedBy = "combined_working_curriculum_item_id")
    private List<LecturerWorkload> workloads;
}
