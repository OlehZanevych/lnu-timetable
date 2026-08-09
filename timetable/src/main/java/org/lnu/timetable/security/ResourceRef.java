package org.lnu.timetable.security;

/**
 * A single node in the permission-ancestor graph: an entity type (matching
 * {@code EntityMetadata#resourceType()}, e.g. {@code "FACULTY"}) plus a row id. Used both to
 * represent a concrete permission grant's target and a node visited while walking
 * {@code @PermissionParent}/{@code @PermissionJoinParent} edges upward from some entity instance.
 * <p>
 * {@link #GLOBAL} is the synthetic root above every entity: it has no row behind it, and it is what
 * a university-wide grant names. Treating it as a node of the same shape as any other — rather than
 * as a magic string spliced into each grant query's WHERE clause, which is what it used to be —
 * means "is this covered?" is one lookup with no special case, and a GLOBAL grant carries an access
 * level like any other, so «може редагувати все, але нічого не видаляти» is expressible.
 */
public record ResourceRef(String resourceType, Long resourceId) {

    /** The {@code resource_type} reserved for university-wide grants; never an entity name. */
    public static final String GLOBAL_TYPE = "GLOBAL";

    /** The synthetic root of the resource hierarchy. */
    public static final ResourceRef GLOBAL = new ResourceRef(GLOBAL_TYPE, null);

    public static ResourceRef of(String resourceType, Long resourceId) {
        return GLOBAL_TYPE.equals(resourceType) ? GLOBAL : new ResourceRef(resourceType, resourceId);
    }

    public boolean isGlobal() {
        return GLOBAL_TYPE.equals(resourceType);
    }
}
