package org.lnu.timetable.framework.metadata;

/**
 * Metadata form of {@code @PermissionParent}: a foreign-key-based ancestor edge used by the
 * authorization framework to compute which entities a permission grant cascades to.
 */
public record PermissionParentEdge(
    Class<?> parentEntity,
    String joinColumn,
    boolean nullable,
    /**
     * Whether pointing this edge at a new row requires authority over that row — see
     * {@code @PermissionParent#authority()}. Read-side cascade ignores it; only mutations care.
     */
    boolean authority
) {}
