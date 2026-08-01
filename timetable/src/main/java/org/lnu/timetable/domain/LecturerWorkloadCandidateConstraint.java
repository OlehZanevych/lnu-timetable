package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

/**
 * A student-count limit on one {@link LecturerWorkloadCandidate}, used when the underlying working
 * curriculum item is taught {@code INDIVIDUALLY} — coursework consultations and the like, where a
 * lecturer's share of the work is a number of students rather than a set of groups.
 * <p>
 * {@code MIN_STUDENTS} is the desired count: generation aims to give this candidate at least that
 * many students. {@code MAX_STUDENTS} is the ceiling — once every candidate's desired count is met
 * (or where none was set), the remaining students are distributed among candidates that still have
 * headroom, in descending order of {@link LecturerWorkloadCandidate#getDesirability() desirability}.
 * <p>
 * Written through LecturerWorkloadCandidate's create/update mutations as the {@code constraints}
 * nested list, so a candidate's limits are replaced together with the candidate itself.
 */
@Data
@GraphQLEntity(table = "lecturer_workload_candidate_constraints")
@PermissionParent(value = LecturerWorkloadCandidate.class, joinColumn = "lecturer_workload_candidate_id")
public class LecturerWorkloadCandidateConstraint {

    private Long id;

    @PgEnum("lecturer_workload_candidate_constraint_type")
    @Description("MIN_STUDENTS (desired number of students) or MAX_STUDENTS (hard ceiling)")
    private String constraintType;

    @Description("Number of students")
    private Integer value;

    @ManyToOne(joinColumn = "lecturer_workload_candidate_id")
    private LecturerWorkloadCandidate lecturerWorkloadCandidate;
}
