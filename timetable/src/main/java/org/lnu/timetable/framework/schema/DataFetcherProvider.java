package org.lnu.timetable.framework.schema;

import graphql.schema.DataFetcher;
import org.lnu.timetable.framework.config.MutationDefinition;
import org.lnu.timetable.framework.config.QueryDefinition;
import org.lnu.timetable.framework.metadata.RelationMetadata;

/**
 * Supplies optimized data fetchers for each configured query, mutation and relation.
 */
public interface DataFetcherProvider {
    DataFetcher<?> namespace();
    DataFetcher<?> query(QueryDefinition def);
    DataFetcher<?> connection(QueryDefinition def);
    DataFetcher<?> mutation(MutationDefinition def);

    /**
     * @param ownerTypeName the GraphQL type the relation field is declared on, e.g. "CurriculumItem";
     *                      combined with {@code rel}'s field name this uniquely identifies the batch
     *                      loader used to avoid N+1 queries for this relation.
     */
    DataFetcher<?> relation(String ownerTypeName, RelationMetadata rel);
}
