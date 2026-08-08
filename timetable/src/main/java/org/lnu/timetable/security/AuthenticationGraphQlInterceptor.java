package org.lnu.timetable.security;

import graphql.GraphQLError;
import graphql.GraphqlErrorBuilder;
import org.springframework.graphql.execution.ErrorType;
import org.springframework.graphql.server.WebGraphQlInterceptor;
import org.springframework.graphql.server.WebGraphQlRequest;
import org.springframework.graphql.server.WebGraphQlResponse;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Resolves the caller's {@link Principal} from the {@code Authorization: Bearer <jwt>} header of
 * every incoming GraphQL-over-HTTP request and places it in the request's {@code GraphQLContext},
 * where any {@code DataFetcher} can retrieve it via
 * {@code env.getGraphQlContext().get(Principal.class)} (see {@link AuthorizingDataFetcherProvider}
 * and {@code AuthDataFetchers}).
 *
 * <h2>Anonymous is not the same as expired</h2>
 * A request with <em>no</em> {@code Authorization} header is anonymous and stays that way: that is
 * what keeps {@code login} reachable through the same single {@code /graphql} endpoint, and it is
 * not an error — nobody claimed to be signed in.
 * <p>
 * A request that <em>does</em> carry a token which cannot be honoured is a different thing, and it
 * used to be indistinguishable from the first: the token was dropped in silence, the request ran
 * anonymously, and {@code Query.me} answered {@code null}. A client holding a token it believed was
 * good therefore had nothing to react to — no error, no status — and would sit on a screen it was
 * no longer entitled to until something else happened to fail. That is the bug this class now
 * closes. Whenever a presented token resolves to no {@link Principal}, the response carries the
 * reason twice, so a client can act on whichever it reads first:
 * <ul>
 *   <li>a GraphQL error entry with {@code extensions.code = "UNAUTHENTICATED"} and
 *       {@code extensions.authError} naming the {@link AuthFailure}; and</li>
 *   <li>the {@code X-Auth-Error} response header carrying that same {@link AuthFailure}.</li>
 * </ul>
 * The error entry is added <em>alongside</em> whatever the query itself produced rather than
 * replacing it — the request still executes, anonymously, exactly as before. Only the extra entry
 * is new, and it is what the Angular client's {@code authInterceptor} watches for to clear
 * {@code lnu_timetable_token} and route to {@code /login}.
 * <p>
 * The corollary for any client: do not send a token you already know is expired. The Angular client
 * checks the {@code exp} claim locally before attaching the header and clears its stored token
 * before posting {@code login}, so an unauthenticated operation never picks up this error entry.
 */
@Component
public class AuthenticationGraphQlInterceptor implements WebGraphQlInterceptor {

    /** Response header naming the {@link AuthFailure}; also listed in {@code CorsFilter}'s exposed headers. */
    public static final String AUTH_ERROR_HEADER = "X-Auth-Error";

    private final JwtService jwtService;
    private final PermissionRepository permissionRepository;

    public AuthenticationGraphQlInterceptor(JwtService jwtService, PermissionRepository permissionRepository) {
        this.jwtService = jwtService;
        this.permissionRepository = permissionRepository;
    }

    @Override
    public Mono<WebGraphQlResponse> intercept(WebGraphQlRequest request, Chain chain) {
        String token = bearerToken(request);

        // No credentials offered at all: anonymous, and nothing to report.
        if (token == null) {
            return chain.next(request);
        }

        JwtService.TokenResult parsed = jwtService.parse(token);
        if (!parsed.isValid()) {
            return chain.next(request).map(response -> report(response, parsed.failure()));
        }

        // The token is good; the account behind it may still have been deleted or deactivated
        // since it was issued, which is just as much a reason to send the client back to /login.
        return loadPrincipal(parsed.userId())
            .doOnNext(principal -> request.configureExecutionInput((executionInput, builder) ->
                builder.graphQLContext(ctx -> ctx.put(Principal.class, principal)).build()))
            .hasElement()
            .flatMap(resolved -> resolved
                ? chain.next(request)
                : chain.next(request).map(response -> report(response, AuthFailure.ACCOUNT_DISABLED)));
    }

    private static String bearerToken(WebGraphQlRequest request) {
        String header = request.getHeaders().getFirst("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            return null;
        }
        String token = header.substring("Bearer ".length()).trim();
        return token.isEmpty() ? null : token;
    }

    private Mono<Principal> loadPrincipal(Long userId) {
        return permissionRepository.findUserById(userId)
            .filter(PermissionRepository.UserRow::active)
            .map(u -> new Principal(u.id(), u.email(), u.firstName(), u.lastName(), u.mustChangePassword(),
                u.lecturerId(), u.studentId()));
    }

    /** Adds the failure to the response body and to its headers, leaving the executed result intact. */
    private static WebGraphQlResponse report(WebGraphQlResponse response, AuthFailure failure) {
        response.getResponseHeaders().set(AUTH_ERROR_HEADER, failure.name());

        List<GraphQLError> errors = new ArrayList<>(response.getExecutionResult().getErrors());
        errors.add(authError(failure));
        return response.transform(builder -> builder.errors(errors));
    }

    private static GraphQLError authError(AuthFailure failure) {
        Map<String, Object> extensions = new LinkedHashMap<>();
        extensions.put("code", "UNAUTHENTICATED");
        extensions.put("authError", failure.name());
        return GraphqlErrorBuilder.newError()
            .message(failure.message())
            .errorType(ErrorType.UNAUTHORIZED)
            .extensions(extensions)
            .build();
    }
}
