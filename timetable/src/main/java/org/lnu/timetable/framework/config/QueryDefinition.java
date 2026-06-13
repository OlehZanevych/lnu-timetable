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

    private final String name;
    private Class<?> entityClass;
    private String returnTypeName;
    private QueryType queryType = QueryType.FIND_BY_ID;
    private int defaultLimit = 1000;
    private int defaultOffset = 0;
    private String orderBy = "id";
    private final List<FilterParam> filters = new ArrayList<>();

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

    public String getName() { return name; }
    public Class<?> getEntityClass() { return entityClass; }
    public String getReturnTypeName() { return returnTypeName; }
    public QueryType getQueryType() { return queryType; }
    public int getDefaultLimit() { return defaultLimit; }
    public int getDefaultOffset() { return defaultOffset; }
    public String getOrderBy() { return orderBy; }
    public List<FilterParam> getFilters() { return Collections.unmodifiableList(filters); }
}
