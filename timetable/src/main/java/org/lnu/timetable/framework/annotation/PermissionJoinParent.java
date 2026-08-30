package org.lnu.timetable.framework.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Repeatable;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Same purpose as {@link PermissionParent}, but for an ancestor reached through a many-to-many
 * join table rather than a direct foreign key column — e.g. a {@code LecturerWorkload} is also
 * covered by a permission grant on any {@code Lecturer} assigned to it via
 * {@code lecturer_workload_lecturers}, or a {@code CombinedGroup} is covered by a grant on any of
 * its member {@code AcademicGroup}s via {@code combined_group_academic_groups}.
 * <p>
 * Because the relationship is many-valued, coverage is checked against <em>every</em> linked
 * parent row; permission through any one of them is sufficient.
 * <p>
 * Multiple annotations of this type may be placed on the same class (repeatable via
 * {@link PermissionJoinParents}).
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Repeatable(PermissionJoinParents.class)
public @interface PermissionJoinParent {

    /**
     * The ancestor entity class reached through the join table.
     */
    Class<?> value();

    /**
     * The join table name.
     */
    String joinTable();

    /**
     * The column in the join table referencing this entity's id.
     */
    String selfColumn();

    /**
     * The column in the join table referencing the ancestor entity's id.
     */
    String parentColumn();

    /**
     * Whether this edge carries authority, in the sense of
     * {@link PermissionParent#authority()}: a mutation that links this row to a new parent through
     * the join table must be authorized against that parent. Defaults to {@code true}, the safe
     * answer; affects mutations only.
     */
    boolean authority() default true;
}
