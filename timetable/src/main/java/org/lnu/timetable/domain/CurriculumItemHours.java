package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

import java.util.List;

@Data
@GraphQLEntity(table = "curriculum_item_hours")
@PermissionParent(value = CurriculumItem.class, joinColumn = "curriculum_item_id")
public class CurriculumItemHours {

    private Long id;

    @PgEnum("hour_type")
    @Description("Type of hours: LECTURE, PRACTICAL, LAB, INDEPENDENT_WORK")
    private String hourType;

    @Description("Number of hours for this type in the curriculum item")
    private Integer hours;

    @ManyToOne(joinColumn = "curriculum_item_id")
    private CurriculumItem curriculumItem;

    @OneToMany(mappedBy = "curriculum_item_hours_id")
    private List<WorkingCurriculumItem> workingCurriculumItems;
}
