package org.lnu.timetable.framework.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a field whose column is backed by a native Postgres {@code ENUM} type (as opposed to a
 * plain VARCHAR/TEXT column), e.g. {@code control_form} or {@code hour_type}.
 * <p>
 * R2DBC binds Java {@code String} values as the VARCHAR wire type. Postgres will not implicitly
 * coerce a VARCHAR-typed bind parameter to a custom enum column type (unlike a literal in plain
 * SQL text, which Postgres treats as "unknown" and casts automatically) — inserting or updating
 * such a column without this fails with a "column is of type X but expression is of type
 * character varying" error. {@link org.lnu.timetable.framework.query.R2dbcQueryEngine} uses this
 * annotation's value to add an explicit {@code ::type} cast to the generated SQL for affected
 * columns.
 */
@Target(ElementType.FIELD)
@Retention(RetentionPolicy.RUNTIME)
public @interface PgEnum {
    /** The Postgres enum type name, e.g. "control_form". */
    String value();
}
