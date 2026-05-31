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
     * For non-owning side: the field in the target entity that maps back.
     */
    String mappedBy() default "";
}
