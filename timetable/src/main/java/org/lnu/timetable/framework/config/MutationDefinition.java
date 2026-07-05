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
    private final List<NestedListDefinition> nestedLists = new ArrayList<>();

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

    /**
     * Declares a nested one-to-many list on this mutation's input payload, so a single
     * create/update call can also create/update/delete the child rows in one round trip
     * instead of requiring separate mutations per child.
     * <p>
     * On CREATE, every item in the list is inserted with {@code fkField} set to the newly
     * created parent's id.
     * <p>
     * On UPDATE, each item's optional {@code id} determines the action: an item with an
     * {@code id} matching an existing child row updates it; an item with no (or unmatched)
     * {@code id} is inserted as a new child row; any existing child row not referenced by
     * an {@code id} in the incoming list is deleted. Omitting the field entirely leaves the
     * existing child rows untouched.
     *
     * @param fieldName        the list field's name on the input payload, e.g. "hours"
     * @param childEntityClass the child entity class, e.g. CurriculumItemHours.class
     * @param fkField          the child entity field that references the parent, e.g. "curriculumItemId"
     * @param childInputFields the child's own scalar/FK input fields, e.g. "hourType", "hours"
     */
    public MutationDefinition nestedList(String fieldName, Class<?> childEntityClass, String fkField, String... childInputFields) {
        nestedLists.add(new NestedListDefinition(fieldName, childEntityClass, fkField, List.of(childInputFields)));
        return this;
    }

    public String getName() { return name; }
    public Class<?> getEntityClass() { return entityClass; }
    public MutationType getMutationType() { return mutationType; }
    public List<String> getInputFields() { return inputFields; }
    public List<ErrorStatus> getErrorStatuses() { return errorStatuses; }
    public List<NestedListDefinition> getNestedLists() { return nestedLists; }

    public record ErrorStatus(String name, String description) {}

    public record NestedListDefinition(
        String fieldName,
        Class<?> childEntityClass,
        String fkField,
        List<String> childInputFields
    ) {}
}
