package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToMany;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

import java.util.List;

@Data
@GraphQLEntity(table = "lecturers")
@PermissionParent(value = Department.class, joinColumn = "department_id")
public class Lecturer {

    private Long id;

    private String firstName;

    @Nullable
    private String middleName;

    private String lastName;

    @Nullable
    private String email;

    @Nullable
    @PgEnum("lecturer_position")
    @Description("Academic position: ASSISTANT, TEACHER, SENIOR_LECTURER, DOCENT, PROFESSOR, HEAD_OF_DEPARTMENT")
    private String position;

    @Nullable
    @ManyToOne(joinColumn = "academic_degree_id")
    private AcademicDegree academicDegree;

    @ManyToOne(joinColumn = "department_id")
    private Department department;

    @ManyToMany(joinTable = "lecturer_workload_lecturers",
        joinColumn = "lecturer_id", inverseJoinColumn = "lecturer_workload_id")
    private List<LecturerWorkload> workloads;

    /**
     * Workload restrictions, one row per constraint actually set — replaces the former
     * min/maxHoursPerWeek columns. Written through this entity's create/update mutations.
     */
    @OneToMany(mappedBy = "lecturer_id")
    private List<LecturerWorkloadConstraint> workloadConstraints;
}
