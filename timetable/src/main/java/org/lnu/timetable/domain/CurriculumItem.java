package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PgEnum;

import java.util.List;

@Data
@GraphQLEntity(table = "curriculum_items")
public class CurriculumItem {

    private Long id;

    @Description("Semester number (1..N) in which the discipline is studied")
    private Integer semester;

    @PgEnum("control_form")
    @Description("Control form: EXAM, CREDIT, GRADED_CREDIT")
    private String controlForm;

    @Nullable
    private Integer ectsCredits;

    @ManyToOne(joinColumn = "specialty_id")
    private Specialty specialty;

    @ManyToOne(joinColumn = "course_id")
    private Course course;

    @OneToMany(mappedBy = "curriculum_item_id")
    private List<CurriculumItemHours> hours;
}
