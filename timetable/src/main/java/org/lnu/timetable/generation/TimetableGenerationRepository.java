package org.lnu.timetable.generation;

import io.r2dbc.spi.Parameters;
import io.r2dbc.spi.R2dbcType;
import io.r2dbc.spi.Readable;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.Collection;
import java.util.List;
import java.util.Map;

/**
 * Raw SQL for the whole solver input, in a fixed number of statements that does not grow with the
 * size of the university.
 *
 * <h2>Why this is not the generated API</h2>
 *
 * Everything here <em>is</em> reachable through the generated connections — the client assembles
 * exactly this payload from them today. What it costs there is the problem: nine round trips for
 * the structure, three aliased reads of {@code timetableEntryConnection} merged in the browser
 * because connection filters compose with AND and what is wanted is OR, and a second pass by id for
 * the handful of lecturers, groups and rooms a workload reaches outside its own faculty. That is a
 * reasonable price for a page a person is looking at and an unreasonable one for a solver that is
 * about to spend an hour on the answer, especially when the answer is wanted for
 * <em>every</em> faculty at once.
 *
 * <p>So the three-alias merge becomes one {@code OR}, the by-id second pass becomes a widened
 * {@code WHERE}, and the per-workload room and group unions become one statement each over
 * {@code = ANY(:workloadIds)}. Nine round trips and a merge become eleven statements with no
 * dependency between them.
 *
 * <h2>What it deliberately does not do</h2>
 *
 * It does not derive the class sessions. {@link TimetableGenerationAssembler} does that, because the
 * arithmetic — hours over a semester, a remainder of half a weekly class becoming one biweekly one,
 * an existing entry claimed positionally — is a rule about the domain rather than a query, and it
 * has to match the client's to the letter or the two halves of the system would schedule different
 * timetables from the same database.
 */
@Component
public class TimetableGenerationRepository {

    /**
     * A workload as the assembler needs it, before its sessions are counted out. {@code hours} is
     * the {@code curriculum_item_hours.hours} of its working curriculum item — of the lowest-id
     * member, for a combined one, which is what the client's {@code workingCurriculumItems[0]}
     * resolves to under the batch loader's {@code ORDER BY}.
     */
    public record WorkloadRow(Long id, Long facultyId, int durationHours, Long classStartTimeSetId,
                              String courseName, String hourType, int hours) {
    }

    /** One existing {@code timetable_entries} row of a workload in scope. */
    public record EntryRow(Long id, Long workloadId, int dayOfWeek, String weekParity,
                           Long classStartTimeId, Long roomId, String startTime, int durationHours) {
    }

    /** A (workload, entity) link, read in bulk for every workload in scope at once. */
    public record Link(Long workloadId, Long otherId) {
    }

    /** A group link, carrying the count an abstract room's capacity caps. */
    public record GroupLink(Long workloadId, Long groupId, int studentsCount) {
    }

    public record ConstraintRow(Long subjectId, String type, Integer dayOfWeek, String value) {
    }

    private final DatabaseClient db;

    public TimetableGenerationRepository(DatabaseClient db) {
        this.db = db;
    }

    // ── global properties ────────────────────────────────────────────────────

    private static final List<String> PROPERTY_NAMES = List.of(
        "academic_hour_duration_minutes", "semester_duration_weeks", "current_semester_parity",
        "abstract_room_travel_time_minutes", "university_commute_time_minutes");

    /**
     * The five properties the payload needs, in one read. Returned as raw text keyed by name — how
     * each is parsed, and what an absent row means as against a present but blank one, is
     * {@link TimetableGenerationAssembler}'s business, and the two are not the same: a missing
     * {@code abstract_room_travel_time_minutes} means "this database predates the rule" and keeps
     * the default, while a present zero means "switch the rule off".
     */
    public Mono<Map<String, String>> globalProperties() {
        return db.sql("SELECT name, value FROM global_properties WHERE name = ANY(:names)")
            .bind("names", PROPERTY_NAMES.toArray(new String[0]))
            .map(row -> Map.entry(str(row, "name"), str(row, "value")))
            .all()
            .collectMap(Map.Entry::getKey, Map.Entry::getValue);
    }

    // ── faculties ────────────────────────────────────────────────────────────

    public Flux<GenerationInput.Faculty> faculties(Long facultyId) {
        String sql = "SELECT id, name, abbreviation FROM faculties"
            + (facultyId == null ? "" : " WHERE id = :facultyId")
            + " ORDER BY name";
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql);
        if (facultyId != null) spec = spec.bind("facultyId", facultyId);
        return spec.map(row -> new GenerationInput.Faculty(id(row, "id"), str(row, "name"), str(row, "abbreviation")))
            .all();
    }

    // ── the workloads this run owns ──────────────────────────────────────────

    /**
     * Every {@code lecturer_workloads} row of the half-year, scoped to one faculty or to all of
     * them, with the hours its class sessions are counted from.
     *
     * <p>Three things in here are easy to get wrong and are each the reason for a clause:
     *
     * <ul>
     * <li>A working curriculum item that has been merged into a combined one is skipped — the
     *     {@code NOT EXISTS} — because its workloads belong to the combined item and counting both
     *     would schedule every one of its classes twice. The client does the same thing with a
     *     {@code continue}.</li>
     * <li>A combined item is claimed by every faculty any of its members sits in — which is exactly
     *     what {@code combinedWorkingCurriculumItemConnection(facultyId:)} says, so a single-faculty
     *     run has to agree with it or the desktop generator and the tab would disagree about whose
     *     class a shared one is. The faculty a workload is <em>reported</em> under is nonetheless the
     *     lowest-id member's, chosen once, so that an all-faculties run does not emit the same class
     *     twice under two faculties.</li>
     * <li>Hours come from one member, not from the sum: the members of a combined item share a
     *     course, a semester and an hour type by construction, so any of them carries the item's
     *     hours and adding them would multiply the class count by the number of groups.</li>
     * </ul>
     */
    public Flux<WorkloadRow> workloads(Long facultyId, String semesterParity) {
        String sql = """
            WITH member AS (
                SELECT m.combined_working_curriculum_item_id AS combined_id,
                       w.id AS wci_id,
                       ROW_NUMBER() OVER (PARTITION BY m.combined_working_curriculum_item_id ORDER BY w.id) AS rn
                FROM combined_working_curriculum_item_members m
                JOIN working_curriculum_items w ON w.id = m.working_curriculum_item_id
            ),
            target AS (
                SELECT lw.id AS workload_id, lw.duration_hours, lw.class_start_time_set_id,
                       COALESCE(lw.working_curriculum_item_id, first_member.wci_id) AS wci_id,
                       lw.combined_working_curriculum_item_id AS combined_id
                FROM lecturer_workloads lw
                LEFT JOIN member first_member
                       ON first_member.combined_id = lw.combined_working_curriculum_item_id
                      AND first_member.rn = 1
                WHERE (lw.working_curriculum_item_id IS NULL
                       OR NOT EXISTS (SELECT 1 FROM combined_working_curriculum_item_members m2
                                      WHERE m2.working_curriculum_item_id = lw.working_curriculum_item_id))
            )
            SELECT t.workload_id, t.duration_hours, t.class_start_time_set_id,
                   d.faculty_id, c.name AS course_name, cih.hour_type, cih.hours
            FROM target t
            JOIN working_curriculum_items w ON w.id = t.wci_id
            JOIN departments d ON d.id = w.department_id
            JOIN curriculum_item_hours cih ON cih.id = w.curriculum_item_hours_id
            JOIN curriculum_items ci ON ci.id = cih.curriculum_item_id
            JOIN courses c ON c.id = COALESCE(w.course_id, ci.course_id)
            WHERE ((:semesterParity = 'ODD' AND ci.semester % 2 = 1)
                OR (:semesterParity = 'EVEN' AND ci.semester % 2 = 0))
              AND (:facultyId IS NULL
                OR d.faculty_id = :facultyId
                OR (t.combined_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM combined_working_curriculum_item_members m3
                       JOIN working_curriculum_items w3 ON w3.id = m3.working_curriculum_item_id
                       JOIN departments d3 ON d3.id = w3.department_id
                       WHERE m3.combined_working_curriculum_item_id = t.combined_id
                         AND d3.faculty_id = :facultyId)))
            ORDER BY t.workload_id
            """;
        return db.sql(sql)
            .bind("semesterParity", semesterParity)
            .bind("facultyId", Parameters.in(R2dbcType.BIGINT, facultyId))
            .map(row -> new WorkloadRow(id(row, "workload_id"), id(row, "faculty_id"),
                num(row, "duration_hours"), id(row, "class_start_time_set_id"),
                str(row, "course_name"), str(row, "hour_type"), num(row, "hours")))
            .all();
    }

    // ── the links of those workloads, in bulk ────────────────────────────────

    public Flux<Link> workloadLecturers(Collection<Long> workloadIds) {
        return links(workloadIds, "SELECT lecturer_workload_id AS w, lecturer_id AS o "
            + "FROM lecturer_workload_lecturers WHERE lecturer_workload_id = ANY(:ids) "
            + "ORDER BY lecturer_workload_id, lecturer_id");
    }

    /**
     * Both ways a group attends: the workload's own groups and the member groups of its combined
     * groups, unioned so that a combined group repeating one of the workload's own does not count
     * its students twice.
     */
    public Flux<GroupLink> workloadGroups(Collection<Long> workloadIds) {
        if (workloadIds.isEmpty()) return Flux.empty();
        String sql = """
            SELECT w, o, COALESCE(ag.students_count, 0) AS students_count FROM (
                SELECT lwag.lecturer_workload_id AS w, lwag.academic_group_id AS o
                FROM lecturer_workload_academic_groups lwag
                WHERE lwag.lecturer_workload_id = ANY(:ids)
                UNION
                SELECT lwcg.lecturer_workload_id AS w, cga.academic_group_id AS o
                FROM lecturer_workload_combined_groups lwcg
                JOIN combined_group_academic_groups cga ON cga.combined_group_id = lwcg.combined_group_id
                WHERE lwcg.lecturer_workload_id = ANY(:ids)
            ) u
            JOIN academic_groups ag ON ag.id = u.o
            ORDER BY w, o
            """;
        return db.sql(sql).bind("ids", workloadIds.toArray(new Long[0]))
            .map(row -> new GroupLink(id(row, "w"), id(row, "o"), num(row, "students_count")))
            .all();
    }

    /**
     * The rooms a workload may use: {@code lecturer_workload_rooms} ∪ the rooms of its
     * {@code lecturer_workload_room_groups}. An empty union means <em>unrestricted</em>, not
     * "nowhere" — the caller supplies the faculty's own rooms in that case, and never every room the
     * payload happens to mention.
     */
    public Flux<Link> workloadRooms(Collection<Long> workloadIds) {
        if (workloadIds.isEmpty()) return Flux.empty();
        String sql = """
            SELECT w, o FROM (
                SELECT lwr.lecturer_workload_id AS w, lwr.room_id AS o
                FROM lecturer_workload_rooms lwr
                WHERE lwr.lecturer_workload_id = ANY(:ids)
                UNION
                SELECT lwrg.lecturer_workload_id AS w, rgr.room_id AS o
                FROM lecturer_workload_room_groups lwrg
                JOIN room_group_rooms rgr ON rgr.room_group_id = lwrg.room_group_id
                WHERE lwrg.lecturer_workload_id = ANY(:ids)
            ) u
            ORDER BY w, o
            """;
        return db.sql(sql).bind("ids", workloadIds.toArray(new Long[0]))
            .map(row -> new Link(id(row, "w"), id(row, "o")))
            .all();
    }

    public Flux<Link> workloadAbstractRooms(Collection<Long> workloadIds) {
        return links(workloadIds, "SELECT lecturer_workload_id AS w, abstract_room_id AS o "
            + "FROM lecturer_workload_abstract_rooms WHERE lecturer_workload_id = ANY(:ids)");
    }

    public Flux<Long> onlineWorkloads(Collection<Long> workloadIds) {
        if (workloadIds.isEmpty()) return Flux.empty();
        return db.sql("SELECT lecturer_workload_id AS w FROM lecturer_workload_online_classes "
                + "WHERE lecturer_workload_id = ANY(:ids)")
            .bind("ids", workloadIds.toArray(new Long[0]))
            .map(row -> id(row, "w"))
            .all();
    }

    /**
     * The entries of the workloads this run owns, ascending by id within each workload — which is
     * the order the client's one-to-many loader returns them in, and therefore the order that
     * decides which class session claims which existing row. Sorting differently here would shuffle
     * every {@code entryId} and turn a no-op save into a timetable-wide rewrite.
     */
    public Flux<EntryRow> ownEntries(Collection<Long> workloadIds) {
        if (workloadIds.isEmpty()) return Flux.empty();
        String sql = """
            SELECT te.id, te.workload_id, te.day_of_week, te.week_parity, te.class_start_time_id,
                   te.room_id, cst.start_time, lw.duration_hours
            FROM timetable_entries te
            JOIN class_start_times cst ON cst.id = te.class_start_time_id
            JOIN lecturer_workloads lw ON lw.id = te.workload_id
            WHERE te.workload_id = ANY(:ids)
            ORDER BY te.workload_id, te.id
            """;
        return db.sql(sql).bind("ids", workloadIds.toArray(new Long[0]))
            .map(TimetableGenerationRepository::mapEntry)
            .all();
    }

    // ── the timetable around this run ────────────────────────────────────────

    /**
     * Every class this run must schedule around and may never rewrite: one belonging to a room it
     * may use, to one of its lecturers, or to one of its groups — and not to a workload of its own.
     *
     * <p>The client asks this as three aliased connection reads and merges them in the browser,
     * because connection filters compose with AND and what is wanted is OR. Written by hand the OR
     * is just an OR, and the merge disappears along with two of the three round trips.
     */
    public Flux<EntryRow> externalEntries(Collection<Long> roomIds, Collection<Long> lecturerIds,
                                          Collection<Long> groupIds, Collection<Long> ownWorkloadIds,
                                          String semesterParity) {
        String sql = """
            SELECT te.id, te.workload_id, te.day_of_week, te.week_parity, te.class_start_time_id,
                   te.room_id, cst.start_time, lw.duration_hours
            FROM timetable_entries te
            JOIN class_start_times cst ON cst.id = te.class_start_time_id
            JOIN lecturer_workloads lw ON lw.id = te.workload_id
            WHERE (
                    te.room_id = ANY(:roomIds)
                 OR EXISTS (SELECT 1 FROM lecturer_workload_lecturers lwl
                            WHERE lwl.lecturer_workload_id = te.workload_id
                              AND lwl.lecturer_id = ANY(:lecturerIds))
                 OR EXISTS (SELECT 1 FROM lecturer_workload_academic_groups lwag
                            WHERE lwag.lecturer_workload_id = te.workload_id
                              AND lwag.academic_group_id = ANY(:groupIds))
                 OR EXISTS (SELECT 1 FROM lecturer_workload_combined_groups lwcg
                            JOIN combined_group_academic_groups cga
                              ON cga.combined_group_id = lwcg.combined_group_id
                            WHERE lwcg.lecturer_workload_id = te.workload_id
                              AND cga.academic_group_id = ANY(:groupIds))
                  )
              AND te.workload_id <> ALL(:ownWorkloadIds)
              AND EXISTS (SELECT 1 FROM lecturer_workloads lw2
                          LEFT JOIN working_curriculum_items w ON w.id = lw2.working_curriculum_item_id
                          LEFT JOIN combined_working_curriculum_item_members m
                                 ON m.combined_working_curriculum_item_id = lw2.combined_working_curriculum_item_id
                          LEFT JOIN working_curriculum_items wm ON wm.id = m.working_curriculum_item_id
                          JOIN curriculum_item_hours cih
                            ON cih.id = COALESCE(w.curriculum_item_hours_id, wm.curriculum_item_hours_id)
                          JOIN curriculum_items ci ON ci.id = cih.curriculum_item_id
                          WHERE lw2.id = te.workload_id
                            AND ((:semesterParity = 'ODD' AND ci.semester % 2 = 1)
                              OR (:semesterParity = 'EVEN' AND ci.semester % 2 = 0)))
            ORDER BY te.id
            """;
        return db.sql(sql)
            .bind("roomIds", roomIds.toArray(new Long[0]))
            .bind("lecturerIds", lecturerIds.toArray(new Long[0]))
            .bind("groupIds", groupIds.toArray(new Long[0]))
            .bind("ownWorkloadIds", ownWorkloadIds.isEmpty() ? new Long[]{-1L} : ownWorkloadIds.toArray(new Long[0]))
            .bind("semesterParity", semesterParity)
            .map(TimetableGenerationRepository::mapEntry)
            .all();
    }

    // ── places and bells ─────────────────────────────────────────────────────

    /** The rooms this run may schedule into freely: {@code rooms.faculty_id}, and nothing wider. */
    public Flux<Long> facultyRooms(Long facultyId) {
        String sql = facultyId == null
            ? "SELECT id FROM rooms WHERE faculty_id IS NOT NULL ORDER BY id"
            : "SELECT id FROM rooms WHERE faculty_id = :facultyId ORDER BY id";
        DatabaseClient.GenericExecuteSpec spec = db.sql(sql);
        if (facultyId != null) spec = spec.bind("facultyId", facultyId);
        return spec.map(row -> id(row, "id")).all();
    }

    public Flux<GenerationInput.RoomBuilding> roomBuildings(Collection<Long> roomIds) {
        if (roomIds.isEmpty()) return Flux.empty();
        return db.sql("SELECT id, building_id FROM rooms WHERE id = ANY(:ids) AND building_id IS NOT NULL")
            .bind("ids", roomIds.toArray(new Long[0]))
            .map(row -> new GenerationInput.RoomBuilding(id(row, "id"), id(row, "building_id")))
            .all();
    }

    public Flux<GenerationInput.BuildingTravel> buildingTravel() {
        return db.sql("SELECT from_building_id, to_building_id, minutes FROM building_travel_times")
            .map(row -> new GenerationInput.BuildingTravel(id(row, "from_building_id"),
                id(row, "to_building_id"), num(row, "minutes")))
            .all();
    }

    public Flux<GenerationInput.AbstractRoom> abstractRooms(Collection<Long> ids) {
        if (ids.isEmpty()) return Flux.empty();
        return db.sql("SELECT id, name, capacity, building_id FROM abstract_rooms WHERE id = ANY(:ids)")
            .bind("ids", ids.toArray(new Long[0]))
            .map(row -> new GenerationInput.AbstractRoom(id(row, "id"), str(row, "name"),
                row.get("capacity") == null ? null : num(row, "capacity"), id(row, "building_id")))
            .all();
    }

    public Flux<GenerationInput.ClassTime> classTimes() {
        return db.sql("SELECT id, class_start_time_set_id, ordinal, start_time FROM class_start_times "
                + "ORDER BY class_start_time_set_id, ordinal")
            .map(row -> new GenerationInput.ClassTime(id(row, "id"), id(row, "class_start_time_set_id"),
                num(row, "ordinal"), str(row, "start_time")))
            .all();
    }

    // ── constraints ──────────────────────────────────────────────────────────

    /**
     * Every rule that applies to a lecturer of this faculty <em>or</em> to one a workload of this
     * run reaches outside it — a викладач of another кафедра teaching for us. The client asks the
     * second group in a separate by-id request; here it is one more {@code OR}.
     */
    public Flux<ConstraintRow> lecturerConstraints(Long facultyId, Collection<Long> workloadIds) {
        String sql = """
            SELECT c.lecturer_id AS subject_id, c.constraint_type, c.day_of_week, c.constraint_value
            FROM lecturer_timetable_constraints c
            JOIN lecturers l ON l.id = c.lecturer_id
            WHERE (:facultyId IS NULL
                   OR EXISTS (SELECT 1 FROM departments d
                              WHERE d.id = l.department_id AND d.faculty_id = :facultyId)
                   OR EXISTS (SELECT 1 FROM lecturer_workload_lecturers lwl
                              WHERE lwl.lecturer_id = l.id AND lwl.lecturer_workload_id = ANY(:workloadIds)))
            ORDER BY c.lecturer_id, c.id
            """;
        return constraints(sql, facultyId, workloadIds);
    }

    /** The same, for academic groups — whose faculty is reached through {@code degree_programs}. */
    public Flux<ConstraintRow> groupConstraints(Long facultyId, Collection<Long> workloadIds) {
        String sql = """
            SELECT c.academic_group_id AS subject_id, c.constraint_type, c.day_of_week, c.constraint_value
            FROM academic_group_timetable_constraints c
            JOIN academic_groups g ON g.id = c.academic_group_id
            WHERE (:facultyId IS NULL
                   OR EXISTS (SELECT 1 FROM degree_programs dp
                              WHERE dp.id = g.degree_program_id AND dp.faculty_id = :facultyId)
                   OR EXISTS (SELECT 1 FROM lecturer_workload_academic_groups lwag
                              WHERE lwag.academic_group_id = g.id
                                AND lwag.lecturer_workload_id = ANY(:workloadIds))
                   OR EXISTS (SELECT 1 FROM lecturer_workload_combined_groups lwcg
                              JOIN combined_group_academic_groups cga
                                ON cga.combined_group_id = lwcg.combined_group_id
                              WHERE cga.academic_group_id = g.id
                                AND lwcg.lecturer_workload_id = ANY(:workloadIds)))
            ORDER BY c.academic_group_id, c.id
            """;
        return constraints(sql, facultyId, workloadIds);
    }

    /** And for rooms — whose faculty is a column, and which a workload may also name directly. */
    public Flux<ConstraintRow> roomConstraints(Long facultyId, Collection<Long> workloadIds) {
        String sql = """
            SELECT c.room_id AS subject_id, c.constraint_type, c.day_of_week, c.constraint_value
            FROM room_timetable_constraints c
            JOIN rooms r ON r.id = c.room_id
            WHERE (:facultyId IS NULL
                   OR r.faculty_id = :facultyId
                   OR EXISTS (SELECT 1 FROM lecturer_workload_rooms lwr
                              WHERE lwr.room_id = r.id AND lwr.lecturer_workload_id = ANY(:workloadIds))
                   OR EXISTS (SELECT 1 FROM lecturer_workload_room_groups lwrg
                              JOIN room_group_rooms rgr ON rgr.room_group_id = lwrg.room_group_id
                              WHERE rgr.room_id = r.id AND lwrg.lecturer_workload_id = ANY(:workloadIds))
                   OR EXISTS (SELECT 1 FROM timetable_entries te
                              WHERE te.room_id = r.id AND te.workload_id = ANY(:workloadIds)))
            ORDER BY c.room_id, c.id
            """;
        return constraints(sql, facultyId, workloadIds);
    }

    // ── writing back ─────────────────────────────────────────────────────────

    /**
     * One placement, created or updated. Written a row at a time rather than as one array statement
     * because the batch is a few thousand rows at the very most and the loop keeps the failure of
     * one class reportable by name — {@code UNNEST} would make the whole save succeed or fail
     * together, which is the wrong granularity for a report the deanery has to read.
     */
    public Mono<Long> insertEntry(GenerationInput.GeneratedPlacement p) {
        return db.sql("INSERT INTO timetable_entries "
                + "(day_of_week, week_parity, workload_id, class_start_time_id, room_id) "
                + "VALUES (:day, :parity::week_parity, :workload, :startTime, :room) RETURNING id")
            .bind("day", p.dayOfWeek())
            .bind("parity", p.weekParity())
            .bind("workload", p.workloadId())
            .bind("startTime", p.classStartTimeId())
            .bind("room", Parameters.in(R2dbcType.BIGINT, p.roomId()))
            .map(row -> id(row, "id"))
            .one();
    }

    public Mono<Long> updateEntry(GenerationInput.GeneratedPlacement p) {
        return db.sql("UPDATE timetable_entries SET day_of_week = :day, "
                + "week_parity = :parity::week_parity, class_start_time_id = :startTime, "
                + "room_id = :room WHERE id = :id AND workload_id = :workload")
            .bind("day", p.dayOfWeek())
            .bind("parity", p.weekParity())
            .bind("startTime", p.classStartTimeId())
            .bind("room", Parameters.in(R2dbcType.BIGINT, p.roomId()))
            .bind("id", p.entryId())
            .bind("workload", p.workloadId())
            .fetch().rowsUpdated();
    }

    /**
     * The workloads the given entries belong to. Needed because deletion is authorized over the
     * <em>workload</em>, and a request that only deletes carries no placements to read them from —
     * which is how "every workload in the batch has FULL" degenerated into "an empty batch passes".
     */
    public Flux<Link> workloadsOfEntries(Collection<Long> entryIds) {
        if (entryIds.isEmpty()) return Flux.empty();
        return db.sql("SELECT id AS o, workload_id AS w FROM timetable_entries WHERE id = ANY(:ids)")
            .bind("ids", entryIds.toArray(new Long[0]))
            .map(row -> new Link(id(row, "w"), id(row, "o")))
            .all();
    }

    public Mono<Long> deleteEntries(Collection<Long> ids) {
        if (ids.isEmpty()) return Mono.just(0L);
        return db.sql("DELETE FROM timetable_entries WHERE id = ANY(:ids)")
            .bind("ids", ids.toArray(new Long[0]))
            .fetch().rowsUpdated();
    }

    /**
     * The two invariants {@code schema.sql} states in a comment and leaves to "the scheduler": the
     * bell must belong to the workload's own grid, and the room must be one the workload allows.
     * Both are set-membership tests two joins away, which is why they are not CHECK constraints —
     * and why a bulk write is the first place in the service that has ever been able to enforce
     * them. Returns the workloads for which the pair is legal.
     */
    public Flux<Link> legalBells(Collection<Long> workloadIds, Collection<Long> startTimeIds) {
        if (workloadIds.isEmpty() || startTimeIds.isEmpty()) return Flux.empty();
        String sql = """
            SELECT lw.id AS w, cst.id AS o
            FROM lecturer_workloads lw
            JOIN class_start_times cst ON cst.class_start_time_set_id = lw.class_start_time_set_id
            WHERE lw.id = ANY(:workloadIds) AND cst.id = ANY(:startTimeIds)
            """;
        return db.sql(sql)
            .bind("workloadIds", workloadIds.toArray(new Long[0]))
            .bind("startTimeIds", startTimeIds.toArray(new Long[0]))
            .map(row -> new Link(id(row, "w"), id(row, "o")))
            .all();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private Flux<Link> links(Collection<Long> workloadIds, String sql) {
        if (workloadIds.isEmpty()) return Flux.empty();
        return db.sql(sql).bind("ids", workloadIds.toArray(new Long[0]))
            .map(row -> new Link(id(row, "w"), id(row, "o")))
            .all();
    }

    private Flux<ConstraintRow> constraints(String sql, Long facultyId, Collection<Long> workloadIds) {
        return db.sql(sql)
            .bind("facultyId", Parameters.in(R2dbcType.BIGINT, facultyId))
            .bind("workloadIds", workloadIds.isEmpty() ? new Long[]{-1L} : workloadIds.toArray(new Long[0]))
            .map(row -> new ConstraintRow(id(row, "subject_id"), str(row, "constraint_type"),
                row.get("day_of_week") == null ? null : num(row, "day_of_week"), str(row, "constraint_value")))
            .all();
    }

    private static EntryRow mapEntry(Readable row) {
        return new EntryRow(id(row, "id"), id(row, "workload_id"), num(row, "day_of_week"),
            str(row, "week_parity"), id(row, "class_start_time_id"), id(row, "room_id"),
            str(row, "start_time"), num(row, "duration_hours"));
    }

    /** r2dbc-postgresql hands an integer column back as {@code Integer} or {@code Long}, by width. */
    private static Long id(Readable row, String column) {
        Object raw = row.get(column);
        return raw == null ? null : ((Number) raw).longValue();
    }

    private static int num(Readable row, String column) {
        Object raw = row.get(column);
        return raw == null ? 0 : ((Number) raw).intValue();
    }

    private static String str(Readable row, String column) {
        Object raw = row.get(column);
        return raw == null ? null : raw.toString();
    }
}
