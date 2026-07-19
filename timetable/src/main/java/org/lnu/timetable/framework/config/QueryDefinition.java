package org.lnu.timetable.framework.config;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Defines a GraphQL query. Supports single-entity lookup, connection (paginated list), and list queries.
 */
public class QueryDefinition {

    public enum QueryType { FIND_BY_ID, CONNECTION, LIST }

    /** A named, nullable filter argument exposed on the connection field, mapped to a DB column. */
    public record FilterParam(String paramName, String column) {}

    /** The GraphQL argument shape (and Java-side value coercion) for a {@link RelationFilter}. */
    public enum FilterArgType { ID, ID_LIST, STRING }

    /**
     * A named, nullable filter argument that can't be expressed as a direct column on the entity's
     * own table (e.g. filtering combined_working_curriculum_items by the department or faculty of
     * their member working_curriculum_items, or by the semester parity of their curriculum item).
     * {@code condition} is a raw SQL boolean expression — typically an {@code EXISTS (...)} subquery
     * — referencing the entity's own table by its real name (queries select from it unaliased) and
     * containing a named bind placeholder matching {@code paramName} (e.g. {@code :facultyId}).
     * {@code argType} controls both the exposed GraphQL argument type and how the incoming value is
     * bound: {@code ID} → a single value coerced to {@code Long}; {@code ID_LIST} → {@code [ID!]}
     * bound as a {@code Long[]} (for use with {@code = ANY(:paramName)}); {@code STRING} → bound
     * as-is (e.g. an enum-like value such as {@code 'ODD'}/{@code 'EVEN'}).
     */
    public record RelationFilter(String paramName, String condition, FilterArgType argType) {}

    private final String name;
    private Class<?> entityClass;
    private String returnTypeName;
    private QueryType queryType = QueryType.FIND_BY_ID;
    private int defaultLimit = 1000;
    private int defaultOffset = 0;
    private String orderBy = "id";
    private final List<FilterParam> filters = new ArrayList<>();
    private final List<RelationFilter> relationFilters = new ArrayList<>();

    public QueryDefinition(String name) {
        this.name = name;
    }

    public QueryDefinition entity(Class<?> entityClass) {
        this.entityClass = entityClass;
        return this;
    }

    public QueryDefinition returnType(String typeName) {
        this.returnTypeName = typeName;
        return this;
    }

    public QueryDefinition findById() {
        this.queryType = QueryType.FIND_BY_ID;
        return this;
    }

    public QueryDefinition connection() {
        this.queryType = QueryType.CONNECTION;
        return this;
    }

    public QueryDefinition connection(int defaultLimit) {
        this.queryType = QueryType.CONNECTION;
        this.defaultLimit = defaultLimit;
        return this;
    }

    public QueryDefinition list() {
        this.queryType = QueryType.LIST;
        return this;
    }

    public QueryDefinition orderBy(String field) {
        this.orderBy = field;
        return this;
    }

    /** Declares a nullable filter argument on the connection field, mapped to a DB column. */
    public QueryDefinition filter(String paramName, String column) {
        this.filters.add(new FilterParam(paramName, column));
        return this;
    }

    /**
     * Declares a nullable, single-value relation filter argument exposed as GraphQL {@code ID}.
     * {@code condition} is a raw SQL boolean expression (see {@link RelationFilter}) containing a
     * {@code :paramName} placeholder bound to the coerced argument value.
     */
    public QueryDefinition relationFilter(String paramName, String condition) {
        this.relationFilters.add(new RelationFilter(paramName, condition, FilterArgType.ID));
        return this;
    }

    /**
     * Declares a nullable, list-value relation filter argument exposed as GraphQL {@code [ID!]},
     * bound as a Postgres array so {@code condition} can use {@code = ANY(:paramName)}. See {@link
     * RelationFilter}.
     */
    public QueryDefinition relationFilterList(String paramName, String condition) {
        this.relationFilters.add(new RelationFilter(paramName, condition, FilterArgType.ID_LIST));
        return this;
    }

    /**
     * Declares a nullable, plain-string relation filter argument exposed as GraphQL {@code String}
     * (e.g. an enum-like value such as semester parity), bound to {@code condition} as-is with no
     * numeric coercion. See {@link RelationFilter}.
     */
    public QueryDefinition relationFilterString(String paramName, String condition) {
        this.relationFilters.add(new RelationFilter(paramName, condition, FilterArgType.STRING));
        return this;
    }

    public String getName() { return name; }
    public Class<?> getEntityClass() { return entityClass; }
    public String getReturnTypeName() { return returnTypeName; }
    public QueryType getQueryType() { return queryType; }
    public int getDefaultLimit() { return defaultLimit; }
    public int getDefaultOffset() { return defaultOffset; }
    public String getOrderBy() { return orderBy; }
    public List<FilterParam> getFilters() { return Collections.unmodifiableList(filters); }
    public List<RelationFilter> getRelationFilters() { return Collections.unmodifiableList(relationFilters); }
}
