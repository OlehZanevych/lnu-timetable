package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.PgEnum;

@Data
@GraphQLEntity(table = "curriculum_item_hours")
public class CurriculumItemHours {

    private Long id;

    @PgEnum("hour_type")
    @Description("Type of hours: LECTURE, PRACTICAL, LAB, INDEPENDENT_WORK")
    private String hourType;

    @Description("Number of hours for this type in the curriculum item")
    private Integer hours;

    @ManyToOne(joinColumn = "curriculum_item_id")
    private CurriculumItem curriculumItem;
}
