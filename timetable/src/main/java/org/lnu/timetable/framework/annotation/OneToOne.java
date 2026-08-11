package org.lnu.timetable.framework.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Defines a one-to-one relationship.
 */
@Target(ElementType.FIELD)
@Retention(RetentionPolicy.RUNTIME)
public @interface OneToOne {
    /**
     * The foreign key column. If empty, derived from field name + "Id".
     */
    String joinColumn() default "";

    /**
     * If this side owns the relationship (has the FK column).
     */
    boolean owning() default true;

    /**
     * For the non-owning side: the column on the target table that points back at this entity
     * (as {@code @OneToMany#mappedBy}, a column name rather than a field name). Setting it is what
     * makes this the inverse side — the foreign key is over there — so a field that names it is
     * never the owner, whatever {@link #owning()} says.
     */
    String mappedBy() default "";
}
