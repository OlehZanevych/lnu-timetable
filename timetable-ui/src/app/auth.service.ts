import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { GraphqlService } from './graphql.service';

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
  resourceLabel: string | null;
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
}

/** Which person, if any, the signed-in account belongs to — what «Мій кабінет» renders itself from. */
export type PersonLink = 'lecturer' | 'student' | null;

const TOKEN_KEY = 'lnu_timetable_token';

/**
 * Session state + permission lookups for the whole app, mirroring how `GraphqlService` is used:
 * a single root-provided service injected via `inject()` wherever it's needed. The JWT is kept in
 * localStorage (attached to every GraphQL request by `authInterceptor`); everything else about the
 * signed-in user (admin flag, group memberships, permission grants) is re-fetched from `Query.me`
 * rather than decoded from the token, so revoking access takes effect the moment the page reloads
 * or `refreshMe()` is called again.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private gql = inject(GraphqlService);

  token = signal<string | null>(localStorage.getItem(TOKEN_KEY));
  currentUser = signal<CurrentUser | null>(null);

  isAuthenticated = computed(() => this.token() !== null);
  isAdmin = computed(() => this.currentUser()?.isAdmin ?? false);
  mustChangePassword = computed(() => this.currentUser()?.mustChangePassword ?? false);

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

  /** Cache of resourceType -> (id -> canModify) so list views don't re-query on every render. */
  private modifyCache = new Map<string, Map<string, boolean>>();

  login(email: string, password: string): Observable<{ isSuccess: boolean; errorStatus?: string; mustChangePassword?: boolean }> {
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

  logout() {
    this.setToken(null);
    this.currentUser.set(null);
    this.modifyCache.clear();
  }

  private setToken(token: string | null) {
    this.token.set(token);
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  /** Re-fetches Query.me; call after login and on app bootstrap when a token is already stored. */
  refreshMe(): Observable<CurrentUser | null> {
    const q = `{ me { id email firstName lastName mustChangePassword isAdmin lecturerId studentId
      groups { id name description }
      permissions { id granteeType resourceType resourceId resourceLabel }
    } }`;
    return this.gql.request<{ me: CurrentUser | null }>(q).pipe(
      tap((d) => this.currentUser.set(d.me)),
      map((d) => d.me)
    );
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
   * Returns which of `ids` (all of the given `resourceType`) the current user may modify, backed
   * by a per-resourceType cache so re-rendering a list already checked doesn't re-query. Callers
   * (see `BaseEntity`) should call this once after loading a list's rows.
   */
  canModifyIds(resourceType: string, ids: string[]): Observable<Set<string>> {
    const cache = this.modifyCache.get(resourceType) ?? new Map<string, boolean>();
    this.modifyCache.set(resourceType, cache);
    const uncached = ids.filter((id) => !cache.has(id));

    if (uncached.length === 0) {
      return new Observable((sub) => {
        sub.next(new Set(ids.filter((id) => cache.get(id))));
        sub.complete();
      });
    }

    const q = `query($resourceType: String!, $resourceIds: [ID!]!) {
      canModifyResources(resourceType: $resourceType, resourceIds: $resourceIds)
    }`;
    return this.gql.request<{ canModifyResources: string[] }>(q, { resourceType, resourceIds: uncached }).pipe(
      map((d) => {
        const allowed = new Set(d.canModifyResources.map(String));
        for (const id of uncached) cache.set(id, allowed.has(id));
        return new Set(ids.filter((id) => cache.get(id)));
      })
    );
  }

  /** Invalidate the cached modify-permission results (e.g. after a grantPermission/revokePermission mutation). */
  clearModifyCache() {
    this.modifyCache.clear();
  }
}
