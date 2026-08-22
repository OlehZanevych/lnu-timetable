package org.lnu.timetable.generation;

import java.util.List;

/**
 * The value shapes {@link TimetableGenerationRepository} reads and
 * {@link TimetableGenerationDataFetchers} turns into the GraphQL payload.
 *
 * <p>Records rather than entities on purpose: none of this is a row. A <em>requirement</em> is one
 * class session a workload's hours oblige the faculty to hold, derived by arithmetic from
 * {@code curriculum_item_hours.hours} and {@code semester_duration_weeks} — there is no table with
 * one row per class session and there never was, which is exactly why the entity framework cannot
 * generate this query and why it lives here as a {@code HandWrittenApi} area.
 *
 * <p>The shape mirrors the {@code SolverProblem} the Angular client assembles in
 * {@code faculty-timetable-list.ts} field for field. That is deliberate and load-bearing: the two
 * are inputs to the same solver, and a payload that merely resembled the client's would produce a
 * timetable that differed from the one «Згенерувати розклад» produces for reasons nobody could see.
 */
public final class GenerationInput {

    private GenerationInput() {
    }

    /** One bell, on one grid. */
    public record ClassTime(Long id, Long setId, int ordinal, String startTime) {
    }

    /** A room and the корпус it is in; absent from the list entirely when it has none. */
    public record RoomBuilding(Long roomId, Long buildingId) {
    }

    /**
     * A directed walk between two корпуси. Directed because the matrix is: b1→b4 is ten minutes and
     * b4→b1 is sixteen, and reading one for the other scores about half of all cross-building pairs
     * against the wrong figure.
     */
    public record BuildingTravel(Long fromBuildingId, Long toBuildingId, int minutes) {
    }

    /** A place several classes legitimately share at one hour, with the ceiling that caps them. */
    public record AbstractRoom(Long id, String name, Integer capacity, Long buildingId) {
    }

    /** Where a class already is. Null on a requirement that has never been scheduled. */
    public record Placement(int dayOfWeek, Long classStartTimeId, Long roomId, String weekParity) {
    }

    /**
     * One class session to place.
     *
     * @param key      {@code workloadId::wk|bi::index} — position-based, matching the client's
     *                 {@code Block.key}, so a plan produced here and a plan produced there name the
     *                 same thing
     * @param entryId  the {@code timetable_entries} row this session already has, or null
     * @param locked   true when this run may not move it: it is outside the target faculty, or the
     *                 caller may not edit it
     */
    public record Requirement(String key, Long workloadId, Long entryId, String courseName,
                              String hourType, int durationHours, Long classStartTimeSetId,
                              List<Long> lecturerIds, List<Long> groupIds, List<Long> roomIds,
                              Long abstractRoomId, boolean isOnline, int studentsCount,
                              boolean isBiweekly, Placement current, boolean locked, Long facultyId) {
    }

    /**
     * A class this run must schedule around and may never rewrite — another faculty's, in a room or
     * with a lecturer or a group this one shares.
     */
    public record FixedEntry(Long id, int dayOfWeek, String weekParity, String startTime,
                             int durationHours, List<Long> lecturerIds, List<Long> groupIds,
                             Long roomId, Long abstractRoomId, boolean isOnline, int studentsCount) {
    }

    /** One row of one of the three {@code *_timetable_constraints} tables. */
    public record Constraint(String type, Integer dayOfWeek, String value) {
    }

    /** Every constraint of one subject, which is the shape the solver interns. */
    public record ConstraintSet(Long subjectId, List<Constraint> constraints) {
    }

    public record Faculty(Long id, String name, String abbreviation) {
    }

    /** One placement the generator produced, on its way back into {@code timetable_entries}. */
    public record GeneratedPlacement(String key, Long workloadId, Long entryId, int dayOfWeek,
                                     Long classStartTimeId, Long roomId, String weekParity) {
    }

    /** A placement the save refused, and why — reported per class rather than failing the batch. */
    public record Rejection(String key, String reason) {
    }
}
