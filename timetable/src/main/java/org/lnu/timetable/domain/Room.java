package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.Nullable;

@Data
@GraphQLEntity(table = "rooms")
public class Room {

    private Long id;

    @Description("Room number, e.g. 245")
    private String number;

    @Nullable
    private String name;

    @Nullable
    private Integer capacity;

    @Nullable
    @Description("Room kind: LECTURE_HALL, COMPUTER_LAB, SEMINAR_ROOM")
    private String kind;

    @Nullable
    @ManyToOne(joinColumn = "faculty_id")
    private Faculty faculty;

    @Nullable
    @ManyToOne(joinColumn = "building_id")
    private Building building;
}
