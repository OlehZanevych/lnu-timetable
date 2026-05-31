package org.lnu.timetable.framework.metadata;

/**
 * Metadata about a single entity field.
 */
public record EntityFieldMetadata(
    String name,
    String columnName,
    Class<?> type,
    boolean nullable,
    String description
) {}
