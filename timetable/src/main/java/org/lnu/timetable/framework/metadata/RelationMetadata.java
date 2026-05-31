package org.lnu.timetable.framework.metadata;

/**
 * Metadata about a relationship between entities.
 */
public record RelationMetadata(
    String fieldName,
    RelationType type,
    Class<?> targetEntity,
    String joinColumn,
    String mappedBy,
    String joinTable,
    String inverseJoinColumn
) {}
