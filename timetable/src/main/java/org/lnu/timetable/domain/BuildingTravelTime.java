package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.PermissionParent;

/**
 * How long it comfortably takes to get from one building to another.
 *
 * <p>A group's day is a sequence of classes and the gap between two bells is fixed; when
 * consecutive classes sit in different корпуси, that gap has to cover the journey between them.
 * This is where the length of that journey is written down.
 *
 * <p><strong>Directed.</strong> The row is (from, to) and the two directions may disagree — Lviv is
 * built on hills, and a climb with a bag is not the walk back down. There is no row from a building
 * to itself; a database CHECK forbids one, because moving inside a building is not a journey
 * between buildings. Absence therefore means "no travel at all", not "unknown", for the one case
 * where the two would be confused.
 *
 * <p>Both buildings are {@link PermissionParent}s: a grant over either корпус is enough to edit the
 * time between them, which is how the деканат that owns a building can correct the walks into and
 * out of it without a grant over the whole university.
 */
@Data
@GraphQLEntity(table = "building_travel_times")
@PermissionParent(value = Building.class, joinColumn = "from_building_id")
@PermissionParent(value = Building.class, joinColumn = "to_building_id")
public class BuildingTravelTime {

    private Long id;

    @Description("Whole minutes; the bells run on a five-minute grid and nobody plans a walk to the second")
    private Integer minutes;

    @ManyToOne(joinColumn = "from_building_id")
    private Building fromBuilding;

    @ManyToOne(joinColumn = "to_building_id")
    private Building toBuilding;
}
