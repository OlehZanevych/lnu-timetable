package org.lnu.timetable.security;

import org.springframework.graphql.server.WebGraphQlInterceptor;
import org.springframework.graphql.server.WebGraphQlRequest;
import org.springframework.graphql.server.WebGraphQlResponse;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/**
 * Resolves the caller's {@link Principal} from the {@code Authorization: Bearer <jwt>} header of
 * every incoming GraphQL-over-HTTP request and places it in the request's {@code GraphQLContext},
 * where any {@code DataFetcher} can retrieve it via
 * {@code env.getGraphQlContext().get(Principal.class)} (see {@link AuthorizingDataFetcherProvider}
 * and {@code AuthDataFetchers}). Missing, malformed, expired, or otherwise unresolvable tokens
 * simply leave the request anonymous (no {@code Principal} in context) rather than rejecting it
 * outright — this keeps unauthenticated operations like {@code login} reachable through the same
 * single {@code /graphql} endpoint, while every other operation enforces its own authentication
 * requirement at the data-fetcher level.
 */
@Component
public class AuthenticationGraphQlInterceptor implements WebGraphQlInterceptor {

    private final JwtService jwtService;
    private final PermissionRepository permissionRepository;

    public AuthenticationGraphQlInterceptor(JwtService jwtService, PermissionRepository permissionRepository) {
        this.jwtService = jwtService;
        this.permissionRepository = permissionRepository;
    }

    @Override
    public Mono<WebGraphQlResponse> intercept(WebGraphQlRequest request, Chain chain) {
        String header = request.getHeaders().getFirst("Authorization");
        String token = (header != null && header.startsWith("Bearer "))
            ? header.substring("Bearer ".length()).trim()
            : null;

        Mono<Principal> resolved = token == null
            ? Mono.empty()
            : Mono.justOrEmpty(jwtService.parseUserId(token)).flatMap(this::loadPrincipal);

        return resolved
            .doOnNext(principal -> request.configureExecutionInput((executionInput, builder) ->
                builder.graphQLContext(ctx -> ctx.put(Principal.class, principal)).build()))
            .then(chain.next(request));
    }

    private Mono<Principal> loadPrincipal(Long userId) {
        return permissionRepository.findUserById(userId)
            .filter(PermissionRepository.UserRow::active)
            .map(u -> new Principal(u.id(), u.email(), u.firstName(), u.lastName(), u.mustChangePassword()));
    }
}
