package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;

@Data
@GraphQLEntity(table = "curriculum_items")
public class CurriculumItem {

    private Long id;

    @Description("Semester number (1..N) in which the discipline is studied")
    private Integer semester;

    @Description("Control form: EXAM or CREDIT")
    private String controlForm;

    @Nullable
    private Integer ectsCredits;

    @ManyToOne(joinColumn = "curriculum_id")
    private Curriculum curriculum;

    @ManyToOne(joinColumn = "course_id")
    private Course course;
}
