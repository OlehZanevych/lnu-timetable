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
 * Wraps {@link DynamicDataFetchers} to enforce the authorization rules that apply to every generic,
 * entity-metadata-driven query/mutation in the schema (hand-rolled operations such as
 * {@code login} or {@code me} bypass this entirely — see {@code AuthDataFetchers} and how it's
 * wired directly in {@code DynamicGraphQlConfiguration} instead of through
 * {@link org.lnu.timetable.framework.schema.DataFetcherProvider}):
 * <ol>
 *   <li>Every operation requires an authenticated caller (a {@link Principal} resolved by
 *       {@link AuthenticationGraphQlInterceptor} onto the GraphQL context) — reads are open to any
 *       logged-in user, but anonymous callers get nothing.</li>
 *   <li>Mutations require an {@link AccessLevel} on the target resource (or, for creates, on the
 *       parent the new row is being attached to): {@code create} and {@code update} need
 *       {@link AccessLevel#EDIT}, {@code delete} needs {@link AccessLevel#FULL}.</li>
 * </ol>
 * The split between update and delete is the point of the level system, and it lives here, in one
 * {@code switch}, rather than being spread across the entities: deletion cascades in this schema —
 * removing a DegreeProgram removes its academic groups, curriculum items and workloads — so it is a
 * different act from editing a field, and a методист who maintains плани all day should not be one
 * mis-click away from it.
 * <p>
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
    public DataFetcher<?> authenticated(DataFetcher<?> inner) {
        return requireAuthenticated(inner);
    }

    /**
     * University-wide settings have no owning entity, so there is no scope for a grant to cascade
     * from: changing them requires a {@code GLOBAL} grant at {@link AccessLevel#EDIT} or above.
     * Reading them stays open to any signed-in user — the whole application reads the semester dates
     * and the solver weights on every page.
     */
    @Override
    public DataFetcher<?> globalSettingMutation(DataFetcher<?> inner) {
        return env -> {
            Principal principal = principalOf(env);
            if (principal == null) {
                return failed("You must be signed in to do this.");
            }
            return evaluatorOf(env, principal).globalLevel()
                .map(level -> level.allows(AccessLevel.EDIT))
                .defaultIfEmpty(false)
                .toFuture()
                .thenCompose(ok -> {
                    if (!ok) {
                        return failed("Changing university-wide settings requires GLOBAL access.");
                    }
                    return invoke(inner, env);
                });
        };
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
            PermissionEvaluator evaluator = evaluatorOf(env, principal);
            AccessLevel required = switch (def.getMutationType()) {
                case CREATE, UPDATE -> AccessLevel.EDIT;
                case DELETE -> AccessLevel.FULL;
            };
            Mono<Boolean> authorized = switch (def.getMutationType()) {
                case CREATE -> {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> input = (Map<String, Object>) env.getArgument(argName);
                    yield evaluator.levelForNew(def.getEntityClass(), input == null ? Map.of() : input)
                        .map(level -> level.allows(AccessLevel.EDIT))
                        .defaultIfEmpty(false);
                }
                case UPDATE, DELETE -> {
                    Long id = coerceId(env.getArgument("id"));
                    yield evaluator.allows(def.getEntityClass(), id, required);
                }
            };

            return authorized.toFuture().thenCompose(ok -> {
                if (!ok) {
                    return failed(deniedMessage(def, required));
                }
                return invoke(inner, env);
            });
        };
    }

    // --- helpers ---

    /**
     * The request's {@link PermissionEvaluator}, put on the context by
     * {@link AuthenticationGraphQlInterceptor}. The fallback exists only for execution paths that
     * build a context by hand (tests, and any future non-HTTP transport) — it is correct, just
     * cold, since it starts with nothing cached.
     */
    PermissionEvaluator evaluatorOf(DataFetchingEnvironment env, Principal principal) {
        PermissionEvaluator evaluator = env.getGraphQlContext().get(PermissionEvaluator.class);
        return evaluator != null ? evaluator : permissionService.newEvaluator(principal.userId());
    }

    /**
     * Says which level was missing, not just that something was. "Deleting this DegreeProgram requires
     * FULL access; EDIT does not include deletion" tells a user holding EDIT what to ask their
     * deanery for; "you don't have permission" leaves them guessing whether they are in the wrong
     * place entirely.
     */
    private static String deniedMessage(MutationDefinition def, AccessLevel required) {
        String entity = def.getEntityClass().getSimpleName();
        return switch (def.getMutationType()) {
            case CREATE -> "Creating a " + entity + " here requires " + required + " access.";
            case UPDATE -> "Editing this " + entity + " requires " + required + " access.";
            case DELETE -> "Deleting this " + entity + " requires " + required
                + " access; " + AccessLevel.EDIT + " does not include deletion.";
        };
    }

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

    /** Runs the wrapped fetcher once the check has passed, normalising its result to a future. */
    private static CompletableFuture<Object> invoke(DataFetcher<?> inner, DataFetchingEnvironment env) {
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
    }

    private static CompletableFuture<Object> failed(String message) {
        return CompletableFuture.failedFuture(new GraphQlAuthException(message));
    }

    private Long coerceId(Object raw) {
        if (raw == null) return null;
        return raw instanceof Number n ? n.longValue() : Long.parseLong(raw.toString());
    }
}
