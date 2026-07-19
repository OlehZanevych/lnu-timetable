package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionParent;

import java.util.List;

@Data
@GraphQLEntity(table = "departments")
@PermissionParent(value = Faculty.class, joinColumn = "faculty_id")
public class Department {

    private Long id;

    @Description("Full official name of the department (кафедра)")
    private String name;

    @Nullable
    private String abbreviation;

    @Nullable
    private String email;

    @Nullable
    private String phone;

    @Nullable
    private String info;

    @ManyToOne(joinColumn = "faculty_id")
    private Faculty faculty;

    @OneToMany(mappedBy = "department_id")
    private List<Lecturer> lecturers;

    @OneToMany(mappedBy = "department_id")
    private List<Course> courses;
}
