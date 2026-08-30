package org.lnu.timetable.framework.metadata;

import com.google.common.base.CaseFormat;
import org.springframework.stereotype.Component;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The permission cascade as a graph of <em>resource types</em>, rather than of rows.
 *
 * <h2>Why a second graph</h2>
 * {@code PermissionEvaluator} walks the cascade over rows — "does this person hold a grant on
 * department 7 or on anything above it" — and that is the only graph an authorization decision needs.
 * But the client asks a different question before it draws a screen: <em>could this person create a
 * {@code ClassStartTimeSet} at all?</em> That has no row to walk from, and answering it row-wise
 * would mean asking about every candidate parent in the university.
 * <p>
 * At the level of types it is a small static question, answerable from the same
 * {@code @PermissionParent} / {@code @PermissionJoinParent} / {@code @PermissionRoot} declarations
 * the row walk uses. This class computes it once at startup and holds it: which types a grant of a
 * given type can reach downward, and therefore which types the holder could create something of.
 * <p>
 * The client used to answer that question with «this account holds at least one grant somewhere»,
 * which is how a викладач with a grant on one кафедра was shown «+ Додати» on «Корпуси» — a button
 * whose mutation the service was always going to refuse. Publishing this graph
 * ({@code Query.accessModel}) is what lets the two sides agree without the client keeping its own
 * copy of the hierarchy, which would drift the first time an entity is added.
 *
 * <h2>What it is not</h2>
 * Type-level coverage is deliberately an over-approximation of row-level coverage: it says a grant on
 * some {@code Faculty} could reach some {@code Department}, not that <em>this</em> faculty reaches
 * <em>that</em> department. That is exactly the right resolution for deciding whether a page or an
 * «+ Додати» button is worth showing at all; every actual write is still checked against the row, by
 * {@code AuthorizingDataFetcherProvider}, on the server.
 */
@Component
public class PermissionTypeGraph {

    /**
     * One foreign-key edge upward, named the way a create names it. {@code field} is the input field
     * that carries the parent's id — {@code faculty_id} becomes {@code facultyId} — which is what lets
     * a client work out the level a create would need from the values it is about to send, exactly as
     * {@code PermissionEvaluator#levelForNew} does from the values it received.
     */
    public record ParentEdge(
        String resourceType,
        String field,
        boolean nullable,
        /**
         * Whether attaching along this edge requires authority over the destination — see
         * {@code @PermissionParent#authority()}. Published so that the client's mirror of the create
         * rule can be the same rule: a client that only knew the edges would predict a create the
         * server refuses, which is the failure this graph exists to prevent.
         */
        boolean authority
    ) {}

    /** One resource type, and the types a grant could cascade into it from. */
    public record Node(
        String resourceType,
        /** Foreign-key edges on this entity's own table — the only edges a create can use. */
        List<ParentEdge> parentTypes,
        /** Types reachable through a join table; they cover rows that already exist, never a create. */
        List<String> joinParentTypes,
        /** Declared {@code @PermissionRoot}: no owner, so only a {@code GLOBAL} grant reaches it. */
        boolean root
    ) {}

    private final Map<String, Node> nodes = new LinkedHashMap<>();

    /** resourceType -> every type a grant on it can cover, itself included. Transitive, both edge kinds. */
    private final Map<String, Set<String>> coveredByGrantOn = new LinkedHashMap<>();

    public PermissionTypeGraph(EntityMetadataRegistry registry) {
        for (EntityMetadata md : registry.getAllMetadata()) {
            List<ParentEdge> parents = new ArrayList<>();
            for (PermissionParentEdge edge : md.permissionParents()) {
                parents.add(new ParentEdge(resourceTypeOf(registry, edge.parentEntity()),
                    CaseFormat.LOWER_UNDERSCORE.to(CaseFormat.LOWER_CAMEL, edge.joinColumn()),
                    edge.nullable(), edge.authority()));
            }
            List<String> joinParents = new ArrayList<>();
            for (PermissionJoinParentEdge edge : md.permissionJoinParents()) {
                joinParents.add(resourceTypeOf(registry, edge.parentEntity()));
            }
            nodes.put(md.resourceType(),
                new Node(md.resourceType(), List.copyOf(parents), List.copyOf(joinParents), md.permissionRoot()));
        }

        // Invert the parent edges once: for each type, who hangs off it directly.
        Map<String, Set<String>> childrenOf = new LinkedHashMap<>();
        for (Node node : nodes.values()) {
            for (ParentEdge parent : node.parentTypes()) {
                childrenOf.computeIfAbsent(parent.resourceType(), k -> new LinkedHashSet<>()).add(node.resourceType());
            }
            for (String parent : node.joinParentTypes()) {
                childrenOf.computeIfAbsent(parent, k -> new LinkedHashSet<>()).add(node.resourceType());
            }
        }
        for (String type : nodes.keySet()) {
            coveredByGrantOn.put(type, descendantsOf(type, childrenOf));
        }
    }

    private static String resourceTypeOf(EntityMetadataRegistry registry, Class<?> entityClass) {
        EntityMetadata md = registry.getMetadata(entityClass);
        if (md == null) {
            throw new IllegalStateException(
                "Permission edge points at " + entityClass.getName() + ", which is not a @GraphQLEntity");
        }
        return md.resourceType();
    }

    /**
     * Breadth-first downward closure, with a visited set rather than a depth counter — {@code Course}
     * is its own child type (an ELECTIVE hangs off its ELECTIVE_GROUP), so the graph has a self-loop
     * that a naive walk would follow forever.
     */
    private static Set<String> descendantsOf(String type, Map<String, Set<String>> childrenOf) {
        Set<String> reached = new LinkedHashSet<>();
        reached.add(type);
        Deque<String> queue = new ArrayDeque<>();
        queue.add(type);
        while (!queue.isEmpty()) {
            for (String child : childrenOf.getOrDefault(queue.poll(), Set.of())) {
                if (reached.add(child)) queue.add(child);
            }
        }
        return Set.copyOf(reached);
    }

    /** Every declared resource type, in registry order. */
    public Collection<Node> nodes() {
        return nodes.values();
    }

    public Node node(String resourceType) {
        return nodes.get(resourceType);
    }

    /** Every type a grant on {@code resourceType} can cover, itself included. */
    public Set<String> coveredBy(String resourceType) {
        return coveredByGrantOn.getOrDefault(resourceType, Set.of());
    }

    /**
     * The types somebody could create <em>somewhere</em>, holding grants on {@code grantTypes} (at a
     * level of at least {@code EDIT} — the caller filters that before asking).
     * <p>
     * A create is authorized against the parents named in the proposed input, and only foreign-key
     * parents can be named: nothing points at a row that does not exist yet, so a join-table ancestor
     * cannot apply. So a type is creatable exactly when one of its {@code @PermissionParent} types is
     * covered by something held — which mirrors {@code PermissionEvaluator#levelForNew} one level up,
     * at the type instead of the row.
     * <p>
     * A {@code @PermissionRoot} type is never in the answer: with no parent to attach to, only a
     * {@code GLOBAL} grant creates one, and a caller holding that is handled by
     * {@link #allTypes()} at the call site.
     */
    public Set<String> creatableFrom(Collection<String> grantTypes) {
        Set<String> covered = new LinkedHashSet<>();
        for (String grantType : grantTypes) {
            covered.addAll(coveredBy(grantType));
        }
        Set<String> creatable = new LinkedHashSet<>();
        for (Node node : nodes.values()) {
            for (ParentEdge parent : node.parentTypes()) {
                if (covered.contains(parent.resourceType())) {
                    creatable.add(node.resourceType());
                    break;
                }
            }
        }
        return creatable;
    }

    /** Every resource type — what a {@code GLOBAL} grant amounts to. */
    public Set<String> allTypes() {
        return Set.copyOf(nodes.keySet());
    }
}
