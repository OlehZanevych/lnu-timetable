package org.lnu.timetable.generation;

import graphql.schema.DataFetcher;
import graphql.schema.DataFetchingEnvironment;
import org.lnu.timetable.domain.LecturerWorkload;
import org.lnu.timetable.security.AccessLevel;
import org.lnu.timetable.security.GraphQlAuthException;
import org.lnu.timetable.security.PermissionEvaluator;
import org.lnu.timetable.security.PermissionService;
import org.lnu.timetable.security.Principal;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The fetchers behind {@link TimetableGenerationSchema}: read the whole solver input in one request,
 * and write a generated timetable back in one more.
 *
 * <h2>Authorization, stated here because nothing states it for us</h2>
 *
 * A {@code HandWrittenApi} area does not route through {@code AuthorizingDataFetcherProvider}, so
 * the rule is written out. It is the same rule the generated mutations apply, read one level up:
 * creating or updating a {@code timetable_entries} row needs {@link AccessLevel#EDIT} over its
 * {@code LecturerWorkload}, deleting one needs {@link AccessLevel#FULL}. The query needs no more
 * than a signed-in caller, but it reports per class whether this caller may move it — the
 * {@code locked} flag — so the generator schedules around what it is not allowed to touch instead of
 * proposing a plan that would be refused a class at a time on the way back in.
 *
 * <h2>Why the save is per class rather than per batch</h2>
 *
 * A class the save refuses is named and reported, and every other class still lands. The
 * alternative — one array statement, all or nothing — would be faster and would turn a single
 * unreachable room into «нічого не збережено», which is not a report a деканат can act on. The
 * batch is a few thousand rows at the very most, and a few thousand statements against a local
 * database is a fraction of the hour the search itself just spent.
 */
@Component
public class TimetableGenerationDataFetchers {

    /** Replace everything this run owns, or keep what is already placed and fill in the rest. */
    private static final String MODE_REPLACE = "REPLACE";

    private final TimetableGenerationAssembler assembler;
    private final TimetableGenerationRepository repo;
    private final PermissionService permissionService;

    public TimetableGenerationDataFetchers(TimetableGenerationAssembler assembler,
                                           TimetableGenerationRepository repo,
                                           PermissionService permissionService) {
        this.assembler = assembler;
        this.repo = repo;
        this.permissionService = permissionService;
    }

    // ── Query.timetableGenerationInput ───────────────────────────────────────

    public DataFetcher<?> generationInput() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            final Long facultyId = idArgument(env, "facultyId");
            final String parity = env.getArgument("semesterParity");
            final PermissionEvaluator evaluator = evaluatorOf(env, principal);

            return assembler.assemble(facultyId, parity)
                .flatMap(payload -> markLocked(evaluator, payload))
                .map(TimetableGenerationDataFetchers::payloadToMap);
        }).toFuture();
    }

    /**
     * Rewrites each requirement's {@code locked} flag from what this caller may actually edit.
     *
     * <p>An unauthorised class is <em>reported</em> rather than dropped: it stays in the payload,
     * immovable, so the search schedules around the slot it occupies. Dropping it would let the
     * generator place something else into a room the timetable still holds.
     */
    private Mono<TimetableGenerationAssembler.Payload> markLocked(PermissionEvaluator evaluator,
                                                                  TimetableGenerationAssembler.Payload payload) {
        final Set<Long> workloadIds = new LinkedHashSet<>();
        for (GenerationInput.Requirement r : payload.requirements()) workloadIds.add(r.workloadId());
        if (workloadIds.isEmpty()) return Mono.just(payload);

        return evaluator.levelsFor(LecturerWorkload.class, workloadIds).map(levels -> {
            final List<GenerationInput.Requirement> out = new ArrayList<>(payload.requirements().size());
            for (GenerationInput.Requirement r : payload.requirements()) {
                final AccessLevel level = levels.get(r.workloadId());
                final boolean mayEdit = level != null && level.allows(AccessLevel.EDIT);
                out.add(mayEdit ? r : withLocked(r));
            }
            return new TimetableGenerationAssembler.Payload(payload.academicHourMinutes(),
                payload.semesterDurationWeeks(), payload.semesterParity(),
                payload.abstractRoomTravelMinutes(), payload.universityCommuteMinutes(),
                payload.days(), payload.faculties(), payload.classTimes(), payload.rooms(),
                payload.roomBuilding(), payload.buildingTravel(), payload.abstractRooms(),
                out, payload.fixedEntries(), payload.lecturerConstraints(),
                payload.groupConstraints(), payload.roomConstraints());
        });
    }

    private static GenerationInput.Requirement withLocked(GenerationInput.Requirement r) {
        return new GenerationInput.Requirement(r.key(), r.workloadId(), r.entryId(), r.courseName(),
            r.hourType(), r.durationHours(), r.classStartTimeSetId(), r.lecturerIds(), r.groupIds(),
            r.roomIds(), r.abstractRoomId(), r.isOnline(), r.studentsCount(), r.isBiweekly(),
            r.current(), true, r.facultyId());
    }

    // ── Mutation.saveGeneratedTimetable ──────────────────────────────────────

    @SuppressWarnings("unchecked")
    public DataFetcher<?> saveGeneratedTimetable() {
        return env -> requirePrincipal(env).flatMap(principal -> {
            final Map<String, Object> input = env.getArgument("input");
            final String mode = input.get("mode") == null ? MODE_REPLACE : input.get("mode").toString();
            final List<Map<String, Object>> raw =
                (List<Map<String, Object>>) input.getOrDefault("placements", List.of());
            final List<Long> deleteIds = toIds((List<Object>) input.get("deleteEntryIds"));

            final List<GenerationInput.GeneratedPlacement> placements = new ArrayList<>(raw.size());
            for (Map<String, Object> p : raw) {
                placements.add(new GenerationInput.GeneratedPlacement(
                    str(p.get("key")), toId(p.get("workloadId")), toId(p.get("entryId")),
                    ((Number) p.get("dayOfWeek")).intValue(), toId(p.get("classStartTimeId")),
                    toId(p.get("roomId")), str(p.get("weekParity"))));
            }
            if (placements.isEmpty() && deleteIds.isEmpty()) {
                return Mono.just(saveResult(true, 0, 0, 0, null, List.of()));
            }

            final PermissionEvaluator evaluator = evaluatorOf(env, principal);
            final Set<Long> workloadIds = new LinkedHashSet<>();
            for (GenerationInput.GeneratedPlacement p : placements) workloadIds.add(p.workloadId());
            final Set<Long> startTimeIds = new LinkedHashSet<>();
            for (GenerationInput.GeneratedPlacement p : placements) startTimeIds.add(p.classStartTimeId());

            // The workloads behind the rows being deleted, because deletion is authorized over the
            // workload and a delete-only request carries no placements to read them from.
            return repo.workloadsOfEntries(deleteIds).collectList().flatMap(deleteLinks -> {
                final Set<Long> deleteWorkloads = new LinkedHashSet<>();
                for (TimetableGenerationRepository.Link l : deleteLinks) deleteWorkloads.add(l.workloadId());
                final Set<Long> allWorkloads = new LinkedHashSet<>(workloadIds);
                allWorkloads.addAll(deleteWorkloads);

                return Mono.zip(
                    evaluator.levelsFor(LecturerWorkload.class, allWorkloads),
                    repo.legalBells(workloadIds, startTimeIds).collectList()
                ).flatMap(t -> {
                final Map<Long, AccessLevel> levels = t.getT1();
                final Set<String> legalBell = new HashSet<>();
                for (TimetableGenerationRepository.Link l : t.getT2()) {
                    legalBell.add(l.workloadId() + ":" + l.otherId());
                }

                final List<GenerationInput.Rejection> rejected = new ArrayList<>();
                final List<GenerationInput.GeneratedPlacement> accepted = new ArrayList<>();
                for (GenerationInput.GeneratedPlacement p : placements) {
                    final AccessLevel level = levels.get(p.workloadId());
                    if (level == null || !level.allows(AccessLevel.EDIT)) {
                        rejected.add(new GenerationInput.Rejection(p.key(), "NO_EDIT_ACCESS"));
                        continue;
                    }
                    if (p.dayOfWeek() < 1 || p.dayOfWeek() > 7) {
                        rejected.add(new GenerationInput.Rejection(p.key(), "BAD_DAY_OF_WEEK"));
                        continue;
                    }
                    if (!isParity(p.weekParity())) {
                        rejected.add(new GenerationInput.Rejection(p.key(), "BAD_WEEK_PARITY"));
                        continue;
                    }
                    // The bell must belong to the workload's own grid. schema.sql states this in a
                    // comment and leaves it to "the scheduler" because it is a join away from the
                    // row; this is the first place in the service that has ever checked it.
                    if (!legalBell.contains(p.workloadId() + ":" + p.classStartTimeId())) {
                        rejected.add(new GenerationInput.Rejection(p.key(), "BELL_NOT_IN_WORKLOAD_SET"));
                        continue;
                    }
                    accepted.add(p);
                }

                if (!deleteIds.isEmpty()) {
                    // Deletion is FULL, not EDIT, exactly as the generated mutations have it — and it
                    // is checked against the workloads of the *rows being deleted* rather than against
                    // the placements. Reading it off the placements made "every workload in the batch
                    // has FULL" pass vacuously on a request that only deleted, which is the one
                    // request where the check mattered most.
                    if (deleteLinks.size() != deleteIds.size()) {
                        // An id that names no row is a disagreement about state, not a permission to
                        // delete the rest of the batch.
                        return Mono.just(saveResult(false, 0, 0, 0, "ENTRY_NOT_FOUND", rejected));
                    }
                    final boolean mayDeleteAll = !deleteWorkloads.isEmpty() && deleteWorkloads.stream()
                        .allMatch(w -> {
                            final AccessLevel level = levels.get(w);
                            return level != null && level.allows(AccessLevel.FULL);
                        });
                    if (!mayDeleteAll) {
                        return Mono.just(saveResult(false, 0, 0, 0, "NO_DELETE_ACCESS", rejected));
                    }
                }

                return applyAll(accepted, deleteIds, MODE_REPLACE.equals(mode))
                    .map(counts -> saveResult(true, counts[0], counts[1], counts[2], null, rejected));
                });
            });
        }).toFuture();
    }

    /** @return {created, updated, deleted} */
    private Mono<int[]> applyAll(List<GenerationInput.GeneratedPlacement> placements,
                                 List<Long> deleteIds, boolean replace) {
        final int[] counts = new int[3];
        // Updates before creates, matching the client's apply path: an update frees nothing and a
        // create takes a slot, so doing them the other way round transiently doubles the occupancy
        // of every room being rearranged — harmless to the database, confusing to anybody reading
        // the timetable at that moment.
        final List<GenerationInput.GeneratedPlacement> updates = placements.stream()
            .filter(p -> p.entryId() != null).toList();
        final List<GenerationInput.GeneratedPlacement> creates = placements.stream()
            .filter(p -> p.entryId() == null).toList();

        return repo.deleteEntries(deleteIds)
            .doOnNext(n -> counts[2] = n.intValue())
            .thenMany(Flux.fromIterable(updates).concatMap(p -> repo.updateEntry(p)
                .doOnNext(n -> { if (n > 0) counts[1]++; })))
            .thenMany(Flux.fromIterable(creates).concatMap(p -> repo.insertEntry(p)
                .doOnNext(id -> counts[0]++)))
            .then(Mono.fromSupplier(() -> counts));
    }

    // ── mapping ──────────────────────────────────────────────────────────────

    private static Map<String, Object> payloadToMap(TimetableGenerationAssembler.Payload p) {
        final Map<String, Object> m = new LinkedHashMap<>();
        m.put("academicHourMinutes", p.academicHourMinutes());
        m.put("semesterDurationWeeks", p.semesterDurationWeeks());
        m.put("semesterParity", p.semesterParity());
        m.put("abstractRoomTravelMinutes", p.abstractRoomTravelMinutes());
        m.put("universityCommuteMinutes", p.universityCommuteMinutes());
        m.put("days", p.days());
        m.put("faculties", p.faculties().stream().map(f -> map("id", f.id(), "name", f.name(),
            "abbreviation", f.abbreviation())).toList());
        m.put("classTimes", p.classTimes().stream().map(t -> map("id", t.id(), "setId", t.setId(),
            "ordinal", t.ordinal(), "startTime", t.startTime())).toList());
        m.put("rooms", p.rooms());
        m.put("roomBuilding", p.roomBuilding().stream()
            .map(r -> map("roomId", r.roomId(), "buildingId", r.buildingId())).toList());
        m.put("buildingTravel", p.buildingTravel().stream()
            .map(b -> map("fromBuildingId", b.fromBuildingId(), "toBuildingId", b.toBuildingId(),
                "minutes", b.minutes())).toList());
        m.put("abstractRooms", p.abstractRooms().stream()
            .map(a -> map("id", a.id(), "name", a.name(), "capacity", a.capacity(),
                "buildingId", a.buildingId())).toList());
        m.put("requirements", p.requirements().stream().map(TimetableGenerationDataFetchers::requirementToMap).toList());
        m.put("fixedEntries", p.fixedEntries().stream().map(f -> {
            final Map<String, Object> e = new LinkedHashMap<>();
            e.put("id", f.id());
            e.put("dayOfWeek", f.dayOfWeek());
            e.put("weekParity", f.weekParity());
            e.put("startTime", f.startTime());
            e.put("durationHours", f.durationHours());
            e.put("lecturerIds", f.lecturerIds());
            e.put("groupIds", f.groupIds());
            e.put("roomId", f.roomId());
            e.put("abstractRoomId", f.abstractRoomId());
            e.put("isOnline", f.isOnline());
            e.put("studentsCount", f.studentsCount());
            return e;
        }).toList());
        m.put("lecturerConstraints", constraintSetsToMaps(p.lecturerConstraints()));
        m.put("groupConstraints", constraintSetsToMaps(p.groupConstraints()));
        m.put("roomConstraints", constraintSetsToMaps(p.roomConstraints()));
        return m;
    }

    private static Map<String, Object> requirementToMap(GenerationInput.Requirement r) {
        final Map<String, Object> m = new LinkedHashMap<>();
        m.put("key", r.key());
        m.put("workloadId", r.workloadId());
        m.put("entryId", r.entryId());
        m.put("courseName", r.courseName());
        m.put("hourType", r.hourType());
        m.put("durationHours", r.durationHours());
        m.put("classStartTimeSetId", r.classStartTimeSetId());
        m.put("lecturerIds", r.lecturerIds());
        m.put("groupIds", r.groupIds());
        m.put("roomIds", r.roomIds());
        m.put("abstractRoomId", r.abstractRoomId());
        m.put("isOnline", r.isOnline());
        m.put("studentsCount", r.studentsCount());
        m.put("isBiweekly", r.isBiweekly());
        m.put("locked", r.locked());
        m.put("facultyId", r.facultyId());
        m.put("current", r.current() == null ? null : map(
            "dayOfWeek", r.current().dayOfWeek(),
            "classStartTimeId", r.current().classStartTimeId(),
            "roomId", r.current().roomId(),
            "weekParity", r.current().weekParity()));
        return m;
    }

    private static List<Map<String, Object>> constraintSetsToMaps(List<GenerationInput.ConstraintSet> sets) {
        return sets.stream().map(s -> map("subjectId", s.subjectId(),
            "constraints", s.constraints().stream()
                .map(c -> map("type", c.type(), "dayOfWeek", c.dayOfWeek(), "value", c.value()))
                .toList())).toList();
    }

    private static Map<String, Object> saveResult(boolean success, int created, int updated, int deleted,
                                                  String errorStatus, List<GenerationInput.Rejection> rejected) {
        final Map<String, Object> m = new LinkedHashMap<>();
        m.put("isSuccess", success);
        m.put("created", created);
        m.put("updated", updated);
        m.put("deleted", deleted);
        m.put("errorStatus", errorStatus);
        m.put("rejected", rejected.stream().map(r -> map("key", r.key(), "reason", r.reason())).toList());
        return m;
    }

    // ── small helpers ────────────────────────────────────────────────────────

    private Mono<Principal> requirePrincipal(DataFetchingEnvironment env) {
        final Principal principal = env.getGraphQlContext().get(Principal.class);
        return principal == null
            ? Mono.error(new GraphQlAuthException("You must be signed in to do this."))
            : Mono.just(principal);
    }

    private PermissionEvaluator evaluatorOf(DataFetchingEnvironment env, Principal principal) {
        final PermissionEvaluator evaluator = env.getGraphQlContext().get(PermissionEvaluator.class);
        return evaluator != null ? evaluator : permissionService.newEvaluator(principal.userId());
    }

    private static Long idArgument(DataFetchingEnvironment env, String name) {
        final Object raw = env.getArgument(name);
        return raw == null || raw.toString().isBlank() ? null : Long.parseLong(raw.toString());
    }

    private static Long toId(Object raw) {
        return raw == null || raw.toString().isBlank() ? null : Long.parseLong(raw.toString());
    }

    private static List<Long> toIds(List<Object> raw) {
        if (raw == null) return List.of();
        final List<Long> out = new ArrayList<>(raw.size());
        for (Object o : raw) {
            final Long id = toId(o);
            if (id != null) out.add(id);
        }
        return out;
    }

    private static String str(Object raw) {
        return raw == null ? null : raw.toString();
    }

    private static boolean isParity(String value) {
        return "WEEKLY".equals(value) || "NUMERATOR".equals(value) || "DENOMINATOR".equals(value);
    }

    private static Map<String, Object> map(Object... kv) {
        final Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }
}
