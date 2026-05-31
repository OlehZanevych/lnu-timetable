package org.lnu.timetable.framework.metadata;

import java.util.List;
import java.util.Map;

/**
 * Complete metadata about an entity, built at startup from annotations.
 */
public record EntityMetadata(
    Class<?> entityClass,
    String tableName,
    Map<String, EntityFieldMetadata> fields,
    List<String> selectableColumns,
    Map<String, RelationMetadata> relations
) {
    public EntityFieldMetadata getField(String name) {
        return fields.get(name);
    }

    public RelationMetadata getRelation(String name) {
        return relations.get(name);
    }
}
