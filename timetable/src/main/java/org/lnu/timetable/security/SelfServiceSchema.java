package org.lnu.timetable.security;

import graphql.schema.FieldCoordinates;
import graphql.schema.GraphQLCodeRegistry;
import graphql.schema.GraphQLNonNull;
import graphql.schema.GraphQLObjectType;
import graphql.schema.GraphQLTypeReference;
import org.lnu.timetable.framework.schema.HandWrittenApi;
import org.lnu.timetable.framework.schema.SchemaTypeRegistry;
import org.springframework.stereotype.Component;

import static graphql.Scalars.GraphQLBoolean;
import static graphql.Scalars.GraphQLInt;
import static graphql.Scalars.GraphQLString;
import static graphql.schema.GraphQLArgument.newArgument;
import static graphql.schema.GraphQLEnumType.newEnum;
import static graphql.schema.GraphQLFieldDefinition.newFieldDefinition;
import static graphql.schema.GraphQLObjectType.newObject;

/**
 * The GraphQL surface of self-service registration and password recovery — six root fields, four
 * result types and five enums, declared here and answered by {@link SelfServiceDataFetchers}.
 *
 * <p>It is a {@link HandWrittenApi} rather than four more methods inside
 * {@code DynamicGraphQLSchemaBuilder}, which is where the other hand-written areas still live. The
 * fields cannot be generated — nothing here is a row keyed by an id — and they must not be routed
 * through {@code AuthorizingDataFetcherProvider}, whose first rule is that a caller is signed in
 * and whose whole point these six fields are the exception to. Somebody who has forgotten their
 * password is by definition not signed in.
 *
 * <p><strong>Every failure is an enum, not a message.</strong> The four mutations answer
 * {@code isSuccess} plus a named status, the same shape {@code login} and {@code createUser} use,
 * because the client has to say something different in Ukrainian for each — «цю адресу вже
 * зареєстровано» offers a password-recovery link, «самостійна реєстрація недоступна» offers a
 * telephone number, and a free-text message from the server would be neither translatable nor
 * actionable. The statuses are enums rather than strings so that introspection documents them and a
 * client cannot invent one.
 */
@Component
public class SelfServiceSchema implements HandWrittenApi {

    private final SelfServiceDataFetchers fetchers;

    public SelfServiceSchema(SelfServiceDataFetchers fetchers) {
        this.fetchers = fetchers;
    }

    @Override
    public void buildTypes(SchemaTypeRegistry types) {
        // Which of the two kinds of person a registration link belongs to. The client uses it for
        // one sentence («Вас зареєстровано як викладача») and for nothing else — what the account
        // may then do follows from its grants, not from this.
        types.enumeration(newEnum().name("PersonRole")
            .value("LECTURER", "LECTURER", "The link belongs to a викладач")
            .value("STUDENT", "STUDENT", "The link belongs to a студент")
            .build());

        types.enumeration(newEnum().name("RegistrationRequestStatus")
            .value("LINK_SENT", "LINK_SENT", "A registration link has been e-mailed to this address")
            .value("ALREADY_REGISTERED", "ALREADY_REGISTERED",
                "An account with this e-mail already exists — offer password recovery rather than registration")
            .value("PERSON_ALREADY_LINKED", "PERSON_ALREADY_LINKED",
                "A викладач or студент carries this e-mail, but another account already claims that person")
            .value("NOT_ELIGIBLE", "NOT_ELIGIBLE",
                "No викладач and no студент carries this e-mail, so nobody may register with it")
            .value("TOO_MANY_REQUESTS", "TOO_MANY_REQUESTS", "A link was sent to this address moments ago")
            .value("MAIL_FAILED", "MAIL_FAILED", "The link could not be sent")
            .build());

        types.object(newObject().name("RegistrationRequestResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("status")
                .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("RegistrationRequestStatus"))))
            .field(newFieldDefinition().name("role").type(GraphQLTypeReference.typeRef("PersonRole"))
                .description("Which kind of person the link was sent to; set only with LINK_SENT"))
            .field(newFieldDefinition().name("expiresInMinutes").type(GraphQLInt)
                .description("How long the link stays good, so the client can say so rather than hardcode it"))
            .build());

        types.enumeration(newEnum().name("PasswordResetRequestStatus")
            .value("LINK_SENT", "LINK_SENT", "A recovery link has been e-mailed to this address")
            .value("UNKNOWN_EMAIL", "UNKNOWN_EMAIL", "No account has this e-mail")
            .value("ACCOUNT_DISABLED", "ACCOUNT_DISABLED", "The account has been deactivated")
            .value("TOO_MANY_REQUESTS", "TOO_MANY_REQUESTS", "A link was sent to this address moments ago")
            .value("MAIL_FAILED", "MAIL_FAILED", "The link could not be sent")
            .build());

        types.object(newObject().name("PasswordResetRequestResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("status")
                .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("PasswordResetRequestStatus"))))
            .field(newFieldDefinition().name("expiresInMinutes").type(GraphQLInt))
            .build());

        // What a link is worth when the page carrying it opens. Five states rather than a boolean,
        // because «посилання вже використано» and «термін дії посилання минув» are different things
        // to do next — sign in, or ask for another one.
        types.enumeration(newEnum().name("AccountLinkStatus")
            .value("VALID", "VALID", "The link is good and may be redeemed")
            .value("NOT_FOUND", "NOT_FOUND", "No such link, or the person it named no longer exists")
            .value("EXPIRED", "EXPIRED", "The link is past its thirty minutes, or a newer link replaced it")
            .value("USED", "USED", "The link has already been redeemed")
            .value("UNAVAILABLE", "UNAVAILABLE",
                "The link is good but redeeming it would fail anyway: the account has been "
                    + "deactivated, or came into being some other way, since it was sent")
            .build());

        types.object(newObject().name("AccountLinkCheck")
            .field(newFieldDefinition().name("isValid").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("status")
                .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("AccountLinkStatus"))))
            .field(newFieldDefinition().name("email").type(GraphQLString)
                .description("The address the link was sent to; null unless the link is valid"))
            .field(newFieldDefinition().name("firstName").type(GraphQLString))
            .field(newFieldDefinition().name("lastName").type(GraphQLString))
            .field(newFieldDefinition().name("role").type(GraphQLTypeReference.typeRef("PersonRole"))
                .description("Set on a registration link only"))
            .build());

        types.enumeration(newEnum().name("AccountLinkErrorStatus")
            .value("INVALID_TOKEN", "INVALID_TOKEN", "No such link, or the person or account it named is gone")
            .value("EXPIRED_TOKEN", "EXPIRED_TOKEN", "The link is past its thirty minutes")
            .value("USED_TOKEN", "USED_TOKEN", "The link has already been redeemed, or a newer one replaced it")
            .value("WEAK_PASSWORD", "WEAK_PASSWORD", "The password is shorter than 8 characters, or longer than the 72 bytes BCrypt hashes")
            .value("ALREADY_REGISTERED", "ALREADY_REGISTERED", "An account with this e-mail came into being meanwhile")
            .value("PERSON_ALREADY_LINKED", "PERSON_ALREADY_LINKED", "Another account already claims this person")
            .value("ACCOUNT_DISABLED", "ACCOUNT_DISABLED", "The account has been deactivated")
            .build());

        // One response type for both redemptions, because both end the same way: the caller is
        // holding a session. Handing back a JWT rather than a "now please sign in" screen is the
        // point — the password was chosen ten seconds ago, on this page.
        types.object(newObject().name("AccountLinkResponse")
            .field(newFieldDefinition().name("isSuccess").type(GraphQLNonNull.nonNull(GraphQLBoolean)))
            .field(newFieldDefinition().name("token").type(GraphQLString)
                .description("A JWT for the account, so the client is signed in without a second trip through login"))
            .field(newFieldDefinition().name("errorStatus")
                .type(GraphQLTypeReference.typeRef("AccountLinkErrorStatus")))
            .build());
    }

    @Override
    public void addQueryFields(GraphQLObjectType.Builder queryBuilder) {
        queryBuilder.field(newFieldDefinition().name("registrationLink")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("AccountLinkCheck")))
            .description("Inspects a registration link without spending it: whether it is still good, and whose it is. " +
                "Unauthenticated, like every field here — the point of the link is that its holder has no account yet")
            .argument(newArgument().name("token").type(GraphQLNonNull.nonNull(GraphQLString))));

        queryBuilder.field(newFieldDefinition().name("passwordResetLink")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("AccountLinkCheck")))
            .description("The same for a password-recovery link")
            .argument(newArgument().name("token").type(GraphQLNonNull.nonNull(GraphQLString))));
    }

    @Override
    public void addMutationFields(GraphQLObjectType.Builder mutationBuilder) {
        mutationBuilder.field(newFieldDefinition().name("requestRegistration")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("RegistrationRequestResponse")))
            .description("Asks for a registration link. Answers ALREADY_REGISTERED when an account has this e-mail, " +
                "LINK_SENT when a викладач or a студент carries it, and NOT_ELIGIBLE when nobody does — only people " +
                "the institution has already entered may register themselves")
            .argument(newArgument().name("email").type(GraphQLNonNull.nonNull(GraphQLString))));

        mutationBuilder.field(newFieldDefinition().name("completeRegistration")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("AccountLinkResponse")))
            .description("Redeems a registration link: creates the account, links it to the викладач or студент the " +
                "link named, and returns a token so the caller is signed in. The account holds no permissions")
            .argument(newArgument().name("token").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("password").type(GraphQLNonNull.nonNull(GraphQLString))));

        mutationBuilder.field(newFieldDefinition().name("requestPasswordReset")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("PasswordResetRequestResponse")))
            .description("Asks for a password-recovery link, e-mailed to the address of an existing account")
            .argument(newArgument().name("email").type(GraphQLNonNull.nonNull(GraphQLString))));

        mutationBuilder.field(newFieldDefinition().name("resetPassword")
            .type(GraphQLNonNull.nonNull(GraphQLTypeReference.typeRef("AccountLinkResponse")))
            .description("Redeems a password-recovery link: sets the new password, clears any forced change, and " +
                "returns a token so the caller is signed in")
            .argument(newArgument().name("token").type(GraphQLNonNull.nonNull(GraphQLString)))
            .argument(newArgument().name("password").type(GraphQLNonNull.nonNull(GraphQLString))));
    }

    @Override
    public void registerFetchers(GraphQLCodeRegistry.Builder codeRegistry) {
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "registrationLink"), fetchers.registrationLink());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Query", "passwordResetLink"), fetchers.passwordResetLink());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "requestRegistration"), fetchers.requestRegistration());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "completeRegistration"), fetchers.completeRegistration());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "requestPasswordReset"), fetchers.requestPasswordReset());
        codeRegistry.dataFetcher(FieldCoordinates.coordinates("Mutation", "resetPassword"), fetchers.resetPassword());
    }
}
