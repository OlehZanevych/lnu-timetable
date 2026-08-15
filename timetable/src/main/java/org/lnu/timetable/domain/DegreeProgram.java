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

    @ManyToOne(joinColumn = "faculty_id")
    private Faculty faculty;

    @OneToMany(mappedBy = "degree_program_id")
    private List<AcademicGroup> groups;
}
