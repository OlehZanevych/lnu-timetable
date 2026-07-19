package org.lnu.timetable.security;

/**
 * A single node in the permission-ancestor graph: an entity type (matching
 * {@code EntityMetadata#resourceType()}, e.g. {@code "FACULTY"}) plus a row id. Used both to
 * represent a concrete permission grant's target and a node visited while walking
 * {@code @PermissionParent}/{@code @PermissionJoinParent} edges upward from some entity instance.
 */
public record ResourceRef(String resourceType, Long resourceId) {
}
