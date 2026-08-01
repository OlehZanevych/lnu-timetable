package org.lnu.timetable.domain;

import lombok.Data;
import org.lnu.timetable.framework.annotation.Description;
import org.lnu.timetable.framework.annotation.GraphQLEntity;
import org.lnu.timetable.framework.annotation.ManyToOne;
import org.lnu.timetable.framework.annotation.PermissionParent;
import org.lnu.timetable.framework.annotation.PgEnum;

/**
 * One workload restriction set for a lecturer — a (type, value) pair rather than a column per rule,
 * since only a handful of the two dozen possible constraints are ever set for a given person.
 * <p>
 * A lecturer with no row for a constraint is unconstrained by it, with one exception:
 * {@code MAX_HOURS_PER_YEAR} falls back to the {@code default_max_hours_per_year} global property.
 * <p>
 * Rows are written exclusively through Lecturer's create/update mutations via the
 * {@code workloadConstraints} nested list — there are no standalone mutations, so a lecturer's
 * whole constraint set is replaced in one call and can be validated as a whole.
 */
@Data
@GraphQLEntity(table = "lecturer_workload_constraints")
@PermissionParent(value = Lecturer.class, joinColumn = "lecturer_id")
public class LecturerWorkloadConstraint {

    private Long id;

    @PgEnum("lecturer_workload_constraint_type")
    @Description("MIN_HOURS_PER_YEAR, MAX_HOURS_PER_YEAR, MAX_COURSES, "
        + "MIN/MAX_[MANDATORY|ELECTIVE]_[LECTURE|PRACTICAL|LAB]_COURSES")
    private String constraintType;

    @Description("The constraint's bound: academic hours for the *_HOURS_PER_YEAR types, a count of distinct courses otherwise")
    private Integer value;

    @ManyToOne(joinColumn = "lecturer_id")
    private Lecturer lecturer;
}
