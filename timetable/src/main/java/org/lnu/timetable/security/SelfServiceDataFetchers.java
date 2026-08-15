package org.lnu.timetable.security;

import graphql.schema.DataFetcher;
import graphql.schema.DataFetchingEnvironment;
import org.lnu.timetable.mail.MailService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The hand-written fetchers behind self-service registration and password recovery — the one part
 * of this API that an unauthenticated stranger may reach besides {@code login}.
 *
 * <h2>What "self-service" is allowed to mean here</h2>
 *
 * Not "anyone may create an account". A university timetable is not a public service: every person
 * in it is already in it, entered by a кафедра or a деканат as a {@code Lecturer} or a
 * {@code Student} with a name, a department or a group, and — the part this feature turns on — an
 * e-mail. So the rule is that a person the institution has already entered may claim the account
 * that belongs to them, and nobody else may create one at all.
 *
 * <p>{@code requestRegistration} therefore asks four questions of one address, in this order, and
 * each of the four answers is a different thing to tell the person typing it:
 *
 * <ol>
 *   <li><strong>Is there already an account with this e-mail?</strong> Then say so, and offer
 *       password recovery — the overwhelmingly likely reason somebody who already has an account is
 *       on the registration screen is that they cannot get in.</li>
 *   <li><strong>Is there a викладач with this e-mail?</strong> Then send them a link.</li>
 *   <li><strong>Failing that, a студент?</strong> Then send them a link.</li>
 *   <li><strong>Otherwise</strong> — say that self-registration is not open, because for this
 *       address it genuinely is not, and that an administrator is who to ask.</li>
 * </ol>
 *
 * Викладачі are consulted before студенти because that is the order in which an ambiguous address
 * should resolve: a person who is both a doctoral студент and an assistant викладач works here, and
 * the account they need is the one that opens their навантаження.
 *
 * <h2>What this deliberately does not do</h2>
 *
 * <strong>It does not hide which of the four happened.</strong> A public sign-up form normally
 * answers every address with the same "check your inbox", so that the form cannot be used to test
 * whether an address is registered. Two things make that the wrong trade here. The population is
 * closed and already known — a person's university address is on the кафедра's own web page — so
 * there is nothing to discover that is not published. And the answers are not interchangeable: an
 * address that will never work has to say so, or the person waits for an e-mail that is not coming
 * and concludes the system is broken rather than that they should telephone the деканат. The cost
 * is real and is written down under *Known limitations*, along with the cooldown that keeps this
 * from being an e-mail cannon pointed at a stranger.
 *
 * <p><strong>It grants nothing.</strong> An account created here holds no permission of any kind.
 * Reads are open to any authenticated caller, so a викладач immediately sees «Мій кабінет», their
 * навантаження and their розклад — which is the whole of what a self-registered account is for.
 * Every write still needs a grant somebody with {@code MANAGE} chose to make.
 *
 * <p><strong>It does not touch the person link's uniqueness.</strong> One account per викладач and
 * one per студент is still {@code users_unique_lecturer} / {@code users_unique_student}; this
 * checks it before sending a link so the answer is a sentence rather than an integrity violation
 * thirty minutes later.
 *
 * <h2>The links</h2>
 *
 * A link carries 32 bytes from {@link SecureRandom}, base64url, and lives
 * {@code app.security.account-token-ttl-minutes} (30). Only its SHA-256 is stored. Issuing one
 * spends whatever was outstanding for the same address and purpose, so the newest e-mail is always
 * the live one, and redeeming it is a conditional {@code UPDATE} — two tabs racing on the same link
 * produce one account and one «посилання вже використано», never two accounts.
 */
@Component
public class SelfServiceDataFetchers {

    /** The same floor {@code changePassword} enforces; stated once, checked in both places. */
    private static final int MIN_PASSWORD_LENGTH = 8;

    /**
     * BCrypt hashes at most 72 bytes and {@code BCryptPasswordEncoder} refuses anything longer
     * rather than silently truncating it. Bytes, not characters: a Ukrainian passphrase is two
     * bytes per letter in UTF-8, so this is reachable at 37 letters — well inside what somebody
     * choosing a memorable phrase would type. Checked here so it comes back as a status the form
     * can explain, instead of as an {@code IllegalArgumentException} from inside the encoder.
     */
    private static final int MAX_PASSWORD_BYTES = 72;

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder TOKEN_ENCODER = Base64.getUrlEncoder().withoutPadding();

    private final AccountTokenRepository tokenRepo;
    private final PermissionRepository permissionRepo;
    private final MailService mailService;
    private final JwtService jwtService;
    private final PasswordEncoder passwordEncoder;
    private final String baseUrl;
    private final int ttlMinutes;
    private final int cooldownSeconds;
    private final int maxPerMinute;

    public SelfServiceDataFetchers(AccountTokenRepository tokenRepo, PermissionRepository permissionRepo,
                                    MailService mailService, JwtService jwtService, PasswordEncoder passwordEncoder,
                                    @Value("${app.base-url:http://localhost:8080}") String baseUrl,
                                    @Value("${app.security.account-token-ttl-minutes:30}") int ttlMinutes,
                                    @Value("${app.security.account-token-cooldown-seconds:60}") int cooldownSeconds,
                                    @Value("${app.security.account-token-max-per-minute:20}") int maxPerMinute) {
        this.tokenRepo = tokenRepo;
        this.permissionRepo = permissionRepo;
        this.mailService = mailService;
        this.jwtService = jwtService;
        this.passwordEncoder = passwordEncoder;
        // A trailing slash here and a leading one in the path would produce "//register/…", which
        // most routers survive and no reader trusts.
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.ttlMinutes = ttlMinutes;
        this.cooldownSeconds = cooldownSeconds;
        this.maxPerMinute = maxPerMinute;
    }

    // --- Mutation.requestRegistration ---

    public DataFetcher<?> requestRegistration() {
        return env -> {
            String email = normalize(env.getArgument("email"));
            if (email.isEmpty()) {
                return Mono.just(registrationRequestResult("NOT_ELIGIBLE", null)).toFuture();
            }
            return permissionRepo.findUserByEmail(email)
                .map(existing -> registrationRequestResult("ALREADY_REGISTERED", null))
                .switchIfEmpty(Mono.defer(() -> tokenRepo.findLecturerByEmail(email)
                    .flatMap(lecturer -> issueRegistrationLink(lecturer, true))
                    .switchIfEmpty(Mono.defer(() -> tokenRepo.findStudentByEmail(email)
                        .flatMap(student -> issueRegistrationLink(student, false))
                        .switchIfEmpty(Mono.just(registrationRequestResult("NOT_ELIGIBLE", null)))))))
                .toFuture();
        };
    }

    private Mono<Map<String, Object>> issueRegistrationLink(AccountTokenRepository.PersonRow person, boolean lecturer) {
        String role = lecturer ? "LECTURER" : "STUDENT";
        return tokenRepo.personHasAccount(lecturer, person.id()).flatMap(claimed -> {
            if (Boolean.TRUE.equals(claimed)) {
                return Mono.just(registrationRequestResult("PERSON_ALREADY_LINKED", null));
            }
            return issueLink(AccountTokenPurpose.REGISTRATION, person.email(), person.firstName(),
                    lecturer ? person.id() : null, lecturer ? null : person.id(), null, "/register/")
                .map(status -> registrationRequestResult(status, "LINK_SENT".equals(status) ? role : null));
        });
    }

    // --- Mutation.requestPasswordReset ---

    public DataFetcher<?> requestPasswordReset() {
        return env -> {
            String email = normalize(env.getArgument("email"));
            if (email.isEmpty()) {
                return Mono.just(simpleStatusResult("UNKNOWN_EMAIL")).toFuture();
            }
            return permissionRepo.findUserByEmail(email)
                .flatMap(user -> {
                    if (!user.active()) {
                        // A deactivated account is not a forgotten password, and letting it set a
                        // new one would be handing back access somebody took away on purpose.
                        return Mono.just(simpleStatusResult("ACCOUNT_DISABLED"));
                    }
                    return issueLink(AccountTokenPurpose.PASSWORD_RESET, user.email(), user.firstName(),
                            null, null, user.id(), "/reset-password/")
                        .map(this::simpleStatusResult);
                })
                .switchIfEmpty(Mono.just(simpleStatusResult("UNKNOWN_EMAIL")))
                .toFuture();
        };
    }

    /**
     * Issues one link and mails it, answering {@code LINK_SENT}, {@code TOO_MANY_REQUESTS} or
     * {@code MAIL_FAILED}.
     *
     * <p><strong>Two limits, because there are two victims.</strong> The per-address cooldown stops
     * one inbox being filled; the per-minute cap over the whole table stops the mailbox itself being
     * used as a cannon by a script walking a list of published university addresses, which trips no
     * per-address limit at all. Both answer {@code TOO_MANY_REQUESTS} — from the outside they are
     * the same "not now", and distinguishing them would only tell an attacker which one they hit.
     *
     * <p><strong>The order of the last three steps is the whole of the failure story.</strong> The
     * new token is written, then sent, and only a send that succeeded retires the links that came
     * before it. Retiring first — the obvious order — means an SMTP hiccup leaves somebody holding
     * a link that has just been invalidated and a new one that was never delivered, i.e. no way in
     * at all. A send that fails instead deletes the row it wrote, so nothing changed: the previous
     * link still works and the cooldown has not started, which is what somebody who has just been
     * told «не вдалося надіслати листа» needs to be true when they press the button again.
     *
     * <p>Writing the token is <em>not</em> caught: a database that cannot record a link should fail
     * the request loudly rather than be reported as a mail problem. Nor is the recovery reachable
     * from anything that happens after the message has left — once an inbox holds the link, the one
     * thing that must not happen is deleting the row it names.
     */
    private Mono<String> issueLink(AccountTokenPurpose purpose, String email, String firstName,
                                    Long lecturerId, Long studentId, Long userId, String pathPrefix) {
        return Mono.zip(tokenRepo.secondsSinceLastRequest(email, purpose), tokenRepo.issuedInLastMinute())
            .flatMap(limits -> {
                if (limits.getT1() < cooldownSeconds || limits.getT2() >= maxPerMinute) {
                    return Mono.just("TOO_MANY_REQUESTS");
                }
                String token = newToken();
                return tokenRepo.insert(purpose, hash(token), email, lecturerId, studentId, userId, ttlMinutes)
                    .flatMap(id -> {
                        String url = baseUrl + pathPrefix + token;
                        Mono<Void> sent = purpose == AccountTokenPurpose.REGISTRATION
                            ? mailService.sendRegistrationLink(email, firstName, url, ttlMinutes)
                            : mailService.sendPasswordResetLink(email, firstName, url, ttlMinutes);
                        return sent
                            // Superseding is best-effort, and has to be: the message is already in
                            // somebody's inbox by now, so a failure here must not reach the
                            // recovery below and delete the token that message names. The cost of
                            // letting it go is the pre-existing nuisance of two live links.
                            .then(tokenRepo.supersedeOutstanding(email, purpose, id).onErrorReturn(0L))
                            .thenReturn("LINK_SENT")
                            .onErrorResume(e -> tokenRepo.delete(id).thenReturn("MAIL_FAILED"));
                    });
            });
    }

    // --- Query.registrationLink / Query.passwordResetLink ---

    public DataFetcher<?> registrationLink() {
        return env -> tokenRepo.findByHash(hash(stringArgument(env, "token")), AccountTokenPurpose.REGISTRATION)
            .flatMap(row -> {
                String problem = linkProblem(row);
                if (problem != null) {
                    return Mono.just(tokenCheck(problem, null, null, null, null));
                }
                boolean lecturer = row.lecturerId() != null;
                Long personId = lecturer ? row.lecturerId() : row.studentId();
                // Everything completeRegistration would refuse for, asked now rather than after a
                // password has been chosen. A form that cannot succeed should not be on screen: the
                // account may have been created some other way, or the person claimed by another
                // account, in the thirty minutes since the link was sent.
                return permissionRepo.findUserByEmail(row.email())
                    .map(taken -> tokenCheck("UNAVAILABLE", null, null, null, null))
                    .switchIfEmpty(Mono.defer(() -> tokenRepo.personHasAccount(lecturer, personId).flatMap(claimed -> {
                        if (Boolean.TRUE.equals(claimed)) {
                            return Mono.just(tokenCheck("UNAVAILABLE", null, null, null, null));
                        }
                        return tokenRepo.findPersonById(lecturer, personId)
                            .map(person -> tokenCheck("VALID", row.email(), person.firstName(), person.lastName(),
                                lecturer ? "LECTURER" : "STUDENT"))
                            // The person was deleted inside the thirty minutes: the link names
                            // nobody, and "invalid" is the truthful answer rather than a
                            // half-filled form.
                            .switchIfEmpty(Mono.just(tokenCheck("NOT_FOUND", null, null, null, null)));
                    })));
            })
            .switchIfEmpty(Mono.just(tokenCheck("NOT_FOUND", null, null, null, null)))
            .toFuture();
    }

    public DataFetcher<?> passwordResetLink() {
        return env -> tokenRepo.findByHash(hash(stringArgument(env, "token")), AccountTokenPurpose.PASSWORD_RESET)
            .flatMap(row -> {
                String problem = linkProblem(row);
                if (problem != null) {
                    return Mono.just(tokenCheck(problem, null, null, null, null));
                }
                return permissionRepo.findUserById(row.userId())
                    // Deactivated inside the thirty minutes: resetPassword would refuse, so the
                    // form is not offered. Access somebody took away on purpose is not given back
                    // by remembering an e-mail.
                    .map(user -> user.active()
                        ? tokenCheck("VALID", user.email(), user.firstName(), user.lastName(), null)
                        : tokenCheck("UNAVAILABLE", null, null, null, null))
                    .switchIfEmpty(Mono.just(tokenCheck("NOT_FOUND", null, null, null, null)));
            })
            .switchIfEmpty(Mono.just(tokenCheck("NOT_FOUND", null, null, null, null)))
            .toFuture();
    }

    // --- Mutation.completeRegistration ---

    public DataFetcher<?> completeRegistration() {
        return env -> {
            String token = stringArgument(env, "token");
            String password = stringArgument(env, "password");
            return tokenRepo.findByHash(hash(token), AccountTokenPurpose.REGISTRATION)
                .flatMap(row -> {
                    String problem = tokenProblem(row);
                    if (problem != null) {
                        return Mono.just(sessionResult(false, null, problem));
                    }
                    if (!passwordAcceptable(password)) {
                        // Checked before the token is spent: a password two characters short is a
                        // typing mistake, and burning the link over it would mean a second e-mail.
                        return Mono.just(sessionResult(false, null, "WEAK_PASSWORD"));
                    }
                    boolean lecturer = row.lecturerId() != null;
                    Long personId = lecturer ? row.lecturerId() : row.studentId();
                    return permissionRepo.findUserByEmail(row.email())
                        .map(existing -> sessionResult(false, null, "ALREADY_REGISTERED"))
                        .switchIfEmpty(Mono.defer(() ->
                            tokenRepo.personHasAccount(lecturer, personId).flatMap(claimed -> {
                                if (Boolean.TRUE.equals(claimed)) {
                                    return Mono.just(sessionResult(false, null, "PERSON_ALREADY_LINKED"));
                                }
                                return createAccount(row, lecturer, personId, password);
                            })));
                })
                .switchIfEmpty(Mono.just(sessionResult(false, null, "INVALID_TOKEN")))
                .toFuture();
        };
    }

    /**
     * Spends the link and creates the account behind it, in that order.
     * <p>
     * The order is the concurrency argument. {@code markUsed} updates only a row whose
     * {@code used_at} is still null and reports how many rows that was, so two tabs submitting the
     * same link both reach here and exactly one of them gets 1 back. Doing it the other way round —
     * create, then mark — would let both create, and the loser would find out from a unique-index
     * violation on {@code users.email} rather than from a sentence.
     */
    private Mono<Map<String, Object>> createAccount(AccountTokenRepository.TokenRow row, boolean lecturer,
                                                     Long personId, String password) {
        // Hashed before the link is spent, not after. BCrypt is deliberately slow and can refuse
        // its input outright; doing it on this side of markUsed means a refusal costs nothing,
        // where on the other side it would leave a dead link and no account.
        String passwordHash = passwordEncoder.encode(password);
        return tokenRepo.markUsed(row.id()).flatMap(spent -> {
            if (spent == 0) {
                return Mono.just(sessionResult(false, null, "USED_TOKEN"));
            }
            return tokenRepo.findPersonById(lecturer, personId)
                .flatMap(person -> permissionRepo.insertUser(row.email(), person.firstName(), person.lastName(),
                        passwordHash,
                        lecturer ? personId : null, lecturer ? null : personId, false)
                    // Signed in as soon as the account exists. The alternative — "your account has
                    // been created, now sign in" — asks somebody to type a password they entered
                    // ten seconds ago into a form they were already past.
                    .map(userId -> sessionResult(true, jwtService.issueToken(userId), null)))
                .switchIfEmpty(Mono.just(sessionResult(false, null, "INVALID_TOKEN")))
                // Losing a race is the only integrity violation reachable here — while this link
                // was open, an account came into being some other way — but the two ways it can
                // happen call for different things from the reader. A clash on `users.email` means
                // "sign in with the account that has this address"; a clash on
                // users_unique_lecturer / users_unique_student means somebody else's account claims
                // *this person*, which only an administrator can untangle. AuthDataFetchers already
                // tells them apart by SQLSTATE for `setUserLink`, so the discrimination is reused
                // rather than written a second time.
                .onErrorResume(DataIntegrityViolationException.class,
                    e -> Mono.just(sessionResult(false, null,
                        "ALREADY_LINKED".equals(AuthDataFetchers.linkErrorStatus(e))
                            ? "PERSON_ALREADY_LINKED" : "ALREADY_REGISTERED")));
        });
    }

    // --- Mutation.resetPassword ---

    public DataFetcher<?> resetPassword() {
        return env -> {
            String token = stringArgument(env, "token");
            String password = stringArgument(env, "password");
            return tokenRepo.findByHash(hash(token), AccountTokenPurpose.PASSWORD_RESET)
                .flatMap(row -> {
                    String problem = tokenProblem(row);
                    if (problem != null) {
                        return Mono.just(sessionResult(false, null, problem));
                    }
                    if (!passwordAcceptable(password)) {
                        return Mono.just(sessionResult(false, null, "WEAK_PASSWORD"));
                    }
                    return permissionRepo.findUserById(row.userId())
                        .flatMap(user -> {
                            if (!user.active()) {
                                return Mono.just(sessionResult(false, null, "ACCOUNT_DISABLED"));
                            }
                            return tokenRepo.markUsed(row.id()).flatMap(spent -> {
                                if (spent == 0) {
                                    return Mono.just(sessionResult(false, null, "USED_TOKEN"));
                                }
                                // must_change_password is cleared as well as the password set: an
                                // account that was never opened because its temporary password went
                                // astray arrives here, and being made to change a password it has
                                // just chosen would be a loop.
                                return permissionRepo.updatePassword(user.id(), passwordEncoder.encode(password), false)
                                    .map(rows -> sessionResult(true, jwtService.issueToken(user.id()), null));
                            });
                        })
                        .switchIfEmpty(Mono.just(sessionResult(false, null, "INVALID_TOKEN")));
                })
                .switchIfEmpty(Mono.just(sessionResult(false, null, "INVALID_TOKEN")))
                .toFuture();
        };
    }

    // --- shared helpers ---

    /**
     * Why the link cannot be redeemed, as {@code AccountLinkErrorStatus} spells it — the enum the
     * two <em>mutations</em> answer with.
     */
    private String tokenProblem(AccountTokenRepository.TokenRow row) {
        if (row.usedAt() != null) return "USED_TOKEN";
        if (row.expired()) return "EXPIRED_TOKEN";
        return null;
    }

    /**
     * The same three states as {@link #tokenProblem}, named as {@code AccountLinkStatus} spells
     * them — the enum the two <em>queries</em> answer with.
     * <p>
     * Two enums for one distinction, and therefore two methods: the queries report on a link and
     * the mutations report on an attempt to spend one, so {@code AccountLinkErrorStatus} carries
     * {@code WEAK_PASSWORD} and {@code ALREADY_REGISTERED} as well, which are nothing a link can be.
     * Feeding a mutation's spelling to a query field is not a mismatch a schema can catch: it is a
     * string that no value of the declared enum equals, and graphql-java refuses to serialize it at
     * the moment somebody's thirty minutes have just run out.
     */
    private String linkProblem(AccountTokenRepository.TokenRow row) {
        if (row.usedAt() != null) return "USED";
        if (row.expired()) return "EXPIRED";
        return null;
    }

    /**
     * Long enough to be worth having and short enough for BCrypt to hash all of it. Both bounds
     * answer {@code WEAK_PASSWORD}, because from the form's point of view they are one message
     * about the length of what was typed.
     */
    private boolean passwordAcceptable(String password) {
        return password.length() >= MIN_PASSWORD_LENGTH
            && password.getBytes(StandardCharsets.UTF_8).length <= MAX_PASSWORD_BYTES;
    }

    /** 32 bytes of {@link SecureRandom}, base64url — 43 characters, and no character a URL minds. */
    private String newToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return TOKEN_ENCODER.encodeToString(bytes);
    }

    /**
     * The form a token is stored and looked up in: SHA-256, lowercase hex. Not BCrypt, and
     * deliberately: BCrypt is slow by design so that a stolen password file resists guessing, and a
     * lookup key has to be *computed from the input* rather than compared against every row. What
     * makes the plaintext unguessable here is that it is 256 bits of {@link SecureRandom}, not that
     * the hash is expensive.
     */
    static String hash(String token) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is required of every Java implementation; if it is missing, nothing here works.
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private String normalize(Object rawEmail) {
        return rawEmail == null ? "" : rawEmail.toString().trim();
    }

    private String stringArgument(DataFetchingEnvironment env, String name) {
        Object raw = env.getArgument(name);
        return raw == null ? "" : raw.toString();
    }

    private Map<String, Object> registrationRequestResult(String status, String role) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isSuccess", "LINK_SENT".equals(status));
        m.put("status", status);
        m.put("role", role);
        m.put("expiresInMinutes", ttlMinutes);
        return m;
    }

    private Map<String, Object> simpleStatusResult(String status) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isSuccess", "LINK_SENT".equals(status));
        m.put("status", status);
        m.put("expiresInMinutes", ttlMinutes);
        return m;
    }

    private Map<String, Object> tokenCheck(String status, String email, String firstName, String lastName, String role) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isValid", "VALID".equals(status));
        m.put("status", status);
        m.put("email", email);
        m.put("firstName", firstName);
        m.put("lastName", lastName);
        m.put("role", role);
        return m;
    }

    /** The shape both redemptions answer with: a session, or the reason there isn't one. */
    private Map<String, Object> sessionResult(boolean success, String token, String errorStatus) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isSuccess", success);
        m.put("token", token);
        m.put("errorStatus", errorStatus);
        return m;
    }
}
