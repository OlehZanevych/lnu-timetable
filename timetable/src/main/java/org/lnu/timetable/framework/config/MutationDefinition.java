package org.lnu.timetable.framework.config;

import java.util.ArrayList;
import java.util.List;

/**
 * Defines a GraphQL mutation (create, update, delete) for an entity.
 */
public class MutationDefinition {

    public enum MutationType { CREATE, UPDATE, DELETE }

    private final String name;
    private Class<?> entityClass;
    private MutationType mutationType;
    private final List<String> inputFields = new ArrayList<>();
    private final List<ErrorStatus> errorStatuses = new ArrayList<>();

    public MutationDefinition(String name) {
        this.name = name;
    }

    public MutationDefinition entity(Class<?> entityClass) {
        this.entityClass = entityClass;
        return this;
    }

    public MutationDefinition create() {
        this.mutationType = MutationType.CREATE;
        return this;
    }

    public MutationDefinition update() {
        this.mutationType = MutationType.UPDATE;
        return this;
    }

    public MutationDefinition delete() {
        this.mutationType = MutationType.DELETE;
        return this;
    }

    public MutationDefinition inputFields(String... fields) {
        inputFields.addAll(List.of(fields));
        return this;
    }

    public MutationDefinition errorStatus(String name, String description) {
        errorStatuses.add(new ErrorStatus(name, description));
        return this;
    }

    public String getName() { return name; }
    public Class<?> getEntityClass() { return entityClass; }
    public MutationType getMutationType() { return mutationType; }
    public List<String> getInputFields() { return inputFields; }
    public List<ErrorStatus> getErrorStatuses() { return errorStatuses; }

    public record ErrorStatus(String name, String description) {}
}
