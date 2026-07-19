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
}
