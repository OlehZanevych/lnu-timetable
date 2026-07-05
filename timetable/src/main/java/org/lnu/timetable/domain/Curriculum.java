package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

@Data
@GraphQLEntity(table = "curricula")
public class Curriculum {

    private Long id;

    @ManyToOne(joinColumn = "specialty_id")
    private Specialty specialty;

    @OneToMany(mappedBy = "curriculum_id")
    private List<CurriculumItem> items;
}
