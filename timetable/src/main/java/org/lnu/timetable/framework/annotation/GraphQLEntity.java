package org.lnu.timetable.framework.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a class as a GraphQL entity that can be used in schema configuration.
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface GraphQLEntity {
    /**
     * The database table name. If empty, derived from class name.
     */
    String table() default "";

    /**
     * The column that identifies one row. Almost every table here has a surrogate {@code id}, but a
     * table whose whole content is one row per parent says so with the parent's key rather than
     * carrying a second name for the same row (see {@code lecturer_workload_online_classes}).
     * Generated SQL always projects this column aliased as {@code id}, so naming it here is the
     * only place the difference is visible.
     */
    String key() default "id";
}
