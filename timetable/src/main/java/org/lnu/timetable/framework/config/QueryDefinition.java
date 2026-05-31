package org.lnu.timetable.framework.config;

/**
 * Defines a GraphQL query. Supports single-entity lookup, connection (paginated list), and list queries.
 */
public class QueryDefinition {

    public enum QueryType { FIND_BY_ID, CONNECTION, LIST }

    private final String name;
    private Class<?> entityClass;
    private String returnTypeName;
    private QueryType queryType = QueryType.FIND_BY_ID;
    private int defaultLimit = 1000;
    private int defaultOffset = 0;
    private String orderBy = "id";

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

    public String getName() { return name; }
    public Class<?> getEntityClass() { return entityClass; }
    public String getReturnTypeName() { return returnTypeName; }
    public QueryType getQueryType() { return queryType; }
    public int getDefaultLimit() { return defaultLimit; }
    public int getDefaultOffset() { return defaultOffset; }
    public String getOrderBy() { return orderBy; }
}
