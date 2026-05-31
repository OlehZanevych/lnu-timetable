package org.lnu.timetable.framework.config;

import java.util.ArrayList;
import java.util.List;

/**
 * Root schema definition builder. Users add type, query, and mutation definitions here.
 */
public class SchemaDefinition {

    private final List<TypeDefinition> types = new ArrayList<>();
    private final List<QueryDefinition> queries = new ArrayList<>();
    private final List<MutationDefinition> mutations = new ArrayList<>();

    public TypeDefinition type(Class<?> entityClass) {
        TypeDefinition def = new TypeDefinition(entityClass);
        types.add(def);
        return def;
    }

    public QueryDefinition query(String name) {
        QueryDefinition def = new QueryDefinition(name);
        queries.add(def);
        return def;
    }

    public MutationDefinition mutation(String name) {
        MutationDefinition def = new MutationDefinition(name);
        mutations.add(def);
        return def;
    }

    public List<TypeDefinition> getTypes() { return types; }
    public List<QueryDefinition> getQueries() { return queries; }
    public List<MutationDefinition> getMutations() { return mutations; }
}
