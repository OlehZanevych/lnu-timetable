package org.lnu.timetable.framework.metadata;

import com.google.common.base.CaseFormat;
import org.lnu.timetable.framework.annotation.*;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.stereotype.Component;

import java.lang.reflect.Field;
import java.lang.reflect.ParameterizedType;
import java.util.*;

/**
 * Scans for @GraphQLEntity annotated classes at startup and builds metadata registry.
 */
@Component
public class EntityMetadataRegistry {

    private final Map<Class<?>, EntityMetadata> registry = new LinkedHashMap<>();
    private final Map<String, Class<?>> byResourceType = new LinkedHashMap<>();

    public EntityMetadataRegistry() {
        scanEntities("org.lnu.timetable");
    }

    public EntityMetadata getMetadata(Class<?> entityClass) {
        return registry.get(entityClass);
    }

    public Collection<EntityMetadata> getAllMetadata() {
        return registry.values();
    }

    /**
     * Resolves a {@code permissions.resource_type} value (e.g. {@code "FACULTY"}) back to its
     * entity class, for the authorization framework (see
     * {@code org.lnu.timetable.security.PermissionService}). Returns {@code null} if unknown.
     */
    public Class<?> getEntityClassByResourceType(String resourceType) {
        return byResourceType.get(resourceType);
    }

    private void scanEntities(String basePackage) {
        var scanner = new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(GraphQLEntity.class));

        Set<BeanDefinition> candidates = scanner.findCandidateComponents(basePackage);
        for (BeanDefinition bd : candidates) {
            try {
                Class<?> entityClass = Class.forName(bd.getBeanClassName());
                EntityMetadata metadata = buildMetadata(entityClass);
                registry.put(entityClass, metadata);
                byResourceType.put(metadata.resourceType(), entityClass);
            } catch (ClassNotFoundException e) {
                throw new RuntimeException("Failed to load entity class: " + bd.getBeanClassName(), e);
            }
        }
    }

    private EntityMetadata buildMetadata(Class<?> entityClass) {
        GraphQLEntity annotation = entityClass.getAnnotation(GraphQLEntity.class);
        String tableName = annotation.table().isEmpty()
            ? CaseFormat.UPPER_CAMEL.to(CaseFormat.LOWER_UNDERSCORE, entityClass.getSimpleName()) + "s"
            : annotation.table();
        String keyColumn = annotation.key();

        Map<String, EntityFieldMetadata> fields = new LinkedHashMap<>();
        List<String> selectableColumns = new ArrayList<>();
        Map<String, RelationMetadata> relations = new LinkedHashMap<>();

        for (Field field : entityClass.getDeclaredFields()) {
            if (java.lang.reflect.Modifier.isStatic(field.getModifiers())) continue;

            if (field.isAnnotationPresent(OneToMany.class)) {
                OneToMany rel = field.getAnnotation(OneToMany.class);
                Class<?> target = getCollectionGenericType(field);
                relations.put(field.getName(), new RelationMetadata(
                    field.getName(), RelationType.ONE_TO_MANY, target,
                    null, rel.mappedBy(), null, null
                ));
            } else if (field.isAnnotationPresent(ManyToOne.class)) {
                ManyToOne rel = field.getAnnotation(ManyToOne.class);
                String joinCol = rel.joinColumn().isEmpty()
                    ? CaseFormat.LOWER_CAMEL.to(CaseFormat.LOWER_UNDERSCORE, field.getName()) + "_id"
                    : rel.joinColumn();
                relations.put(field.getName(), new RelationMetadata(
                    field.getName(), RelationType.MANY_TO_ONE, field.getType(),
                    joinCol, null, null, null
                ));
            } else if (field.isAnnotationPresent(OneToOne.class)) {
                OneToOne rel = field.getAnnotation(OneToOne.class);
                // Naming a mappedBy column *is* what puts the foreign key on the other table, so a
                // field that has one is the inverse side whatever owning() says (which defaults to
                // true, for the far commoner owning case). A null joinColumn is how the rest of the
                // framework recognises that side.
                boolean owning = rel.owning() && rel.mappedBy().isEmpty();
                String joinCol = owning
                    ? (rel.joinColumn().isEmpty()
                        ? CaseFormat.LOWER_CAMEL.to(CaseFormat.LOWER_UNDERSCORE, field.getName()) + "_id"
                        : rel.joinColumn())
                    : null;
                relations.put(field.getName(), new RelationMetadata(
                    field.getName(), RelationType.ONE_TO_ONE, field.getType(),
                    joinCol, rel.mappedBy(), null, null
                ));
            } else if (field.isAnnotationPresent(ManyToMany.class)) {
                ManyToMany rel = field.getAnnotation(ManyToMany.class);
                Class<?> target = getCollectionGenericType(field);
                relations.put(field.getName(), new RelationMetadata(
                    field.getName(), RelationType.MANY_TO_MANY, target,
                    rel.joinColumn(), null, rel.joinTable(), rel.inverseJoinColumn()
                ));
            } else {
                // Regular field
                String columnName = CaseFormat.LOWER_CAMEL.to(CaseFormat.LOWER_UNDERSCORE, field.getName());
                String description = field.isAnnotationPresent(Description.class)
                    ? field.getAnnotation(Description.class).value() : null;
                boolean nullable = field.isAnnotationPresent(org.lnu.timetable.framework.annotation.Nullable.class);
                String pgEnumType = field.isAnnotationPresent(PgEnum.class)
                    ? field.getAnnotation(PgEnum.class).value() : null;

                fields.put(field.getName(), new EntityFieldMetadata(
                    field.getName(), columnName, field.getType(), nullable, description, pgEnumType
                ));

                // The key is exposed as the GraphQL `id` field and nothing else, so it must not also
                // become an ordinary selectable scalar. Matched on the column rather than on the
                // field name: for an entity keyed by its parent the field is called e.g.
                // `lecturerWorkloadId`, and only its column says that it is the key.
                if (!keyColumn.equals(columnName)) {
                    selectableColumns.add(field.getName());
                }
            }
        }

        String resourceType = CaseFormat.UPPER_CAMEL.to(CaseFormat.UPPER_UNDERSCORE, entityClass.getSimpleName());

        List<PermissionParentEdge> permissionParents = new ArrayList<>();
        for (PermissionParent pp : entityClass.getAnnotationsByType(PermissionParent.class)) {
            permissionParents.add(new PermissionParentEdge(pp.value(), pp.joinColumn(), pp.nullable()));
        }
        List<PermissionJoinParentEdge> permissionJoinParents = new ArrayList<>();
        for (PermissionJoinParent pjp : entityClass.getAnnotationsByType(PermissionJoinParent.class)) {
            permissionJoinParents.add(new PermissionJoinParentEdge(
                pjp.value(), pjp.joinTable(), pjp.selfColumn(), pjp.parentColumn()));
        }

        return new EntityMetadata(entityClass, tableName, keyColumn, fields, selectableColumns, relations,
            resourceType, permissionParents, permissionJoinParents);
    }

    private Class<?> getCollectionGenericType(Field field) {
        if (field.getGenericType() instanceof ParameterizedType pt) {
            return (Class<?>) pt.getActualTypeArguments()[0];
        }
        throw new IllegalStateException("Cannot determine generic type for field: " + field.getName());
    }
}
