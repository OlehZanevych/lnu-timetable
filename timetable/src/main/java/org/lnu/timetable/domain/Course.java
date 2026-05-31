package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;

@Data
@GraphQLEntity(table = "courses")
public class Course {

    private Long id;

    @Nullable
    private String code;

    @Description("Discipline name, e.g. Database Systems")
    private String name;

    @Nullable
    @Description("ECTS credits for the whole discipline")
    private Integer ectsCredits;

    @ManyToOne(joinColumn = "department_id")
    private Department department;
}
