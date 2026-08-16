package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

import java.util.List;

@Data
@GraphQLEntity(table = "degree_programs")
@PermissionParent(value = Faculty.class, joinColumn = "faculty_id")
public class DegreeProgram {

    private Long id;

    @Description("Code of the specialty the programme belongs to, e.g. 122")
    private String code;

    @Description("Degree programme name, e.g. Computer Science")
    private String name;

    @PgEnum("degree")
    @Description("Degree level: BACHELOR, MASTER or PHD")
    private String degree;

    @Description("How long the programme runs, counted in semesters: 8 for a four-year bachelor's "
        + "programme, 3 or 4 for a master's depending on the programme. A count, not the number the last "
        + "semester carries — a programme whose curriculum runs 9, 10, 11 is three semesters long")
    private Integer durationSemesters;

    @ManyToOne(joinColumn = "faculty_id")
    private Faculty faculty;

    @OneToMany(mappedBy = "degree_program_id")
    private List<AcademicGroup> groups;

    /**
     * The semesters whose length differs from the university-wide default. Absent means «the usual
     * length» rather than «unknown», so this list is normally short or empty.
     */
    @OneToMany(mappedBy = "degree_program_id")
    private List<DegreeProgramSemester> semesters;
}
