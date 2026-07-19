package org.lnu.timetable.security;

import com.google.common.base.CaseFormat;
import graphql.schema.DataFetcher;
import graphql.schema.DataFetchingEnvironment;
import org.lnu.timetable.framework.config.MutationDefinition;
import org.lnu.timetable.framework.config.QueryDefinition;
import org.lnu.timetable.framework.metadata.RelationMetadata;
import org.lnu.timetable.framework.runtime.DynamicDataFetchers;
import org.lnu.timetable.framework.schema.DataFetcherProvider;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Wraps {@link DynamicDataFetchers} to enforce the two authorization rules that apply to every
 * generic, entity-metadata-driven query/mutation in the schema (hand-rolled operations such as
 * {@code login} or {@code me} bypass this entirely — see {@code AuthDataFetchers} and how it's
 * wired directly in {@code DynamicGraphQlConfiguration} instead of through
 * {@link org.lnu.timetable.framework.schema.DataFetcherProvider}):
 * <ol>
 *   <li>Every operation requires an authenticated caller (a {@link Principal} resolved by
 *       {@link AuthenticationGraphQlInterceptor} onto the GraphQL context) — reads are open to any
 *       logged-in user, but anonymous callers get nothing.</li>
 *   <li>{@code create}/{@code update}/{@code delete} mutations additionally require "modify"
 *       permission on the target resource (or the parent it's being attached to, for creates) —
 *       see {@link PermissionService}.</li>
 * </ol>
 * This is registered as the {@link DataFetcherProvider} implementation actually wired into
 * {@link org.lnu.timetable.framework.schema.DynamicGraphQLSchemaBuilder} (via
 * {@code DynamicGraphQlConfiguration}), so the schema builder itself needs no authorization
 * awareness at all.
 */
@Component
public class AuthorizingDataFetcherProvider implements DataFetcherProvider {

    private final DynamicDataFetchers delegate;
    private final PermissionService permissionService;

    public AuthorizingDataFetcherProvider(DynamicDataFetchers delegate, PermissionService permissionService) {
        this.delegate = delegate;
        this.permissionService = permissionService;
    }

    @Override
    public DataFetcher<?> namespace() {
        return requireAuthenticated(delegate.namespace());
    }

    @Override
    public DataFetcher<?> query(QueryDefinition def) {
        return requireAuthenticated(delegate.query(def));
    }

    @Override
    public DataFetcher<?> connection(QueryDefinition def) {
        return requireAuthenticated(delegate.connection(def));
    }

    @Override
    public DataFetcher<?> relation(String ownerTypeName, RelationMetadata rel) {
        return requireAuthenticated(delegate.relation(ownerTypeName, rel));
    }

    @Override
    public DataFetcher<?> mutation(MutationDefinition def) {
        DataFetcher<?> inner = delegate.mutation(def);
        String argName = CaseFormat.UPPER_CAMEL.to(CaseFormat.LOWER_CAMEL, def.getEntityClass().getSimpleName());

        return env -> {
            Principal principal = principalOf(env);
            if (principal == null) {
                return failed("You must be signed in to do this.");
            }
            Mono<Boolean> authorized = switch (def.getMutationType()) {
                case CREATE -> {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> input = (Map<String, Object>) env.getArgument(argName);
                    yield permissionService.canCreate(principal.userId(), def.getEntityClass(),
                        input == null ? Map.of() : input);
                }
                case UPDATE, DELETE -> {
                    Long id = coerceId(env.getArgument("id"));
                    yield permissionService.canModify(principal.userId(), def.getEntityClass(), id);
                }
            };

            return authorized.toFuture().thenCompose(ok -> {
                if (!ok) {
                    return failed("You don't have permission to modify this "
                        + def.getEntityClass().getSimpleName() + ".");
                }
                try {
                    Object result = inner.get(env);
                    if (result instanceof CompletableFuture<?> future) {
                        @SuppressWarnings("unchecked")
                        CompletableFuture<Object> asObjectFuture = (CompletableFuture<Object>) future;
                        return asObjectFuture;
                    }
                    return CompletableFuture.completedFuture(result);
                } catch (Exception e) {
                    return CompletableFuture.<Object>failedFuture(e);
                }
            });
        };
    }

    // --- helpers ---

    private DataFetcher<?> requireAuthenticated(DataFetcher<?> inner) {
        return env -> {
            if (principalOf(env) == null) {
                return failed("You must be signed in to do this.");
            }
            return inner.get(env);
        };
    }

    static Principal principalOf(DataFetchingEnvironment env) {
        return env.getGraphQlContext().get(Principal.class);
    }

    private static CompletableFuture<Object> failed(String message) {
        return CompletableFuture.failedFuture(new GraphQlAuthException(message));
    }

    private Long coerceId(Object raw) {
        if (raw == null) return null;
        return raw instanceof Number n ? n.longValue() : Long.parseLong(raw.toString());
    }
}
