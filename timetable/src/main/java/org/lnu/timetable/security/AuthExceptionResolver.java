package org.lnu.timetable.security;

import graphql.GraphQLError;
import graphql.GraphqlErrorBuilder;
import graphql.schema.DataFetchingEnvironment;
import org.springframework.graphql.execution.DataFetcherExceptionResolverAdapter;
import org.springframework.graphql.execution.ErrorType;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Turns a {@link GraphQlAuthException} into a GraphQL error the client can act on rather than one
 * it can only display. Without a resolver, Spring for GraphQL treats an exception escaping a data
 * fetcher as an internal failure: the message is replaced with {@code "INTERNAL_ERROR for <id>"}
 * and the real one is only written to the log, so "You must be signed in to do this." never reached
 * the browser at all and certainly could not be told apart from a genuine server fault.
 * <p>
 * The classification is read off the request rather than declared at each throw site, which keeps
 * every existing {@code throw new GraphQlAuthException(…)} untouched and cannot drift out of step
 * with them: if there is no {@link Principal} on the context then nobody is signed in, so any
 * authorization failure is by definition an <em>authentication</em> one
 * ({@code UNAUTHENTICATED} / {@link ErrorType#UNAUTHORIZED}) and the client should return to the
 * login page; if there is one, the caller is signed in and simply not allowed to do this
 * ({@code FORBIDDEN}), which is a message to read, not a session to end.
 *
 * @see AuthenticationGraphQlInterceptor for the same {@code UNAUTHENTICATED} code raised one level
 *      earlier, when the token itself is the thing that failed
 */
@Component
public class AuthExceptionResolver extends DataFetcherExceptionResolverAdapter {

    @Override
    protected GraphQLError resolveToSingleError(Throwable ex, DataFetchingEnvironment env) {
        if (!(ex instanceof GraphQlAuthException)) {
            return null;
        }

        boolean signedIn = AuthorizingDataFetcherProvider.principalOf(env) != null;

        Map<String, Object> extensions = new LinkedHashMap<>();
        extensions.put("code", signedIn ? "FORBIDDEN" : "UNAUTHENTICATED");

        return GraphqlErrorBuilder.newError(env)
            .message(ex.getMessage())
            .errorType(signedIn ? ErrorType.FORBIDDEN : ErrorType.UNAUTHORIZED)
            .extensions(extensions)
            .build();
    }
}
