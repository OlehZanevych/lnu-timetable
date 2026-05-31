package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;

@Data
@GraphQLEntity(table = "working_curriculum_items")
public class WorkingCurriculumItem {

    private Long id;

    @Nullable
    @Description("Lecture hours per semester")
    private Integer lectureHours;

    @Nullable
    @Description("Practical hours per semester")
    private Integer practicalHours;

    @Nullable
    @Description("Laboratory hours per semester")
    private Integer labHours;

    @Nullable
    @Description("Seminar hours per semester")
    private Integer seminarHours;

    @ManyToOne(joinColumn = "working_curriculum_id")
    private WorkingCurriculum workingCurriculum;

    @ManyToOne(joinColumn = "course_id")
    private Course course;
}
