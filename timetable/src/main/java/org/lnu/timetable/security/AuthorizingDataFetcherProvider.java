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

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;

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
 *   <li>An update that rewrites a permission-bearing edge is checked <em>twice</em>: on the row as
 *       it stands, and on the row as the update would leave it
 *       ({@link PermissionEvaluator#levelAfterUpdate}). Checking only the first authorizes the act
 *       of touching the row and says nothing about where the row is being put, which let a caller
 *       move a row out of the scope they administer into one they do not. This is the same split
 *       PostgreSQL row-level security makes between {@code USING} and {@code WITH CHECK}, and the
 *       second query only runs for the writes that can actually move a row.</li>
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
            // Empty = allowed; a value is the reason the write was refused.
            Mono<String> denial = switch (def.getMutationType()) {
                case CREATE -> {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> raw = (Map<String, Object>) env.getArgument(argName);
                    Map<String, Object> input = raw == null ? Map.of() : raw;
                    // A new row has no pre-state, so its post-state check IS the create rule: the
                    // caller must end up with the level through some parent it is attached to...
                    Mono<String> covered = evaluator.levelForNew(def.getEntityClass(), input)
                        .map(level -> level.allows(AccessLevel.EDIT))
                        .defaultIfEmpty(false)
                        .flatMap(ok -> ok ? Mono.<String>empty() : Mono.just(deniedMessage(def, required)));
                    // ...and every authority-bearing parent it names is one it may attach to, since
                    // for a new row every such parent is newly introduced.
                    yield covered.switchIfEmpty(
                        evaluator.allowsIntroducedScopes(def.getEntityClass(), null, input,
                                proposedJoinLists(def, input), required)
                            .flatMap(ok -> ok ? Mono.<String>empty()
                                : Mono.just(attachedToUnauthorisedScopeMessage(def, required))));
                }
                case UPDATE -> {
                    Long id = coerceId(env.getArgument("id"));
                    @SuppressWarnings("unchecked")
                    Map<String, Object> raw = (Map<String, Object>) env.getArgument(argName);
                    Map<String, Object> input = raw == null ? Map.of() : raw;
                    Mono<String> preState = evaluator.allows(def.getEntityClass(), id, required)
                        .flatMap(ok -> ok ? Mono.empty() : Mono.just(deniedMessage(def, required)));
                    // Only a write that rewrites a permission-bearing edge can move the row to
                    // another scope; everything else has a post-state identical to its pre-state.
                    if (!evaluator.movesScope(def.getEntityClass(), input, managedJoinTables(def))) {
                        yield preState;
                    }
                    Map<String, Collection<Long>> joinLists = proposedJoinLists(def, input);
                    yield preState
                        // Does the row still sit somewhere the caller administers? (WITH CHECK)
                        .switchIfEmpty(
                            evaluator.levelAfterUpdate(def.getEntityClass(), id, input, joinLists)
                                .map(level -> level.allows(required))
                                .defaultIfEmpty(false)
                                .flatMap(ok -> ok ? Mono.<String>empty()
                                    : Mono.just(movedOutOfScopeMessage(def, required))))
                        // ...and may the caller hand it to every new owner it names?
                        .switchIfEmpty(
                            evaluator.allowsIntroducedScopes(def.getEntityClass(), id, input, joinLists, required)
                                .flatMap(ok -> ok ? Mono.<String>empty()
                                    : Mono.just(attachedToUnauthorisedScopeMessage(def, required))));
                }
                case DELETE -> {
                    Long id = coerceId(env.getArgument("id"));
                    yield evaluator.allows(def.getEntityClass(), id, required)
                        .flatMap(ok -> ok ? Mono.empty() : Mono.just(deniedMessage(def, required)));
                }
            };

            return denial.toFuture().thenCompose(message -> {
                if (message != null) {
                    return failed(message);
                }
                return invoke(inner, env);
            });
        };
    }

    // --- helpers ---

    /** The join tables this mutation rewrites, whether or not any of them carries authority. */
    private static Set<String> managedJoinTables(MutationDefinition def) {
        return def.getManyToManyLists().stream()
            .map(MutationDefinition.ManyToManyDefinition::joinTable)
            .collect(Collectors.toSet());
    }

    /**
     * The membership each managed join table will have after the write, for the tables the input
     * actually names. A list the caller omits is left alone by the mutation, so it is left out here
     * too and the evaluator reads its current membership instead.
     */
    private static Map<String, Collection<Long>> proposedJoinLists(MutationDefinition def, Map<String, Object> input) {
        Map<String, Collection<Long>> lists = new LinkedHashMap<>();
        for (MutationDefinition.ManyToManyDefinition m2m : def.getManyToManyLists()) {
            if (!input.containsKey(m2m.fieldName())) continue;
            Object raw = input.get(m2m.fieldName());
            List<Long> ids = new ArrayList<>();
            if (raw instanceof Collection<?> values) {
                for (Object value : values) {
                    if (value == null) continue;
                    ids.add(value instanceof Number n ? n.longValue() : Long.parseLong(value.toString()));
                }
            }
            lists.put(m2m.joinTable(), ids);   // an explicit empty list clears the table
        }
        return lists;
    }

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

    /**
     * The refusal that belongs to the post-state check, and it has to say something different from
     * the ordinary one: the caller <em>does</em> hold the level on this row, which is exactly why
     * "you need EDIT access" would read as a bug to them. What they do not hold is the level where
     * they are trying to put it.
     */
    private static String movedOutOfScopeMessage(MutationDefinition def, AccessLevel required) {
        return "This change would move the " + def.getEntityClass().getSimpleName()
            + " outside everything you administer. " + required
            + " access is needed where it ends up, not only where it is now.";
    }

    /**
     * The refusal that belongs to the introduced-scope check. Distinct from the other two on
     * purpose: the caller may edit this row and the row does not leave their reach, so both other
     * messages would misdescribe what happened. What they may not do is give a scope they do not
     * administer authority over the row.
     */
    private static String attachedToUnauthorisedScopeMessage(MutationDefinition def, AccessLevel required) {
        return "This change would attach the " + def.getEntityClass().getSimpleName()
            + " to something you do not administer, which would give its administrators access to it. "
            + required + " access is needed on everything you attach it to.";
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
