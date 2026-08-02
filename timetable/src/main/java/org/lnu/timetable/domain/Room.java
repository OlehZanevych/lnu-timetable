package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;
import org.lnu.timetable.framework.annotation.OneToMany;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

import java.util.List;

@Data
@GraphQLEntity(table = "rooms")
@PermissionParent(value = Faculty.class, joinColumn = "faculty_id", nullable = true)
@PermissionParent(value = Building.class, joinColumn = "building_id", nullable = true)
public class Room {

    private Long id;

    @Description("Room number, e.g. 245")
    private String number;

    @Nullable
    private String name;

    @Nullable
    private Integer capacity;

    @Nullable
    @PgEnum("room_kind")
    @Description("Room kind: LECTURE_HALL, COMPUTER_LAB, SEMINAR_ROOM")
    private String kind;

    @Nullable
    @ManyToOne(joinColumn = "faculty_id")
    private Faculty faculty;

    @Nullable
    @ManyToOne(joinColumn = "building_id")
    private Building building;

    /** When this room may be given classes — see {@link RoomTimetableConstraint}. */
    @OneToMany(mappedBy = "room_id")
    private List<RoomTimetableConstraint> timetableConstraints;
}
