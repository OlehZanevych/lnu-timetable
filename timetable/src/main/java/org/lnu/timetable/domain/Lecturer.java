package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

@Data
@GraphQLEntity(table = "lecturers")
public class Lecturer {

    private Long id;

    private String firstName;

    @Nullable
    private String middleName;

    private String lastName;

    @Nullable
    private String email;

    @Nullable
    @Description("Academic position: ASSISTANT, TEACHER, SENIOR_LECTURER, DOCENT, PROFESSOR, HEAD_OF_DEPARTMENT")
    private String position;

    @Nullable
    @Description("Maximum teaching hours per week")
    private Integer maxHoursPerWeek;

    @Nullable
    @ManyToOne(joinColumn = "academic_degree_id")
    private AcademicDegree academicDegree;

    @ManyToOne(joinColumn = "department_id")
    private Department department;

    @OneToMany(mappedBy = "lecturer_id")
    private List<LecturerWorkload> workloads;
}
