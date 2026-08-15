package org.lnu.timetable.framework.schema;

import graphql.schema.GraphQLEnumType;
import graphql.schema.GraphQLInputObjectType;
import graphql.schema.GraphQLObjectType;

/**
 * The three type collections {@link DynamicGraphQLSchemaBuilder} assembles a schema from, offered to
 * a {@link HandWrittenApi} as the only thing it may write to.
 * <p>
 * A hand-written area needs exactly one capability from the builder — "here is a type, carry it into
 * the schema" — and giving it that capability by handing over the builder itself would let it also
 * read what everything else declared and quietly depend on the order the areas happen to be visited
 * in. This interface is that one capability and nothing else.
 */
public interface SchemaTypeRegistry {

    /** Registers an object type under its own name. */
    void object(GraphQLObjectType type);

    /** Registers an enum type under its own name. */
    void enumeration(GraphQLEnumType type);

    /** Registers an input object type under its own name. */
    void input(GraphQLInputObjectType type);
}
