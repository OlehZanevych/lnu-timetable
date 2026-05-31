package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;

import java.util.List;

@Data
@GraphQLEntity(table = "faculties")
public class Faculty {

    private Long id;

    @Description("Full official name of the faculty")
    private String name;

    @Nullable
    @Description("Short abbreviation, e.g. ФПМІ")
    private String abbreviation;

    @Nullable
    private String website;

    @Nullable
    private String email;

    @Nullable
    private String phone;

    @Nullable
    private String address;

    @Nullable
    private String info;

    @OneToMany(mappedBy = "faculty_id")
    private List<Department> departments;

    @OneToMany(mappedBy = "faculty_id")
    private List<Specialty> specialties;

    @OneToMany(mappedBy = "faculty_id")
    private List<Room> rooms;
}
