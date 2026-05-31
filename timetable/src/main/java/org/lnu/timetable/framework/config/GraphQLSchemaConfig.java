package org.lnu.timetable.framework.config;

import java.util.List;

/**
 * Interface that configuration classes implement to define GraphQL schema.
 */
public interface GraphQLSchemaConfig {
    void configure(SchemaDefinition schema);
}
