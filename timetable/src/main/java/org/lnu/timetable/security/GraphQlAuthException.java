package org.lnu.timetable.security;

/**
 * Thrown from within a {@code DataFetcher} to signal that the caller is either not authenticated
 * at all, or authenticated but lacking the permission the requested operation needs. graphql-java
 * turns this into a GraphQL error entry (message only, no stack trace exposed) rather than a
 * hard HTTP failure, matching how the rest of this API reports problems as part of the response.
 */
public class GraphQlAuthException extends RuntimeException {
    public GraphQlAuthException(String message) {
        super(message);
    }
}
