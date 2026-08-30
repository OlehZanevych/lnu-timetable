package org.lnu.timetable.security;

import org.junit.jupiter.api.Test;
import org.lnu.timetable.domain.Course;
import org.lnu.timetable.domain.DegreeProgram;
import org.lnu.timetable.domain.LecturerWorkload;
import org.lnu.timetable.domain.TimetableEntry;
import org.lnu.timetable.framework.metadata.EntityMetadataRegistry;
import org.lnu.timetable.framework.metadata.PermissionTypeGraph;
import reactor.core.publisher.Flux;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The post-state ("WITH CHECK") half of mutation authorization.
 *
 * <p>Authorizing an update against the row as it stands answers "may this caller touch this row?"
 * and stops there — it says nothing about where the update <em>puts</em> the row, and in a cascade
 * where authority flows down structural edges, rewriting a permission-bearing foreign key is a move
 * between scopes. Without the second check a caller who administers faculty 1 can take a degree
 * programme out of it and attach it to faculty 2, which they have no rights over at all.
 *
 * <p>Half of these cases assert that a write is still ALLOWED, and they are the half that matters
 * most: a post-state check that simply denied every relationship change would satisfy the denial
 * cases and quietly break scheduling a class into a shared lecture hall.
 */
class PostStateAuthorizationTest {

    /** Fake row store: table -> id -> column -> value. */
    private static final Map<String, Map<Long, Map<String, Long>>> ROWS = Map.of(
        "degree_programs", Map.of(5L, Map.of("faculty_id", 1L)),
        "courses", Map.of(1L, Map.of("department_id", 10L),
                          3L, Map.of("department_id", 10L, "faculty_id", 2L)),
        "departments", Map.of(10L, Map.of("faculty_id", 1L)),
        "faculties", Map.of(1L, Map.of(), 2L, Map.of()),
        "timetable_entries", Map.of(42L, Map.of("workload_id", 7L, "room_id", 100L)),
        "lecturer_workloads", Map.of(7L, Map.of()),
        "rooms", Map.of(100L, Map.of(), 200L, Map.of()),
        "academic_groups", Map.of(1L, Map.of(), 2L, Map.of())
    );

    @Test
    void preStateAloneAllowsEditingWithinTheAdministeredFaculty() {
        assertTrue(Boolean.TRUE.equals(evaluator(grant("FACULTY", 1L, AccessLevel.EDIT))
            .allows(DegreeProgram.class, 5L, AccessLevel.EDIT).block()));
    }

    @Test
    void movingARowOutOfEveryAdministeredScopeIsRefused() {
        assertFalse(allowedAfter(List.of(grant("FACULTY", 1L, AccessLevel.EDIT)),
            DegreeProgram.class, 5L, Map.of("facultyId", 2L)));
    }

    @Test
    void restatingTheSameParentIsNotAMove() {
        assertTrue(allowedAfter(List.of(grant("FACULTY", 1L, AccessLevel.EDIT)),
            DegreeProgram.class, 5L, Map.of("facultyId", 1L)));
    }

    @Test
    void clearingTheOnlyCoveringParentIsRefused() {
        Map<String, Object> clearing = new LinkedHashMap<>();
        clearing.put("facultyId", null);
        assertFalse(allowedAfter(List.of(grant("FACULTY", 1L, AccessLevel.EDIT)),
            DegreeProgram.class, 5L, clearing));
    }

    @Test
    void aGlobalGrantCoversTheDestination() {
        assertTrue(allowedAfter(List.of(grant(ResourceRef.GLOBAL_TYPE, null, AccessLevel.EDIT)),
            DegreeProgram.class, 5L, Map.of("facultyId", 2L)));
    }

    /**
     * Rooms are shared: a timetable entry names one, and the room is a permission parent so that a
     * building administrator can reach the entries in it. Scheduling into a hall one does not
     * administer must stay possible, because the workload edge still covers the row. This is why the
     * post-state rule is the ordinary any-path maximum and not "authority over every destination".
     */
    @Test
    void movingToAnUnadministeredRoomStaysAllowedWhenAnotherEdgeStillCovers() {
        assertTrue(allowedAfter(List.of(grant("LECTURER_WORKLOAD", 7L, AccessLevel.EDIT)),
            TimetableEntry.class, 42L, Map.of("roomId", 200L)));
    }

    @Test
    void movingToAnUnadministeredWorkloadIsRefusedWhenNothingElseCovers() {
        assertFalse(allowedAfter(List.of(grant("LECTURER_WORKLOAD", 7L, AccessLevel.EDIT)),
            TimetableEntry.class, 42L, Map.of("workloadId", 8L)));
    }

    /** The edge the update leaves alone still counts, and has to be read back off the row. */
    @Test
    void anUnchangedEdgeStillCoversTheResultingRow() {
        assertTrue(allowedAfter(List.of(grant("ROOM", 100L, AccessLevel.EDIT)),
            TimetableEntry.class, 42L, Map.of("workloadId", 8L)));
    }

    // --- introduced scopes: may the caller hand the row to a new owner? ---

    /**
     * The residual case the post-state check does not cover on its own: the row keeps a parent the
     * caller administers, so it never leaves their reach, but it acquires a second one they do not
     * administer — and that parent's administrators thereby acquire authority over the row.
     */
    @Test
    void attachingAnAuthorityBearingParentTheCallerDoesNotAdministerIsRefused() {
        assertFalse(introducedScopesAllowed(List.of(grant("DEPARTMENT", 10L, AccessLevel.EDIT)),
            Course.class, 1L, Map.of("facultyId", 2L)));
    }

    /** ...and is allowed when the caller does administer the destination. */
    @Test
    void attachingAnAuthorityBearingParentTheCallerAdministersIsAllowed() {
        assertTrue(introducedScopesAllowed(
            List.of(grant("DEPARTMENT", 10L, AccessLevel.EDIT), grant("FACULTY", 2L, AccessLevel.EDIT)),
            Course.class, 1L, Map.of("facultyId", 2L)));
    }

    /**
     * The exemption that makes the rule usable. A timetable entry's room is declared
     * {@code authority = false}: the edge lets a building administrator reach the classes held in
     * their rooms, and must not make administering the room a precondition for scheduling into it.
     */
    @Test
    void attachingASharedResourceParentDoesNotRequireAuthorityOverIt() {
        assertTrue(introducedScopesAllowed(List.of(grant("LECTURER_WORKLOAD", 7L, AccessLevel.EDIT)),
            TimetableEntry.class, 42L, Map.of("roomId", 200L)));
    }

    /**
     * Re-stating the parent the row already has introduces nothing and must not be refused.
     *
     * <p>Course 3 already hangs off faculty 2, and the caller administers only its department, so
     * they hold nothing on faculty 2. A rule that failed to compare the proposed value against the
     * stored one would refuse this — which would break every client that sends a whole object back
     * on save, unchanged fields included, and is how a correct-looking check becomes an outage.
     */
    @Test
    void restatingAnExistingParentIntroducesNothing() {
        assertTrue(introducedScopesAllowed(List.of(grant("DEPARTMENT", 10L, AccessLevel.EDIT)),
            Course.class, 3L, Map.of("facultyId", 2L)));
    }

    /** On a create every named authority-bearing parent is newly introduced. */
    @Test
    void creatingUnderAnUnadministeredParentIsRefused() {
        assertFalse(introducedScopesAllowed(List.of(grant("DEPARTMENT", 10L, AccessLevel.EDIT)),
            Course.class, null, Map.of("facultyId", 2L, "departmentId", 10L)));
    }

    /**
     * Two scopes introduced at once, through one join-table list, of which the caller administers
     * one. "Every" refuses and "any" would not — and every other case in this class introduces a
     * single scope, where the two rules agree, so without this one a check written with the wrong
     * quantifier would pass the whole suite.
     */
    @Test
    void introducingTwoScopesRequiresAuthorityOverBoth() {
        assertFalse(introducedScopesAllowed(List.of(grant("ACADEMIC_GROUP", 1L, AccessLevel.EDIT)),
            LecturerWorkload.class, 7L,
            Map.of(), Map.of("lecturer_workload_academic_groups", List.of(1L, 2L))));
    }

    @Test
    void introducingTwoScopesTheCallerAdministersIsAllowed() {
        assertTrue(introducedScopesAllowed(
            List.of(grant("ACADEMIC_GROUP", 1L, AccessLevel.EDIT), grant("ACADEMIC_GROUP", 2L, AccessLevel.EDIT)),
            LecturerWorkload.class, 7L,
            Map.of(), Map.of("lecturer_workload_academic_groups", List.of(1L, 2L))));
    }

    // --- fixtures ---

    private boolean allowedAfter(List<PermissionRepository.PermissionRow> grants,
                                 Class<?> entityClass, Long id, Map<String, Object> input) {
        PermissionEvaluator evaluator = evaluator(grants.toArray(new PermissionRepository.PermissionRow[0]));
        assertTrue(evaluator.movesScope(entityClass, input, Set.of()),
            "this input rewrites a permission-bearing edge and must be recognised as a scope move");
        AccessLevel level = evaluator.levelAfterUpdate(entityClass, id, input, Map.of()).block();
        return level != null && level.allows(AccessLevel.EDIT);
    }

    private boolean introducedScopesAllowed(List<PermissionRepository.PermissionRow> grants,
                                            Class<?> entityClass, Long id, Map<String, Object> input) {
        return introducedScopesAllowed(grants, entityClass, id, input, Map.of());
    }

    private boolean introducedScopesAllowed(List<PermissionRepository.PermissionRow> grants,
                                            Class<?> entityClass, Long id, Map<String, Object> input,
                                            Map<String, Collection<Long>> joinLists) {
        return Boolean.TRUE.equals(evaluator(grants.toArray(new PermissionRepository.PermissionRow[0]))
            .allowsIntroducedScopes(entityClass, id, input, joinLists, AccessLevel.EDIT).block());
    }

    private PermissionEvaluator evaluator(PermissionRepository.PermissionRow... grants) {
        EntityMetadataRegistry registry = new EntityMetadataRegistry();
        return new PermissionEvaluator(1L, registry, new PermissionTypeGraph(registry),
            new FakeGraphRepository(), new FakePermissionRepository(List.of(grants)));
    }

    private static PermissionRepository.PermissionRow grant(String type, Long id, AccessLevel level) {
        return new PermissionRepository.PermissionRow(1L, "USER", 1L, null, type, id, level, null);
    }

    private static final class FakeGraphRepository extends PermissionGraphRepository {
        FakeGraphRepository() { super(null); }

        @Override
        public Flux<FkEdge> fetchForeignKeys(String table, String keyColumn,
                                             List<String> columns, Collection<Long> ids) {
            if (columns.isEmpty() || ids.isEmpty()) return Flux.empty();
            Map<Long, Map<String, Long>> rows = ROWS.getOrDefault(table, Map.of());
            return Flux.fromIterable(ids).flatMapIterable(id -> columns.stream()
                .map(column -> {
                    Long value = rows.getOrDefault(id, Map.of()).get(column);
                    return value == null ? null : new FkEdge(id, column, value);
                })
                .filter(Objects::nonNull)
                .toList());
        }

        @Override
        public Flux<JoinEdge> fetchJoinParents(String joinTable, String selfColumn,
                                               String parentColumn, Collection<Long> ids) {
            return Flux.empty();
        }
    }

    private static final class FakePermissionRepository extends PermissionRepository {
        private final List<PermissionRow> rows;

        FakePermissionRepository(List<PermissionRow> rows) { super(null); this.rows = rows; }

        @Override public Flux<Long> groupIdsForUser(Long userId) { return Flux.empty(); }

        @Override public Flux<PermissionRow> effectiveGrants(Long userId, List<Long> groupIds) {
            return Flux.fromIterable(rows);
        }
    }
}
