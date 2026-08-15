package org.lnu.timetable.framework.runtime;

import graphql.GraphQL;
import graphql.schema.GraphQLSchema;
import org.lnu.timetable.framework.config.GraphQLSchemaConfig;
import org.lnu.timetable.framework.schema.DynamicGraphQLSchemaBuilder;
import org.lnu.timetable.framework.schema.HandWrittenApi;
import org.lnu.timetable.security.AuthDataFetchers;
import org.lnu.timetable.security.AuthorizingDataFetcherProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.graphql.execution.GraphQlSource;

import java.util.List;

/**
 * Builds the GraphQL schema from all schema configuration classes at startup and
 * exposes it as a {@link GraphQlSource}, replacing the default .gqls-based source.
 * <p>
 * Per-level {@code DataLoader} dispatching (see {@link DynamicDataFetchers}) is automatic in
 * this version of graphql-java whenever a {@code DataLoaderRegistry} is present on the {@code
 * ExecutionInput} — Spring GraphQL populates one per request from the {@code BatchLoaderRegistry}
 * bean, so no extra instrumentation needs to be registered here.
 * <p>
 * Every generic, entity-metadata-driven query/mutation/relation is dispatched through {@link
 * AuthorizingDataFetcherProvider} rather than {@link DynamicDataFetchers} directly, so
 * authentication and entity-scoped "modify" permission checks (see
 * {@code org.lnu.timetable.security.PermissionService}) apply uniformly across the whole
 * generated schema with no per-entity wiring. Authentication itself is resolved per-request by
 * {@code org.lnu.timetable.security.AuthenticationGraphQlInterceptor}, a {@code
 * WebGraphQlInterceptor} bean that Spring GraphQL picks up automatically.
 * <p>
 * The parts of the API that cannot be generated — self-service registration and password recovery
 * today — arrive as {@link HandWrittenApi} beans and are collected here rather than named one by
 * one, so adding another needs no change to this class or to the schema builder. {@code
 * GlobalProperty} and the authentication surface predate that interface and are still passed
 * explicitly.
 */
@Configuration
public class DynamicGraphQlConfiguration {

    @Bean
    public GraphQlSource graphQlSource(DynamicGraphQLSchemaBuilder schemaBuilder,
                                       List<GraphQLSchemaConfig> configs,
                                       DynamicDataFetchers fetchers,
                                       AuthorizingDataFetcherProvider authorizingFetchers,
                                       AuthDataFetchers authDataFetchers,
                                       List<HandWrittenApi> handWrittenApis) {
        GraphQLSchema schema = schemaBuilder.buildSchema(configs, authorizingFetchers, fetchers, authDataFetchers,
            handWrittenApis);
        GraphQL graphQl = GraphQL.newGraphQL(schema).build();

        return new GraphQlSource() {
            @Override
            public GraphQL graphQl() {
                return graphQl;
            }

            @Override
            public GraphQLSchema schema() {
                return schema;
            }
        };
    }
}
