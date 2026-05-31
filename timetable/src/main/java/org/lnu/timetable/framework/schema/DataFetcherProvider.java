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
    DataFetcher<?> relation(RelationMetadata rel);
}
