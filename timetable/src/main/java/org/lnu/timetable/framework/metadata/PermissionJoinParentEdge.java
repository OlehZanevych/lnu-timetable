package org.lnu.timetable.framework.metadata;

/**
 * Metadata form of {@code @PermissionJoinParent}: a many-to-many, join-table-based ancestor edge
 * used by the authorization framework to compute which entities a permission grant cascades to.
 */
public record PermissionJoinParentEdge(
    Class<?> parentEntity,
    String joinTable,
    String selfColumn,
    String parentColumn,
    /** See {@code @PermissionParent#authority()}; mutations only. */
    boolean authority
) {}
