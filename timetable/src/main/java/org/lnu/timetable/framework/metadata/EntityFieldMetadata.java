package org.lnu.timetable.framework.metadata;

/**
 * Metadata about a single entity field.
 *
 * @param pgEnumType Postgres enum type name if this column is backed by a native enum type
 *                   (from {@code @PgEnum}), otherwise {@code null}.
 */
public record EntityFieldMetadata(
    String name,
    String columnName,
    Class<?> type,
    boolean nullable,
    String description,
    String pgEnumType
) {}
