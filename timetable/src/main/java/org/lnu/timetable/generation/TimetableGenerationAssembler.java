package org.lnu.timetable.generation;

import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Turns the eleven reads of {@link TimetableGenerationRepository} into the payload a solver takes.
 *
 * <h2>The one piece of arithmetic in the whole area</h2>
 *
 * A {@code lecturer_workloads} row is not a class. It is a number of hours, and how many class
 * sessions those hours require is
 *
 * <pre>{@code
 *   hoursPerWeeklyClass = semesterDurationWeeks × durationHours
 *   perWeek             = hours / hoursPerWeeklyClass
 *   weekly              = floor(perWeek)
 *   biweekly            = (perWeek − weekly) ≥ 0.5
 * }</pre>
 *
 * so 32 hours over a sixteen-week semester of two-hour classes is one weekly class, and 80 hours is
 * two weekly classes plus one held every other week. A workload already carrying <em>more</em>
 * entries than that arithmetic asks for keeps them all — {@code max(weekly, weeklyEntries)} — because
 * a class somebody scheduled is a fact about the timetable and the arithmetic is an estimate.
 *
 * <p>This is transcribed from {@code buildBlocks}/{@code classCounts} in
 * {@code timetable-ui/src/app/faculty-timetable-list.ts}, epsilon for epsilon, and the two must stay
 * in step: the tab and this query are two doors into the same generator, and a difference between
 * them would show up as the desktop application and the web page producing different timetables
 * from one database, which is the kind of discrepancy that takes a week to find.
 *
 * <p>Claiming an existing entry is <strong>positional</strong>, and that is not incidental either.
 * The i-th weekly session takes the i-th weekly entry of its workload, ordered by
 * {@code timetable_entries.id} — the order the repository's {@code ORDER BY workload_id, id}
 * guarantees and the client's batch loader happens to produce. Any other order would reshuffle every
 * {@code entryId} and turn a save that changed nothing into a rewrite of the whole timetable.
 */
@Component
public class TimetableGenerationAssembler {

    /** What the query answers with, before it is turned into GraphQL maps. */
    public record Payload(int academicHourMinutes, int semesterDurationWeeks, String semesterParity,
                          int abstractRoomTravelMinutes, int universityCommuteMinutes,
                          List<Integer> days, List<GenerationInput.Faculty> faculties,
                          List<GenerationInput.ClassTime> classTimes, List<Long> rooms,
                          List<GenerationInput.RoomBuilding> roomBuilding,
                          List<GenerationInput.BuildingTravel> buildingTravel,
                          List<GenerationInput.AbstractRoom> abstractRooms,
                          List<GenerationInput.Requirement> requirements,
                          List<GenerationInput.FixedEntry> fixedEntries,
                          List<GenerationInput.ConstraintSet> lecturerConstraints,
                          List<GenerationInput.ConstraintSet> groupConstraints,
                          List<GenerationInput.ConstraintSet> roomConstraints) {
    }

    /** Monday to Saturday, as {@code WORKING_DAYS} in the client. Sunday is not a teaching day here. */
    public static final List<Integer> WORKING_DAYS = List.of(1, 2, 3, 4, 5, 6);

    private static final int DEFAULT_HOUR_MINUTES = 40;
    private static final int DEFAULT_SEMESTER_WEEKS = 16;
    private static final int DEFAULT_ABSTRACT_TRAVEL = 60;
    private static final int DEFAULT_COMMUTE = 80;

    private final TimetableGenerationRepository repo;

    public TimetableGenerationAssembler(TimetableGenerationRepository repo) {
        this.repo = repo;
    }

    /**
     * @param facultyId the faculty to generate for, or null for the whole university
     * @param parityArg the requested half-year, or null to take {@code current_semester_parity}
     */
    public Mono<Payload> assemble(Long facultyId, String parityArg) {
        return repo.globalProperties().flatMap(props -> {
            final int hourMinutes = positiveOr(props.get("academic_hour_duration_minutes"), DEFAULT_HOUR_MINUTES);
            final int weeks = positiveOr(props.get("semester_duration_weeks"), DEFAULT_SEMESTER_WEEKS);
            // Different rule for the two journeys, matching the client: a *present* row that is
            // blank or non-positive switches the rule off, and only a missing row — a database
            // predating V7 — keeps the default. See loadGlobalProperties in the client.
            final int abstractTravel = presentOrDefault(props, "abstract_room_travel_time_minutes", DEFAULT_ABSTRACT_TRAVEL);
            final int commute = presentOrDefault(props, "university_commute_time_minutes", DEFAULT_COMMUTE);
            final String parity = normaliseParity(parityArg != null ? parityArg : props.get("current_semester_parity"));

            return repo.workloads(facultyId, parity).collectList().flatMap(workloads -> {
                final List<Long> workloadIds = workloads.stream().map(TimetableGenerationRepository.WorkloadRow::id).toList();

                return Mono.zip(
                    repo.workloadLecturers(workloadIds).collectList(),
                    repo.workloadGroups(workloadIds).collectList(),
                    repo.workloadRooms(workloadIds).collectList(),
                    repo.workloadAbstractRooms(workloadIds).collectList(),
                    repo.onlineWorkloads(workloadIds).collectList(),
                    repo.ownEntries(workloadIds).collectList(),
                    repo.facultyRooms(facultyId).collectList(),
                    repo.classTimes().collectList()
                ).flatMap(t -> {
                    final Map<Long, List<Long>> lecturersOf = group(t.getT1(),
                        TimetableGenerationRepository.Link::workloadId, TimetableGenerationRepository.Link::otherId);
                    final Map<Long, List<Long>> groupsOf = group(t.getT2(),
                        TimetableGenerationRepository.GroupLink::workloadId, TimetableGenerationRepository.GroupLink::groupId);
                    final Map<Long, Integer> studentsOf = new HashMap<>();
                    for (TimetableGenerationRepository.GroupLink g : t.getT2()) {
                        studentsOf.merge(g.workloadId(), g.studentsCount(), Integer::sum);
                    }
                    final Map<Long, List<Long>> roomsOf = group(t.getT3(),
                        TimetableGenerationRepository.Link::workloadId, TimetableGenerationRepository.Link::otherId);
                    final Map<Long, Long> abstractOf = t.getT4().stream()
                        .collect(Collectors.toMap(TimetableGenerationRepository.Link::workloadId,
                            TimetableGenerationRepository.Link::otherId, (a, b) -> a));
                    final Set<Long> online = new HashSet<>(t.getT5());
                    final Map<Long, List<TimetableGenerationRepository.EntryRow>> entriesOf =
                        t.getT6().stream().collect(Collectors.groupingBy(
                            TimetableGenerationRepository.EntryRow::workloadId, LinkedHashMap::new, Collectors.toList()));
                    final List<Long> facultyRooms = t.getT7();
                    final List<GenerationInput.ClassTime> classTimes = t.getT8();

                    final List<GenerationInput.Requirement> requirements = new ArrayList<>();
                    for (TimetableGenerationRepository.WorkloadRow w : workloads) {
                        requirements.addAll(sessionsOf(w, weeks, lecturersOf, groupsOf, studentsOf,
                            roomsOf, abstractOf, online, entriesOf));
                    }

                    // What the obstacle query has to look at: every room this run may place into,
                    // every room a workload names, and every room one of its entries already sits in.
                    final Set<Long> obstacleRooms = new LinkedHashSet<>(facultyRooms);
                    roomsOf.values().forEach(obstacleRooms::addAll);
                    for (GenerationInput.Requirement r : requirements) {
                        if (r.current() != null && r.current().roomId() != null) obstacleRooms.add(r.current().roomId());
                    }
                    final Set<Long> allLecturers = new LinkedHashSet<>();
                    lecturersOf.values().forEach(allLecturers::addAll);
                    final Set<Long> allGroups = new LinkedHashSet<>();
                    groupsOf.values().forEach(allGroups::addAll);

                    return repo.externalEntries(obstacleRooms, allLecturers, allGroups, workloadIds, parity)
                        .collectList()
                        .flatMap(external -> finish(facultyId, parity, hourMinutes, weeks, abstractTravel,
                            commute, classTimes, facultyRooms, obstacleRooms, requirements, abstractOf,
                            workloadIds, external));
                });
            });
        });
    }

    private Mono<Payload> finish(Long facultyId, String parity, int hourMinutes, int weeks,
                                 int abstractTravel, int commute,
                                 List<GenerationInput.ClassTime> classTimes, List<Long> facultyRooms,
                                 Set<Long> obstacleRooms, List<GenerationInput.Requirement> requirements,
                                 Map<Long, Long> abstractOf, List<Long> ownWorkloadIds,
                                 List<TimetableGenerationRepository.EntryRow> external) {
        final List<Long> externalWorkloads = external.stream()
            .map(TimetableGenerationRepository.EntryRow::workloadId).distinct().toList();

        return Mono.zip(
            repo.workloadLecturers(externalWorkloads).collectList(),
            repo.workloadGroups(externalWorkloads).collectList(),
            repo.workloadAbstractRooms(externalWorkloads).collectList(),
            repo.onlineWorkloads(externalWorkloads).collectList(),
            repo.lecturerConstraints(facultyId, ownWorkloadIds).collectList(),
            repo.groupConstraints(facultyId, ownWorkloadIds).collectList(),
            repo.roomConstraints(facultyId, ownWorkloadIds).collectList(),
            repo.faculties(facultyId).collectList()
        ).flatMap(t -> {
            final Map<Long, List<Long>> extLecturers = group(t.getT1(),
                TimetableGenerationRepository.Link::workloadId, TimetableGenerationRepository.Link::otherId);
            final Map<Long, List<Long>> extGroups = group(t.getT2(),
                TimetableGenerationRepository.GroupLink::workloadId, TimetableGenerationRepository.GroupLink::groupId);
            final Map<Long, Integer> extStudents = new HashMap<>();
            for (TimetableGenerationRepository.GroupLink g : t.getT2()) {
                extStudents.merge(g.workloadId(), g.studentsCount(), Integer::sum);
            }
            final Map<Long, Long> extAbstract = t.getT3().stream()
                .collect(Collectors.toMap(TimetableGenerationRepository.Link::workloadId,
                    TimetableGenerationRepository.Link::otherId, (a, b) -> a));
            final Set<Long> extOnline = new HashSet<>(t.getT4());

            final List<GenerationInput.FixedEntry> fixed = new ArrayList<>();
            for (TimetableGenerationRepository.EntryRow e : external) {
                fixed.add(new GenerationInput.FixedEntry(e.id(), e.dayOfWeek(), e.weekParity(),
                    e.startTime(), e.durationHours(),
                    extLecturers.getOrDefault(e.workloadId(), List.of()),
                    extGroups.getOrDefault(e.workloadId(), List.of()),
                    e.roomId(), extAbstract.get(e.workloadId()),
                    extOnline.contains(e.workloadId()),
                    extStudents.getOrDefault(e.workloadId(), 0)));
            }

            // Every shared place the payload mentions, from either side.
            final Set<Long> abstractIds = new LinkedHashSet<>(abstractOf.values());
            abstractIds.addAll(extAbstract.values());
            // Every room the payload mentions needs its корпус, or Π₄/Π₅ read the journey as zero.
            final Set<Long> roomsToLocate = new LinkedHashSet<>(obstacleRooms);
            for (GenerationInput.FixedEntry f : fixed) if (f.roomId() != null) roomsToLocate.add(f.roomId());

            return Mono.zip(
                repo.abstractRooms(abstractIds).collectList(),
                repo.roomBuildings(roomsToLocate).collectList(),
                repo.buildingTravel().collectList()
            ).map(u -> new Payload(hourMinutes, weeks, parity, abstractTravel, commute,
                WORKING_DAYS, t.getT8(), classTimes, facultyRooms, u.getT2(), u.getT3(), u.getT1(),
                requirements, fixed,
                constraintSets(t.getT5()), constraintSets(t.getT6()), constraintSets(t.getT7())));
        });
    }

    // ── the class sessions of one workload ───────────────────────────────────

    private List<GenerationInput.Requirement> sessionsOf(
            TimetableGenerationRepository.WorkloadRow w, int weeks,
            Map<Long, List<Long>> lecturersOf, Map<Long, List<Long>> groupsOf,
            Map<Long, Integer> studentsOf, Map<Long, List<Long>> roomsOf,
            Map<Long, Long> abstractOf, Set<Long> online,
            Map<Long, List<TimetableGenerationRepository.EntryRow>> entriesOf) {

        final int hoursPerWeeklyClass = weeks * Math.max(1, w.durationHours());
        final double perWeek = hoursPerWeeklyClass > 0 ? (double) w.hours() / hoursPerWeeklyClass : 0;
        final int weekly = (int) Math.floor(perWeek + 1e-9);
        final boolean biweekly = perWeek - weekly >= 0.5 - 1e-9;

        final List<TimetableGenerationRepository.EntryRow> entries =
            entriesOf.getOrDefault(w.id(), List.of());
        final List<TimetableGenerationRepository.EntryRow> weeklyEntries = entries.stream()
            .filter(e -> "WEEKLY".equals(e.weekParity())).sorted(Comparator.comparing(TimetableGenerationRepository.EntryRow::id)).toList();
        final List<TimetableGenerationRepository.EntryRow> biweeklyEntries = entries.stream()
            .filter(e -> !"WEEKLY".equals(e.weekParity())).sorted(Comparator.comparing(TimetableGenerationRepository.EntryRow::id)).toList();

        final boolean isOnline = online.contains(w.id());
        final Long abstractRoom = isOnline ? null : abstractOf.get(w.id());
        final List<Long> rooms = isOnline || abstractRoom != null
            ? List.of()
            : roomsOf.getOrDefault(w.id(), List.of());

        final List<GenerationInput.Requirement> out = new ArrayList<>();
        final int weeklyTotal = Math.max(weekly, weeklyEntries.size());
        for (int i = 0; i < weeklyTotal; i++) {
            out.add(session(w, i, false, i < weeklyEntries.size() ? weeklyEntries.get(i) : null,
                lecturersOf, groupsOf, studentsOf, rooms, abstractRoom, isOnline));
        }
        final int biweeklyTotal = Math.max(biweekly ? 1 : 0, biweeklyEntries.size());
        for (int i = 0; i < biweeklyTotal; i++) {
            out.add(session(w, i, true, i < biweeklyEntries.size() ? biweeklyEntries.get(i) : null,
                lecturersOf, groupsOf, studentsOf, rooms, abstractRoom, isOnline));
        }
        return out;
    }

    private GenerationInput.Requirement session(
            TimetableGenerationRepository.WorkloadRow w, int index, boolean isBiweekly,
            TimetableGenerationRepository.EntryRow entry,
            Map<Long, List<Long>> lecturersOf, Map<Long, List<Long>> groupsOf,
            Map<Long, Integer> studentsOf, List<Long> rooms, Long abstractRoom, boolean isOnline) {

        final String key = w.id() + "::" + (isBiweekly ? "bi" : "wk") + "::" + index;
        final GenerationInput.Placement current = entry == null ? null
            : new GenerationInput.Placement(entry.dayOfWeek(), entry.classStartTimeId(),
                entry.roomId(), entry.weekParity());
        return new GenerationInput.Requirement(key, w.id(), entry == null ? null : entry.id(),
            w.courseName(), w.hourType(), w.durationHours(), w.classStartTimeSetId(),
            lecturersOf.getOrDefault(w.id(), List.of()), groupsOf.getOrDefault(w.id(), List.of()),
            rooms, abstractRoom, isOnline, studentsOf.getOrDefault(w.id(), 0), isBiweekly,
            current, false, w.facultyId());
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private static List<GenerationInput.ConstraintSet> constraintSets(
            List<TimetableGenerationRepository.ConstraintRow> rows) {
        final Map<Long, List<GenerationInput.Constraint>> bySubject = new LinkedHashMap<>();
        for (TimetableGenerationRepository.ConstraintRow r : rows) {
            bySubject.computeIfAbsent(r.subjectId(), k -> new ArrayList<>())
                .add(new GenerationInput.Constraint(r.type(), r.dayOfWeek(), r.value()));
        }
        return bySubject.entrySet().stream()
            .map(e -> new GenerationInput.ConstraintSet(e.getKey(), e.getValue()))
            .toList();
    }

    private static <T, K, V> Map<K, List<V>> group(List<T> rows, Function<T, K> key, Function<T, V> value) {
        final Map<K, List<V>> out = new LinkedHashMap<>();
        for (T r : rows) out.computeIfAbsent(key.apply(r), k -> new ArrayList<>()).add(value.apply(r));
        return out;
    }

    private static int positiveOr(String raw, int fallback) {
        if (raw == null) return fallback;
        try {
            final int n = Integer.parseInt(raw.trim());
            return n > 0 ? n : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static int presentOrDefault(Map<String, String> props, String name, int fallback) {
        if (!props.containsKey(name)) return fallback;
        try {
            final int n = Integer.parseInt(props.get(name).trim());
            return Math.max(n, 0);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String normaliseParity(String raw) {
        return "EVEN".equals(raw) ? "EVEN" : "ODD";
    }
}
