package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionRoot;

import java.util.List;

@Data
@PermissionRoot("A корпус belongs to the university, not to a faculty: it holds rooms used by "
    + "several of them, so there is no owner for a grant to cascade from")
@GraphQLEntity(table = "buildings")
public class Building {

    private Long id;

    @Description("Building name or descriptor, e.g. Університетський корпус")
    private String name;

    @Nullable
    private String address;

    @Nullable
    private String city;

    @Nullable
    @Description("Postal code")
    private String postalCode;

    @OneToMany(mappedBy = "building_id")
    private List<Room> rooms;

    @OneToMany(mappedBy = "building_id")
    private List<Faculty> faculties;
}
