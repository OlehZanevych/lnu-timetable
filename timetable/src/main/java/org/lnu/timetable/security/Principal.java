package org.lnu.timetable.security;

/**
 * The authenticated caller, resolved once per request (by {@link AuthenticationGraphQlInterceptor})
 * from the {@code Authorization: Bearer <jwt>} header and placed into the GraphQL context. Only
 * the id travels in the JWT itself (see {@link JwtService}); everything else is re-checked fresh
 * per request so that revoking a user or their permissions takes effect immediately rather than
 * waiting for token expiry.
 */
public record Principal(Long userId, String email, String firstName, String lastName, boolean mustChangePassword) {
}
