package org.lnu.timetable.security;

/**
 * Why a request that <em>did</em> present an {@code Authorization: Bearer …} header still ended up
 * anonymous. This is the distinction the service could not previously make: a request with no
 * header at all and a request carrying a twelve-hour-old token both produced the same silent
 * "no {@link Principal} in context", so {@code Query.me} answered {@code null} in both cases and a
 * client had no way to tell "nobody is signed in here" from "your session has just ended".
 * <p>
 * {@link AuthenticationGraphQlInterceptor} reports the value as {@code extensions.authError} on a
 * GraphQL error entry and as the {@code X-Auth-Error} response header; the frontend reacts to
 * either by clearing its stored token and returning to the login page.
 */
public enum AuthFailure {

    /** The token is well-formed and correctly signed, but its {@code exp} claim has passed. */
    TOKEN_EXPIRED("Термін дії сеансу минув. Увійдіть повторно."),

    /** Malformed, truncated, or signed with a key this service does not accept. */
    INVALID_TOKEN("Недійсний токен автентифікації. Увійдіть повторно."),

    /** The token is valid, but the account it names no longer exists or has been deactivated. */
    ACCOUNT_DISABLED("Обліковий запис недоступний. Увійдіть повторно.");

    private final String message;

    AuthFailure(String message) {
        this.message = message;
    }

    /** The human-readable text carried on the GraphQL error entry. */
    public String message() {
        return message;
    }
}
