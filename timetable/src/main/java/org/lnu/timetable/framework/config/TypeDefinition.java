package org.lnu.timetable.framework.config;

import java.util.ArrayList;
import java.util.List;

/**
 * Defines a GraphQL object type based on an entity class.
 * Allows selecting which fields to expose and configuring relations.
 */
public class TypeDefinition {

    private final Class<?> entityClass;
    private String typeName;
    private final List<String> includedFields = new ArrayList<>();
    private final List<RelationFieldDefinition> relationFields = new ArrayList<>();
    private boolean includeAllFields = false;

    public TypeDefinition(Class<?> entityClass) {
        this.entityClass = entityClass;
    }

    public TypeDefinition name(String typeName) {
        this.typeName = typeName;
        return this;
    }

    public TypeDefinition fields(String... fields) {
        includedFields.addAll(List.of(fields));
        return this;
    }

    public TypeDefinition allFields() {
        this.includeAllFields = true;
        return this;
    }

    public TypeDefinition relation(String fieldName) {
        relationFields.add(new RelationFieldDefinition(fieldName, null, false));
        return this;
    }

    public TypeDefinition relation(String fieldName, String targetTypeName) {
        relationFields.add(new RelationFieldDefinition(fieldName, targetTypeName, false));
        return this;
    }

    public TypeDefinition nullableRelation(String fieldName) {
        relationFields.add(new RelationFieldDefinition(fieldName, null, true));
        return this;
    }

    public Class<?> getEntityClass() { return entityClass; }
    public String getTypeName() { return typeName; }
    public List<String> getIncludedFields() { return includedFields; }
    public List<RelationFieldDefinition> getRelationFields() { return relationFields; }
    public boolean isIncludeAllFields() { return includeAllFields; }

    public record RelationFieldDefinition(String fieldName, String targetTypeName, boolean nullable) {}
}
