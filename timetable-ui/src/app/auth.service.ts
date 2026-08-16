import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, finalize, forkJoin, map, of, shareReplay, switchMap, tap, throwError } from 'rxjs';
import { GraphqlService } from './graphql.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { AccessNeed, GLOBAL_RESOURCE_TYPE, isRowNeed } from './access-need';

export interface CurrentGroup {
  id: string;
  name: string;
  description: string | null;
}

export interface PermissionGrant {
  id: string;
  granteeType: 'USER' | 'GROUP';
  resourceType: string;
  resourceId: string | null;
  /** What the grantee may do inside the scope — and inside everything below it. */
  level: AccessLevel;
  resourceLabel: string | null;
  /**
   * Only set by `grantsForResource`: the grant sits on an ancestor of the resource being inspected
   * (or is university-wide) rather than on that resource itself, so it is shown as context and
   * cannot be revoked from there.
   */
  inherited?: boolean;
}

export interface CurrentUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  mustChangePassword: boolean;
  isAdmin: boolean;
  /** `users.lecturer_id` — set when this account *is* a lecturer. */
  lecturerId: string | null;
  /** `users.student_id` — set when this account *is* a student. Never set together with the above. */
  studentId: string | null;
  groups: CurrentGroup[];
  permissions: PermissionGrant[];
  /** The university-wide level this account holds, or null. `MANAGE` is what `isAdmin` means. */
  globalLevel: AccessLevel | null;
  /**
   * The entity types this account could create something of *somewhere*, computed by the service from
   * its grants and the `@PermissionParent` cascade (see `Query.accessModel`). A type-level answer —
   * "possible somewhere", not "possible here" — which is exactly what deciding whether to draw a
   * button or a whole screen needs, and which the client cannot work out for itself without keeping
   * its own copy of the hierarchy.
   */
  creatableResourceTypes: string[];
}

/** One upward foreign key of the published cascade — see `Query.accessModel`. */
export interface ResourceParent {
  resourceType: string;
  /** The input field carrying this parent's id: `faculty_id` is sent as `facultyId`. */
  field: string;
  isNullable: boolean;
}

/** One entity type of the published cascade. */
export interface ResourceTypeAccess {
  resourceType: string;
  parents: ResourceParent[];
  joinParentResourceTypes: string[];
  /** Declared `@PermissionRoot`: nothing owns it, so only a `GLOBAL` grant reaches it. */
  isRoot: boolean;
}

/** Which person, if any, the signed-in account belongs to — what «Мій кабінет» renders itself from. */
export type PersonLink = 'lecturer' | 'student' | null;

/**
 * The two things a one-time e-mailed link can be: the link that creates the account of a викладач or
 * a студент the institution has already entered, and the link that replaces a forgotten password.
 * One word rather than two component names, because the two screens are the same screen — a form
 * that asks for an address, and a form that sets a password — differing only in what they say.
 */
export type AccountLinkKind = 'register' | 'reset';

/** `Mutation.requestRegistration`'s answer — see the service's `RegistrationRequestStatus`. */
export type RegistrationRequestStatus =
  | 'LINK_SENT'
  | 'ALREADY_REGISTERED'
  | 'PERSON_ALREADY_LINKED'
  | 'NOT_ELIGIBLE'
  | 'TOO_MANY_REQUESTS'
  | 'MAIL_FAILED';

/** `Mutation.requestPasswordReset`'s answer. */
export type PasswordResetRequestStatus =
  | 'LINK_SENT'
  | 'UNKNOWN_EMAIL'
  | 'ACCOUNT_DISABLED'
  | 'TOO_MANY_REQUESTS'
  | 'MAIL_FAILED';

/** What a link is worth when the page carrying it opens. */
export type AccountLinkStatus = 'VALID' | 'NOT_FOUND' | 'EXPIRED' | 'USED' | 'UNAVAILABLE';

/** Why redeeming one failed. */
export type AccountLinkErrorStatus =
  | 'INVALID_TOKEN'
  | 'EXPIRED_TOKEN'
  | 'USED_TOKEN'
  | 'WEAK_PASSWORD'
  | 'ALREADY_REGISTERED'
  | 'PERSON_ALREADY_LINKED'
  | 'ACCOUNT_DISABLED';

export interface RegistrationRequestResult {
  isSuccess: boolean;
  status: RegistrationRequestStatus;
  /** Which kind of person the link went to; set only with `LINK_SENT`. */
  role: 'LECTURER' | 'STUDENT' | null;
  expiresInMinutes: number | null;
}

export interface PasswordResetRequestResult {
  isSuccess: boolean;
  status: PasswordResetRequestStatus;
  expiresInMinutes: number | null;
}

/** What the service says about a link before it is spent — whose it is, and whether it still works. */
export interface AccountLinkCheck {
  isValid: boolean;
  status: AccountLinkStatus;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: 'LECTURER' | 'STUDENT' | null;
}

export interface AccountLinkResult {
  isSuccess: boolean;
  token: string | null;
  errorStatus: AccountLinkErrorStatus | null;
}

/** The root field that inspects each kind of link, and the one that spends it. */
const LINK_QUERY_FIELD: Record<AccountLinkKind, string> = {
  register: 'registrationLink',
  reset: 'passwordResetLink'
};
const LINK_MUTATION_FIELD: Record<AccountLinkKind, string> = {
  register: 'completeRegistration',
  reset: 'resetPassword'
};

/**
 * Why a session ended without the user asking it to — the values of the backend's `AuthFailure`
 * enum, carried on the `X-Auth-Error` header and in `extensions.authError` of an `UNAUTHENTICATED`
 * GraphQL error, plus whatever the client works out on its own from the token's `exp` claim.
 */
export type SessionEndReason = 'TOKEN_EXPIRED' | 'INVALID_TOKEN' | 'ACCOUNT_DISABLED';

/** What the login page says about each of them. */
export const SESSION_END_MESSAGES: Record<SessionEndReason, string> = {
  TOKEN_EXPIRED: 'Термін дії сеансу минув. Будь ласка, увійдіть повторно.',
  INVALID_TOKEN: 'Сеанс недійсний. Будь ласка, увійдіть повторно.',
  ACCOUNT_DISABLED: 'Обліковий запис недоступний. Зверніться до адміністратора системи.'
};

const TOKEN_KEY = 'lnu_timetable_token';

/**
 * Treat a token as spent this long before its own `exp`. Covers the flight time of the request it
 * would be attached to and a second or two of clock disagreement between browser and server —
 * without it, a token that passes the check here can still be rejected on arrival.
 */
const EXPIRY_SKEW_MS = 5_000;

/** `setTimeout` truncates anything past a signed 32-bit millisecond delay, so long waits re-arm. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The `exp` claim of a JWT as epoch milliseconds, or null when the token carries none or cannot be
 * read. Nothing here is a security check — the signature is verified by the service and only by the
 * service. This reads the one claim that lets the client stop pretending it still has a session:
 * the payload is base64url with its padding stripped, and is decoded as UTF-8 rather than through
 * `atob` alone so a claim outside ASCII could not corrupt the parse.
 */
function tokenExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return typeof claims?.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Whether `token` is past its `exp` (minus the skew allowance). A token with no `exp` never is. */
function isExpired(token: string): boolean {
  const expiresAt = tokenExpiresAt(token);
  return expiresAt !== null && Date.now() >= expiresAt - EXPIRY_SKEW_MS;
}

/**
 * Session state + permission lookups for the whole app, mirroring how `GraphqlService` is used:
 * a single root-provided service injected via `inject()` wherever it's needed. The JWT is kept in
 * localStorage (attached to every GraphQL request by `authInterceptor`); everything else about the
 * signed-in user (admin flag, group memberships, permission grants) is re-fetched from `Query.me`
 * rather than decoded from the token, so revoking access takes effect the moment the page reloads
 * or `refreshMe()` is called again.
 *
 * ## When the token expires
 *
 * The service issues a token that lives for `app.security.jwt-ttl-minutes` (12 hours by default),
 * and a tab left open outlives it easily. Three independent things now end the session rather than
 * leaving the user on a screen whose every request fails:
 *
 * 1. **On load and before every request** — a stored token past its `exp` is dropped instead of
 *    sent (`tokenForRequest()`), so `isAuthenticated()` is false the moment it matters and
 *    `authGuard` routes to `/login` on the next navigation.
 * 2. **On a timer** — `armExpiryTimer()` fires at the moment the current token dies, so an idle tab
 *    that makes no request at all still returns to the login page instead of showing a stale
 *    «Мій кабінет» indefinitely.
 * 3. **On the server's word** — `authInterceptor` watches every response for the `X-Auth-Error`
 *    header or an `UNAUTHENTICATED` GraphQL error and calls `endSession()`. This is the one that
 *    catches what the client cannot know by itself: a revoked signing key, a clock that disagrees,
 *    or an account deactivated mid-session.
 *
 * All three converge on `clearSession()`, which records *why* in `sessionEndReason` so the login
 * page can say so rather than presenting an unexplained empty form.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private gql = inject(GraphqlService);
  private router = inject(Router);

  token = signal<string | null>(null);
  currentUser = signal<CurrentUser | null>(null);

  /** Why the last session ended, when it ended on its own; cleared by an explicit sign-out or sign-in. */
  sessionEndReason = signal<SessionEndReason | null>(null);

  isAuthenticated = computed(() => this.token() !== null);
  isAdmin = computed(() => this.currentUser()?.isAdmin ?? false);

  /**
   * The caller's university-wide level, if they hold a GLOBAL grant. `MANAGE` is what `isAdmin`
   * means; `EDIT` or `FULL` is somebody trusted with everything except handing out access.
   */
  globalLevel = computed<AccessLevel | null>(() => {
    const user = this.currentUser();
    if (!user) return null;
    // Answered by the service now (`CurrentUser.globalLevel`). The scan of `permissions` behind it is
    // the same answer computed the old way, kept so a client running against a service that predates
    // the field still gates correctly rather than silently treating everybody as having nothing.
    return user.globalLevel ?? user.permissions?.find((p) => p.resourceType === 'GLOBAL')?.level ?? null;
  });

  /**
   * The entity types this account could create something of somewhere — the answer behind every
   * «+ Додати» and every screen that exists only to add rows.
   *
   * It replaced «holds at least one grant anywhere», which is how a викладач whose grant was a single
   * кафедра was shown «+ Додати корпус»: a button that opened a form whose mutation the service was
   * always going to refuse with «Creating a Building here requires EDIT access.» The set comes from
   * the service, computed from the same annotation graph that authorizes the write, so adding an
   * entity keeps it correct with no edit here.
   */
  creatableTypes = computed<ReadonlySet<string>>(
    () => new Set(this.currentUser()?.creatableResourceTypes ?? [])
  );

  /**
   * Whether this account can delegate access *somewhere* — it holds MANAGE on at least one resource,
   * or university-wide. What draws the «Групи користувачів» link, since administering a group needs
   * MANAGE over everything that group can reach and nobody without MANAGE anywhere can qualify.
   *
   * A type-level guess of the same kind as `canCreateType`: it decides whether a link is worth
   * drawing, never whether an act is allowed. Which groups this account may actually administer is
   * `manageableGroups`, answered by the service against the group's own grants.
   */
  canDelegate = computed(() =>
    (this.currentUser()?.permissions ?? []).some((grant) => grant.level === 'MANAGE'));

  mustChangePassword = computed(() => this.currentUser()?.mustChangePassword ?? false);

  /**
   * Whether the app shell has anywhere to take the user — what `app.html` gates the sidebar on.
   *
   * Deliberately stricter than `isAuthenticated()`, which is true in two states where a navigation
   * menu is a lie: while `Query.me` is still in flight (a token exists, nothing is known about its
   * owner yet, and every link would render before the permissions that decide what to show), and
   * throughout the forced change-password screen, where `authGuard` bounces every one of those
   * links straight back. Both resolve within a request, but a menu that appears and then refuses to
   * work is worse than one that waits.
   */
  canNavigate = computed(() => this.currentUser() !== null && !this.mustChangePassword());

  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored === null) {
      return;
    }
    // A tab closed yesterday and reopened today starts here: the token is still in localStorage,
    // and used to be trusted purely because it was there.
    if (isExpired(stored)) {
      localStorage.removeItem(TOKEN_KEY);
      this.sessionEndReason.set('TOKEN_EXPIRED');
      return;
    }
    this.token.set(stored);
    this.armExpiryTimer(stored);
  }

  /**
   * Whether this account is a lecturer's, a student's, or nobody's in particular — read from
   * `users.lecturer_id` / `users.student_id`, at most one of which the database allows to be set.
   *
   * It is deliberately *not* a permission: a linked account still edits exactly what its grants
   * allow, and an unlinked administrator still sees every timetable through the faculty and
   * department pages. All this decides is whether «Мій кабінет» has anything to show — which is why
   * the sidebar link is hidden when it does not.
   */
  personLink = computed<PersonLink>(() => {
    const u = this.currentUser();
    if (u?.lecturerId) return 'lecturer';
    if (u?.studentId) return 'student';
    return null;
  });

  hasPersonLink = computed(() => this.personLink() !== null);

  /**
   * Cache of resourceType -> (id -> level, or null for "no access") so list views don't re-query on
   * every render. `null` is cached as deliberately as a level is: "this row is not yours" is an
   * answer worth remembering, and without it every re-render re-asked about every row the user
   * cannot touch — which, on a faculty page seen by a visitor, is all of them.
   */
  private accessCache = new Map<string, Map<string, AccessLevel | null>>();

  login(email: string, password: string): Observable<{ isSuccess: boolean; errorStatus?: string; mustChangePassword?: boolean }> {
    // Sign-in is an unauthenticated operation, and a token left over from the session that just
    // ended would only make the service report *its* failure on this response. Drop it first.
    this.clearSession(null);

    const q = `mutation($email: String!, $password: String!) {
      login(email: $email, password: $password) { isSuccess token mustChangePassword errorStatus }
    }`;
    return this.gql.request<{ login: any }>(q, { email, password }).pipe(
      tap((d) => {
        if (d.login.isSuccess) {
          this.setToken(d.login.token);
        }
      }),
      map((d) => d.login)
    );
  }

  /** Signing out on purpose: no reason to report, because the user knows why. */
  logout() {
    this.clearSession(null);
  }

  /**
   * Ends the session because it can no longer be used, records why, and returns to the login page
   * from wherever the user happened to be. Called by `authInterceptor` when the service reports the
   * failure, and by the expiry timer when the client works it out first.
   */
  endSession(reason: SessionEndReason) {
    if (!this.isAuthenticated()) {
      return; // nothing to end: an anonymous request was refused, or another response got here first
    }
    this.clearSession(reason);
    const current = this.router.url;
    if (!current.startsWith('/login')) {
      this.router.navigate(['/login'], { queryParams: { redirectTo: current } });
    }
  }

  /** Drops every trace of the session without navigating; `reason` is what the login page will say. */
  clearSession(reason: SessionEndReason | null) {
    this.setToken(null);
    this.currentUser.set(null);
    this.accessCache.clear();
    this.sessionEndReason.set(reason);
  }

  /**
   * The token to attach to an outgoing request, or null. A stored token already past its `exp` is
   * not sent — it would come back rejected — and ends the session on the way out instead.
   */
  tokenForRequest(): string | null {
    const token = this.token();
    if (token === null) return null;
    if (isExpired(token)) {
      this.endSession('TOKEN_EXPIRED');
      return null;
    }
    return token;
  }

  private setToken(token: string | null) {
    this.token.set(token);
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      this.armExpiryTimer(token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      this.clearExpiryTimer();
    }
  }

  /**
   * Schedules the end of the session for the moment the current token dies, so a tab nobody touches
   * does not keep showing data it can no longer refresh. Re-arms rather than firing early if the
   * wait exceeds what `setTimeout` can express, and re-checks the token when it fires instead of
   * trusting the delay — a laptop asleep across the expiry wakes with the timer late, not skipped.
   */
  private armExpiryTimer(token: string) {
    this.clearExpiryTimer();
    const expiresAt = tokenExpiresAt(token);
    if (expiresAt === null) return;

    const remaining = expiresAt - EXPIRY_SKEW_MS - Date.now();
    const leg = Math.min(Math.max(remaining, 0), MAX_TIMEOUT_MS);
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      const current = this.token();
      if (current === null) return;
      if (isExpired(current)) this.endSession('TOKEN_EXPIRED');
      else this.armExpiryTimer(current);
    }, leg);
  }

  private clearExpiryTimer() {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /** Re-fetches Query.me; call after login and on app bootstrap when a token is already stored. */
  /**
   * The `me` request in flight, if there is one.
   *
   * Angular runs a route's `canActivate` guards *concurrently*, not in sequence, so on a cold load
   * `authGuard` and `adminGuard` both reach for the profile in the same tick. Without this they
   * would send two identical queries and race to write the same signal. One request, shared.
   */
  private meInFlight: Observable<CurrentUser | null> | null = null;

  refreshMe(): Observable<CurrentUser | null> {
    if (this.meInFlight) return this.meInFlight;
    const q = `{ me { id email firstName lastName mustChangePassword isAdmin lecturerId studentId
      globalLevel creatableResourceTypes
      groups { id name description }
      permissions { id granteeType resourceType resourceId level resourceLabel }
    } }`;
    this.meInFlight = this.gql.request<{ me: CurrentUser | null }>(q).pipe(
      tap((d) => this.currentUser.set(d.me)),
      map((d) => d.me),
      finalize(() => { this.meInFlight = null; }),
      shareReplay({ bufferSize: 1, refCount: false })
    );
    return this.meInFlight;
  }

  /**
   * Asks for a registration link. The service answers with which of four things is true of this
   * address — an account already has it, a викладач carries it, a студент carries it, or nobody
   * does — and only the middle two send an e-mail. Nothing here needs a session.
   */
  requestRegistration(email: string): Observable<RegistrationRequestResult> {
    const q = `mutation($email: String!) {
      requestRegistration(email: $email) { isSuccess status role expiresInMinutes }
    }`;
    return this.gql
      .request<{ requestRegistration: RegistrationRequestResult }>(q, { email })
      .pipe(map((d) => d.requestRegistration));
  }

  /** Asks for a password-recovery link, for an address that already has an account. */
  requestPasswordReset(email: string): Observable<PasswordResetRequestResult> {
    const q = `mutation($email: String!) {
      requestPasswordReset(email: $email) { isSuccess status expiresInMinutes }
    }`;
    return this.gql
      .request<{ requestPasswordReset: PasswordResetRequestResult }>(q, { email })
      .pipe(map((d) => d.requestPasswordReset));
  }

  /**
   * What a link is worth, asked when the page carrying it opens and before anything is typed into
   * it. A link that has expired or has already been used should say so on arrival rather than after
   * somebody has chosen a password and pressed the button.
   *
   * The field name is chosen here rather than sent as a variable because it is a *field*, not a
   * value: the two queries differ in what they ask for, not in what they carry. Everything the
   * document carries — the token — is still a variable.
   */
  accountLink(kind: AccountLinkKind, token: string): Observable<AccountLinkCheck> {
    const field = LINK_QUERY_FIELD[kind];
    const q = `query($token: String!) {
      ${field}(token: $token) { isValid status email firstName lastName role }
    }`;
    return this.gql
      .request<Record<string, AccountLinkCheck>>(q, { token })
      .pipe(map((d) => d[field]));
  }

  /**
   * Spends the link: creates the account, or replaces the password. Either way the service hands
   * back a token, so the person is signed in on the screen where they chose their password rather
   * than being sent to the login form to type it again.
   *
   * The stored session, if any, is dropped first for the same reason `login` drops it: this is an
   * unauthenticated operation, and a leftover token would only make the service report *its*
   * failure on this response.
   */
  redeemAccountLink(kind: AccountLinkKind, token: string, password: string): Observable<AccountLinkResult> {
    this.clearSession(null);
    const field = LINK_MUTATION_FIELD[kind];
    const q = `mutation($token: String!, $password: String!) {
      ${field}(token: $token, password: $password) { isSuccess token errorStatus }
    }`;
    return this.gql.request<Record<string, AccountLinkResult>>(q, { token, password }).pipe(
      map((d) => d[field]),
      tap((res) => {
        if (res.isSuccess && res.token) {
          this.adoptSession(res.token);
        }
      })
    );
  }

  /**
   * Takes over a session issued by something other than `login` — today, by redeeming a
   * registration or password-recovery link. Identical to what `login` does with its own token, and
   * separate from it only because the caller reached the same place by a different road.
   */
  adoptSession(token: string) {
    this.sessionEndReason.set(null);
    this.setToken(token);
  }

  changePassword(currentPassword: string, newPassword: string): Observable<{ isSuccess: boolean; errorStatus?: string }> {
    const q = `mutation($currentPassword: String!, $newPassword: String!) {
      changePassword(currentPassword: $currentPassword, newPassword: $newPassword) { isSuccess errorStatus }
    }`;
    return this.gql.request<{ changePassword: any }>(q, { currentPassword, newPassword }).pipe(
      tap((d) => {
        if (d.changePassword.isSuccess) {
          this.currentUser.update((u) => (u ? { ...u, mustChangePassword: false } : u));
        }
      }),
      map((d) => d.changePassword)
    );
  }

  /**
   * The current user's access level on each of `ids` (all of the given `resourceType`), backed by a
   * per-resourceType cache so re-rendering a list already checked doesn't re-query. Callers (see
   * `BaseEntity`) should call this once after loading a list's rows.
   *
   * Rows the user cannot reach at all are simply absent from the returned map. This replaced a
   * yes/no `canModifyIds`: a boolean could not say whether the Delete button next to Edit should
   * be there too, so every page drew both or neither.
   */
  accessLevels(resourceType: string, ids: string[]): Observable<Map<string, AccessLevel>> {
    const cache = this.accessCache.get(resourceType) ?? new Map<string, AccessLevel | null>();
    this.accessCache.set(resourceType, cache);
    const uncached = ids.filter((id) => !cache.has(id));

    const collect = () => {
      const result = new Map<string, AccessLevel>();
      for (const id of ids) {
        const level = cache.get(id);
        if (level) result.set(id, level);
      }
      return result;
    };

    if (uncached.length === 0) {
      return new Observable((sub) => {
        sub.next(collect());
        sub.complete();
      });
    }

    const q = `query($resourceType: String!, $resourceIds: [ID!]!) {
      accessLevels(resourceType: $resourceType, resourceIds: $resourceIds) { id level }
    }`;
    return this.gql
      .request<{ accessLevels: { id: string; level: AccessLevel }[] }>(q, { resourceType, resourceIds: uncached })
      .pipe(
        map((d) => {
          const granted = new Map(d.accessLevels.map((a) => [String(a.id), a.level] as const));
          for (const id of uncached) cache.set(id, granted.get(id) ?? null);
          return collect();
        })
      );
  }

  /** Convenience for the many pages that ask about exactly one row. */
  accessLevel(resourceType: string, id: string): Observable<AccessLevel | null> {
    return this.accessLevels(resourceType, [id]).pipe(map((levels) => levels.get(id) ?? null));
  }

  /** Whether a level held (as returned above) is enough for a given action. */
  allows = allows;

  /**
   * Could this account create something of `resourceType` somewhere? Synchronous, because it is
   * answered from `Query.me`, which every guarded route has already resolved — a sidebar link cannot
   * wait for a round trip to decide whether to exist.
   *
   * A university-wide `EDIT` covers every type, including the two roots (`BUILDING`,
   * `ACADEMIC_DEGREE`) that no other grant can reach.
   */
  canCreateType(resourceType: string): boolean {
    if (resourceType === GLOBAL_RESOURCE_TYPE) return allows(this.globalLevel(), 'EDIT');
    return allows(this.globalLevel(), 'EDIT') || this.creatableTypes().has(resourceType);
  }

  /**
   * Whether this account holds a grant naming a row of `resourceType` directly — the second half of
   * "is this screen worth a link". Somebody granted one single `ClassStartTimeSet` can create no
   * other, so {@link canCreateType} says no, and hiding the screen would hide the one row they
   * maintain.
   */
  holdsGrantOfType(resourceType: string): boolean {
    return (this.currentUser()?.permissions ?? []).some((p) => p.resourceType === resourceType);
  }

  /**
   * Whether a screen about `resourceType` has anything to offer this account: something to add, or
   * something already theirs to edit. What the sidebar hides a link on, and what the standalone
   * generic tables refuse themselves with.
   */
  canReachType(resourceType: string): boolean {
    return this.canCreateType(resourceType) || this.holdsGrantOfType(resourceType);
  }

  /**
   * The published permission cascade (`Query.accessModel`), fetched at most once per session.
   *
   * It is constant for the lifetime of the service — it is derived from annotations at startup — so
   * one request answers every question that needs it, and the `shareReplay` means the four callers
   * that ask during a first paint send one query between them.
   */
  private accessModelRequest: Observable<ResourceTypeAccess[]> | null = null;

  accessModel(): Observable<ResourceTypeAccess[]> {
    if (!this.accessModelRequest) {
      const q = `{ accessModel { resourceType isRoot joinParentResourceTypes parents { resourceType field isNullable } } }`;
      this.accessModelRequest = this.gql.request<{ accessModel: ResourceTypeAccess[] }>(q).pipe(
        map((d) => d.accessModel),
        // A `shareReplay` that has seen an error replays *the error* to everyone who asks afterwards,
        // and this handle is held for the life of the session — so one lost request would have hidden
        // every «+ Додати» from an administrator until they reloaded the page. Forgetting the failed
        // attempt makes the next caller retry instead.
        catchError((e) => { this.accessModelRequest = null; return throwError(() => e); }),
        shareReplay({ bufferSize: 1, refCount: false })
      );
    }
    return this.accessModelRequest;
  }

  /**
   * The level this account would have over a row of `resourceType` created with `input` — the highest
   * it holds over any parent the new row names.
   *
   * This is `PermissionEvaluator#levelForNew` on the client, reading the same graph off
   * `Query.accessModel` rather than re-stating it: the fields that count are exactly the entity's
   * foreign-key parents, because nothing points at a row that does not exist yet. An input naming
   * none of them has no covering scope, so only a `GLOBAL` grant creates it — which is why a Room
   * belonging to no building and no faculty is a university-wide object on both sides.
   */
  levelForNew(resourceType: string, input: Record<string, unknown>): Observable<AccessLevel | null> {
    return this.accessModel().pipe(
      switchMap((model) => {
        const node = model.find((n) => n.resourceType === resourceType);
        const named = (node?.parents ?? [])
          .map((parent) => ({ type: parent.resourceType, id: input[parent.field] }))
          .filter((p) => p.id !== undefined && p.id !== null && p.id !== '')
          .map((p) => ({ type: p.type, id: String(p.id) }));
        if (named.length === 0) return of(this.globalLevel());
        return forkJoin(named.map((p) => this.accessLevel(p.type, p.id))).pipe(
          map((levels) => levels.reduce<AccessLevel | null>((best, l) => maxLevel(best, l), this.globalLevel()))
        );
      })
    );
  }

  /**
   * Does this account meet `need`? The one place the three shapes of {@link AccessNeed} are turned
   * into an answer, so that a page, the tab that opens it and the sidebar link that leads to it are
   * all gated by the same evaluation rather than by three that were written to agree.
   */
  resolveNeed(need: AccessNeed): Observable<boolean> {
    const required = need.level ?? 'EDIT';
    if (!this.currentUser()) return of(false);
    if (need.type === GLOBAL_RESOURCE_TYPE) return of(allows(this.globalLevel(), required));
    if ('id' in need && !need.id) {
      // A row was named and its id is not here yet — a signal still resolving, a route param not
      // parsed. Answering the weaker "anywhere of this kind" question instead would fail *open*:
      // somebody holding a grant on a different faculty would be shown this one's editors for as
      // long as the id took to arrive.
      return of(false);
    }
    if (!isRowNeed(need)) {
      // No row to ask about: the question is whether this kind of thing is within reach at all —
      // something of the kind to add, or something of it already this account's to edit. Only EDIT
      // is meaningful here; «may I delete some room somewhere» is not a question any screen asks,
      // and answering it would need a row.
      return of(this.canReachType(need.type));
    }
    return this.accessLevel(need.type, String(need.id)).pipe(
      map((level) => allows(maxLevel(this.globalLevel(), level), required))
    );
  }

  /** Invalidate the cached access levels (e.g. after a grantPermission/revokePermission mutation). */
  clearAccessCache() {
    this.accessCache.clear();
  }
}
