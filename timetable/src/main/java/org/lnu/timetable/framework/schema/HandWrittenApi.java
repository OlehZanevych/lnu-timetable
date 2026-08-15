package org.lnu.timetable.framework.schema;

import graphql.schema.GraphQLCodeRegistry;
import graphql.schema.GraphQLObjectType;

/**
 * A slice of the API that is written by hand rather than generated from entity metadata.
 *
 * <p>Most of this schema is reflective: an annotated POJO in {@code domain/} plus a few declarative
 * lines in a {@code *SchemaConfig} produce a type, a connection, three mutations and the SQL behind
 * them, with no code in between. A few things cannot be, and never could:
 * {@code GlobalProperty}, because it is a name/value store rather than an entity; the
 * authentication and permission surface, because a password hash must never be reachable through
 * fully-generic, selection-set-driven machinery and {@code login} does not fit the id-keyed CRUD
 * shape anyway; and now self-service registration and password recovery, for both of those reasons
 * at once.
 *
 * <p>Each of those used to be wired into {@link DynamicGraphQLSchemaBuilder} by hand: a parameter on
 * {@code buildSchema}, a {@code buildXxxTypes()}, an {@code addXxxQueryFields()}, an
 * {@code addXxxMutationFields()} and a {@code registerXxxFetchers()}, all named after the area and
 * all called from the middle of a method that otherwise knows nothing about it. That is a workable
 * shape for one exception and a poor one for the fourth: the builder grows a parameter it cannot
 * type-check anything about, and the areas can only be added by editing the framework.
 *
 * <p>This interface is that wiring, stated once. An implementation is an ordinary Spring bean —
 * {@code DynamicGraphQlConfiguration} collects every one of them and the builder applies each at the
 * point its own hardcoded areas are applied, so a new hand-written area is a new bean and nothing
 * else. Every method is defaulted, because an area that only adds queries should not have to say so
 * four times.
 *
 * <p>Two things it deliberately does not do. It does not route anything through
 * {@code AuthorizingDataFetcherProvider}: a hand-written area states its own rule, which for
 * {@code login} and for {@code requestRegistration} is "none", and inheriting the generic
 * "must be signed in" would make both unreachable. And it does not offer a way to read what other
 * areas declared, so two of them cannot come to depend on the order they are visited in.
 */
public interface HandWrittenApi {

    /**
     * Adds this area's object, enum and input types. Called while the schema's types are being
     * collected, before the {@code Query} and {@code Mutation} roots are assembled, so fields added
     * below may refer to them by {@code GraphQLTypeReference}.
     */
    default void buildTypes(SchemaTypeRegistry types) {
    }

    /** Adds this area's root {@code Query} fields. */
    default void addQueryFields(GraphQLObjectType.Builder queryBuilder) {
    }

    /** Adds this area's root {@code Mutation} fields. */
    default void addMutationFields(GraphQLObjectType.Builder mutationBuilder) {
    }

    /** Binds a data fetcher to each field this area declared above. */
    default void registerFetchers(GraphQLCodeRegistry.Builder codeRegistry) {
    }
}
