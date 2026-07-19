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
@GraphQLEntity(table = "faculties")
@PermissionParent(value = Building.class, joinColumn = "building_id", nullable = true)
public class Faculty {

    private Long id;

    @Description("Full official name of the faculty")
    private String name;

    @Nullable
    @Description("Short abbreviation, e.g. ФПМіІ")
    private String abbreviation;

    @Nullable
    private String website;

    @Nullable
    private String email;

    @Nullable
    private String phone;

    @Nullable
    @ManyToOne(joinColumn = "building_id")
    private Building building;

    @OneToMany(mappedBy = "faculty_id")
    private List<Department> departments;

    @OneToMany(mappedBy = "faculty_id")
    private List<Specialty> specialties;

    @OneToMany(mappedBy = "faculty_id")
    private List<Room> rooms;
}
