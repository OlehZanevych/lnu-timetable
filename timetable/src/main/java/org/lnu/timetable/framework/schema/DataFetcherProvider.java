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

    /**
     * Applies the same "must be signed in" rule to a hand-rolled fetcher that has no entity behind
     * it, so the one part of the schema outside the generic machinery — {@code GlobalProperty} —
     * isn't also outside the authorization it implies.
     */
    default DataFetcher<?> authenticated(DataFetcher<?> inner) {
        return inner;
    }

    /**
     * Guards a mutation on university-wide settings, which belong to no entity and therefore have
     * no scope to cascade from. {@code updateGlobalProperty} previously had no check at all: any
     * signed-in account — every student with a login — could change the semester dates and the
     * timetable-generation weights the solver runs on.
     */
    default DataFetcher<?> globalSettingMutation(DataFetcher<?> inner) {
        return inner;
    }
}
