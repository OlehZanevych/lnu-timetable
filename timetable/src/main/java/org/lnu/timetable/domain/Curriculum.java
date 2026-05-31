package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

@Data
@GraphQLEntity(table = "curricula")
public class Curriculum {

    private Long id;

    @Description("Curriculum name (навчальний план)")
    private String name;

    @Description("Year students were admitted, e.g. 2023")
    private Integer admissionYear;

    @Description("Degree level: BACHELOR, MASTER or PHD")
    private String degree;

    @ManyToOne(joinColumn = "specialty_id")
    private Specialty specialty;

    @OneToMany(mappedBy = "curriculum_id")
    private List<CurriculumItem> items;

    @OneToMany(mappedBy = "curriculum_id")
    private List<WorkingCurriculum> workingCurricula;
}
