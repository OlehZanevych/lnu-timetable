package org.lnu.timetable.framework.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Defines a many-to-many relationship.
 */
@Target(ElementType.FIELD)
@Retention(RetentionPolicy.RUNTIME)
public @interface ManyToMany {
    /**
     * The join table name.
     */
    String joinTable();

    /**
     * The column in the join table referencing this entity.
     */
    String joinColumn();

    /**
     * The column in the join table referencing the target entity.
     */
    String inverseJoinColumn();
}
