package org.lnu.timetable.framework.metadata;

import java.util.List;
import java.util.Map;

/**
 * Complete metadata about an entity, built at startup from annotations.
 */
public record EntityMetadata(
    Class<?> entityClass,
    String tableName,
    /**
     * The column that identifies one row of {@code tableName} — {@code "id"} for all but the
     * entities keyed by their parent (see {@code @GraphQLEntity#key()}). Generated SQL selects it
     * aliased as {@code id}, so relation batching, the create response and the GraphQL
     * {@code id: ID!} field never have to know which column it actually is.
     */
    String keyColumn,
    Map<String, EntityFieldMetadata> fields,
    List<String> selectableColumns,
    Map<String, RelationMetadata> relations,
    /**
     * The identifier used for this entity in {@code permissions.resource_type} (the class's
     * simple name in UPPER_SNAKE_CASE, e.g. {@code "WORKING_CURRICULUM_ITEM"}) — see
     * {@code org.lnu.timetable.security.PermissionService}.
     */
    String resourceType,
    /** FK-based permission ancestor edges declared via {@code @PermissionParent}. */
    List<PermissionParentEdge> permissionParents,
    /** Join-table-based permission ancestor edges declared via {@code @PermissionJoinParent}. */
    List<PermissionJoinParentEdge> permissionJoinParents,
    /**
     * Declared {@code @PermissionRoot}: this entity has no owner, so only a {@code GLOBAL} grant
     * reaches it. An entity declaring neither this nor a parent edge fails startup — see
     * {@link EntityMetadataRegistry}.
     */
    boolean permissionRoot
) {
    public EntityFieldMetadata getField(String name) {
        return fields.get(name);
    }

    public RelationMetadata getRelation(String name) {
        return relations.get(name);
    }
}
