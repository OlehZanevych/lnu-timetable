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

    private String lastName;

    @Nullable
    private String email;

    @Nullable
    @Description("Academic position: ASSISTANT, SENIOR_LECTURER, DOCENT, PROFESSOR")
    private String position;

    @Nullable
    @Description("Scientific degree: PHD, DOCTOR_OF_SCIENCES")
    private String academicDegree;

    @Nullable
    @Description("Maximum teaching hours per week")
    private Integer maxHoursPerWeek;

    @ManyToOne(joinColumn = "department_id")
    private Department department;

    @OneToMany(mappedBy = "lecturer_id")
    private List<LecturerWorkload> workloads;
}
