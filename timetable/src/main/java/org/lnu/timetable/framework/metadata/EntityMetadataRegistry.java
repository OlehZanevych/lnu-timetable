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

    public EntityMetadataRegistry() {
        scanEntities("org.lnu.timetable");
    }

    public EntityMetadata getMetadata(Class<?> entityClass) {
        return registry.get(entityClass);
    }

    public Collection<EntityMetadata> getAllMetadata() {
        return registry.values();
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
                String joinCol = rel.owning()
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

                fields.put(field.getName(), new EntityFieldMetadata(
                    field.getName(), columnName, field.getType(), nullable, description
                ));

                if (!"id".equals(field.getName())) {
                    selectableColumns.add(field.getName());
                }
            }
        }

        return new EntityMetadata(entityClass, tableName, fields, selectableColumns, relations);
    }

    private Class<?> getCollectionGenericType(Field field) {
        if (field.getGenericType() instanceof ParameterizedType pt) {
            return (Class<?>) pt.getActualTypeArguments()[0];
        }
        throw new IllegalStateException("Cannot determine generic type for field: " + field.getName());
    }
}
