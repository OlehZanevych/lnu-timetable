package org.lnu.timetable.security;

import graphql.schema.FieldCoordinates;
import graphql.schema.GraphQLCodeRegistry;
import graphql.schema.GraphQLList;
import graphql.schema.GraphQLNonNull;
import graphql.schema.GraphQLObjectType;
import graphql.schema.GraphQLTypeReference;
import org.lnu.timetable.framework.schema.HandWrittenApi;
import org.lnu.timetable.framework.schema.SchemaTypeRegistry;
import org.springframework.stereotype.Component;

import static graphql.Scalars.GraphQLBoolean;
import static graphql.Scalars.GraphQLID;
import static graphql.Scalars.GraphQLInt;
import static graphql.Scalars.GraphQLString;
import static graphql.schema.GraphQLArgument.newArgument;
import static graphql.schema.GraphQLEnumType.newEnum;
import static graphql.schema.GraphQLFieldDefinition.newFieldDefinition;
import static graphql.schema.GraphQLObjectType.newObject;

/**
 * The GraphQL surface of group invitation links — three queries, three mutations, answered by
 * {@link GroupInvitationDataFetchers}.
 *
 * <p>A {@link HandWrittenApi} bean, like {@link SelfServiceSchema}, rather than five more methods
 * inside {@code DynamicGraphQLSchemaBuilder} where the older auth fields still live. Nothing here
 * is a row keyed by an id in the way the entity framework means it: an invitation is a credential
 * whose one interesting column must never be selectable by a generic fetcher, and «join the group
 * this token names» is not a CRUD verb.
 *
 * <p>Every failure is a named status rather than a message, matching {@code login} and
 * {@code requestRegistration} — the client says something different in Ukrainian for each
 * («термін дії посилання минув», «ви вже учасник цієї групи»), and a sentence from the server would
 * be neither translatable nor actionable. The exception is authorization, which throws
 * {@code GraphQlAuthException} and arrives as a GraphQL error carrying {@code extensions.code}:
 * being refused the right to administer a group is not one of the outcomes of asking, it is the
 * answer to a question the caller should not have been able to ask.
 */
@Component
public class GroupInvitationSchema implements HandWrittenApi {

    private final GroupInvitationDataFetchers fetchers;

    public GroupInvitationSchema(GroupInvitationDataFetchers fetchers) {
        this.fetchers = fetchers;
    }

    @Override
    public void buildTypes(SchemaTypeRegistry types) {
        // The token is a field of this type, and this type is returned by exactly one query, which
        // refuses anybody who may not administer the group. That is the whole of what keeps a live
        // invitation off a stranger's screen — see GroupInvitationRepository's class note for why it
        // is stored readable at all.
        types.object(newObject().name("GroupInvitation")
            .field(newFieldDefinition().name("id").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("groupId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .field(newFieldDefinition().name("token").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("The secret in the link. The client builds the URL it shares from this and its own origin"))
            .field(newFieldDefinition().name("expiresAt").type(GraphQLNonNull.nonNull(GraphQLString))
                .description("ISO-8601, no zone — the column holds a local timestamp and so does everything reading it"))
            .field(newFieldDefinition().name("isExpired").type(GraphQLNonNull.nonNull(GraphQLBoolean))
                .description("Computed by the database, so the answer comes from the clock that wrote the row"))
            .field(newFieldDefinition().name("joinCount").type(GraphQLNonNull.nonNull(GraphQLInt))
                .description("How many accounts joined through this link — what is asked before deleting it"))
            .field(newFieldDefinition().name("createdAt").type(GraphQLNonNull.nonNull(GraphQLString)))
            .field(newFieldDefinition().name("createdByName").type(GraphQLString)
                .description("The account that made it, or null once that account has been deleted"))
            .build());

        types.enumeration(newEnum().name("GroupInvitationStatus")
            .value("VALID", "VALID", "The link is good and may be redeemed")
            .value("NOT_FOUND", "NOT_FOUND", "No such link — it never existed, or it has been deleted")
            .value("EXPIRED", "EXPIRED", "The link is past its expiry")
            .build());

        // What the page carrying a link asks on arrival, so it can say «термін дії минув» before a
        // button is pressed rather than after — and so «ви вже учасник» is a sentence rather than a
        // failed mutation.
        types.object(newObject().name("GroupInvitationCheck")
            .field(newFieldDefinition().name("isValid").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("status")
                .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("GroupInvitationStatus"))))
            .field(newFieldDefinition().name("groupId").type(GraphQLID)
                .description("Set only when the link is valid"))
            .field(newFieldDefinition().name("groupName").type(GraphQLString))
            .field(newFieldDefinition().name("isMember").type(GraphQLNonNull.nonNull(GraphQLBoolean))
                .description("Whether the signed-in account is already in that group"))
            .build());

        types.enumeration(newEnum().name("CreateGroupInvitationErrorStatus")
            .value("INVALID_TTL", "INVALID_TTL", "The lifetime is outside 5 minutes … 30 days")
            .value("GROUP_NOT_FOUND", "GROUP_NOT_FOUND", "No such group")
            .build());

        types.object(newObject().name("CreateGroupInvitationResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("data").type(GraphQLTypeReference.typeRef("GroupInvitation"))
                .description("The invitation, token included — this is the one moment the client is handed one"))
            .field(newFieldDefinition().name("errorStatus")
                .type(GraphQLTypeReference.typeRef("CreateGroupInvitationErrorStatus")))
            .build());

        types.enumeration(newEnum().name("JoinGroupErrorStatus")
            .value("INVALID_TOKEN", "INVALID_TOKEN", "No such link, or the group it named is gone")
            .value("EXPIRED_TOKEN", "EXPIRED_TOKEN", "The link is past its expiry")
            .value("ALREADY_MEMBER", "ALREADY_MEMBER", "This account is already in the group")
            .build());

        types.object(newObject().name("JoinGroupResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("groupId").type(GraphQLID))
            .field(newFieldDefinition().name("groupName").type(GraphQLString)
                .description("Named on success and on ALREADY_MEMBER, so the page can say which group"))
            .field(newFieldDefinition().name("errorStatus").type(GraphQLTypeReference.typeRef("JoinGroupErrorStatus")))
            .build());
    }

    @Override
    public void addQueryFields(GraphQLObjectType.Builder queryBuilder) {
        queryBuilder.field(newFieldDefinition().name("manageableGroups")
            .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("Group")))))
            .description("The groups this caller may administer: every group for an administrator, and for anybody " +
                "else the ones they hold MANAGE over every grant of. Narrower than `groups`, which names them all " +
                "to every signed-in caller so that access can be granted to them"));

        queryBuilder.field(newFieldDefinition().name("groupInvitations")
            .type(GraphQLNonNull.nonNull(GraphQLList.list(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("GroupInvitation")))))
            .description("Every invitation link of one group, newest first, tokens included. Refused unless the " +
                "caller may administer that group")
            .argument(newArgument().name("groupId").type(GraphQLNonNull.nonNull(GraphQLID))));

        queryBuilder.field(newFieldDefinition().name("groupInvitation")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("GroupInvitationCheck")))
            .description("Inspects a link without redeeming it: whether it is still good, which group it opens, and " +
                "whether the signed-in account is already in it")
            .argument(newArgument().name("token").type(GraphQLNonNull.nonNull(GraphQLString))));
    }

    @Override
    public void addMutationFields(GraphQLObjectType.Builder mutationBuilder) {
        mutationBuilder.field(newFieldDefinition().name("createGroupInvitation")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("CreateGroupInvitationResponse")))
            .description("Mints a link into one group, good for `ttlMinutes` — at least 5, at most 43 200 (thirty " +
                "days), bounded again by a CHECK on the table. Needs MANAGE over everything the group can reach")
            .argument(newArgument().name("groupId").type(GraphQLNonNull.nonNull(GraphQLID)))
            .argument(newArgument().name("ttlMinutes").type(GraphQLNonNull.nonNull(GraphQLInt))));

        mutationBuilder.field(newFieldDefinition().name("deleteGroupInvitation")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("SimpleResponse")))
            .description("Revokes a link by deleting it. Membership already gained through it is untouched — " +
                "revoking an invitation is not revoking access, which is what `revokePermission` is for")
            .argument(newArgument().name("invitationId").type(GraphQLNonNull.nonNull(GraphQLID))));

        mutationBuilder.field(newFieldDefinition().name("joinGroupByInvitation")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("JoinGroupResponse")))
            .description("Redeems a link: puts the signed-in account into the group the token names, and nothing " +
                "else — no account is created, no grant is made, and the joiner gains no right to invite anybody")
            .argument(newArgument().name("token").type(GraphQLNonNull.nonNull(GraphQLString))));
    }

    @Override
    public void registerFetchers(GraphQLCodeRegistry.Builder codeRegistry) {
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "manageableGroups"), fetchers.manageableGroups());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "groupInvitations"), fetchers.groupInvitations());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "groupInvitation"), fetchers.groupInvitation());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "createGroupInvitation"), fetchers.createGroupInvitation());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "deleteGroupInvitation"), fetchers.deleteGroupInvitation());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "joinGroupByInvitation"), fetchers.joinGroupByInvitation());
    }
}
