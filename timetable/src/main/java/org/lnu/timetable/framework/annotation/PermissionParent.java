package org.lnu.timetable.framework.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Repeatable;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Declares that a "modify" permission granted on {@link #value()} (an ancestor entity, e.g.
 * {@code Faculty}) also covers this entity, via a foreign key column on this entity's own table
 * that points at the ancestor's row.
 * <p>
 * This is the declarative backbone of the authorization framework
 * (see {@code org.lnu.timetable.security.PermissionService}): a user with a permission grant on
 * some resource can modify that resource and, transitively, every entity reachable by following
 * {@code @PermissionParent}/{@link PermissionJoinParent} edges upward to it. An entity may declare
 * several parents (e.g. {@code Course} can hang directly off either a {@code Faculty} or a
 * {@code Department}) — coverage through <em>any one</em> declared path is sufficient.
 * <p>
 * Multiple annotations of this type may be placed on the same class (repeatable via
 * {@link PermissionParents}).
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Repeatable(PermissionParents.class)
public @interface PermissionParent {

    /**
     * The ancestor entity class (must itself be {@code @GraphQLEntity}-annotated).
     */
    Class<?> value();

    /**
     * The foreign key column, on this entity's own table, that references the ancestor's id.
     */
    String joinColumn();

    /**
     * Whether the foreign key column may be {@code NULL} (in which case this particular path
     * simply doesn't apply to rows where it's unset — other declared parents, if any, still do).
     */
    boolean nullable() default false;

    /**
     * Whether this edge carries <em>authority</em>, meaning that a write which points it at a new
     * row must be authorized against that row.
     *
     * <p>Every permission edge grants the parent's administrators a path down to the child; that is
     * what the annotation is for, and it is the same in both cases. What differs is what
     * <em>attaching</em> along the edge means. Moving a DegreeProgram to another Faculty hands it
     * to that faculty's administration: it is a change of who owns the row, and a caller who does
     * not administer the destination must not be able to make it. Pointing a TimetableEntry at
     * another Room is not that. The room is a shared resource the class merely occupies, and the
     * edge exists so that a building administrator can reach the classes held in their rooms —
     * requiring authority over the room to schedule into it would stop a кафедра's timetabler
     * booking a lecture hall, which is the ordinary case rather than an abuse.
     *
     * <p>The default is {@code true}, which is the safe answer: an edge nobody has thought about
     * is treated as conferring ownership, so the mistake a forgotten annotation makes is a refusal
     * rather than a silent transfer. Setting it to {@code false} is a statement about the domain —
     * "this parent is a resource, not an owner" — and should be made deliberately.
     *
     * <p>It affects mutations only. Read-side cascade, effective levels and the traversal are
     * identical for both kinds of edge.
     */
    boolean authority() default true;
}
