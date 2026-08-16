package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionRoot;

import java.util.List;

@Data
@PermissionRoot("Науковий ступінь is defined by the state and shared by every faculty; nobody here owns one")
@GraphQLEntity(table = "academic_degrees")
public class AcademicDegree {

    private Long id;

    @Description("Full Ukrainian name of the degree (e.g. Доктор філософії)")
    private String name;

    @Nullable
    @Description("Short abbreviation (e.g. PhD, к.н., д-р н.)")
    private String abbreviation;

    @Description("Ordering level: 1=Кандидат наук, 2=Доктор філософії, 3=Доктор наук")
    private Integer level;

    @OneToMany(mappedBy = "academic_degree_id")
    private List<Lecturer> lecturers;
}
