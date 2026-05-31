package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

@Data
@GraphQLEntity(table = "working_curricula")
public class WorkingCurriculum {

    private Long id;

    @Description("Academic year, e.g. 2025/2026 (робочий навчальний план)")
    private String academicYear;

    @Description("Semester number this working plan covers")
    private Integer semester;

    @ManyToOne(joinColumn = "curriculum_id")
    private Curriculum curriculum;

    @OneToMany(mappedBy = "working_curriculum_id")
    private List<WorkingCurriculumItem> items;
}
