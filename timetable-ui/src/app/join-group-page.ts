import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';

type InvitationStatus = 'VALID' | 'NOT_FOUND' | 'EXPIRED';

interface InvitationCheck {
  isValid: boolean;
  status: InvitationStatus;
  groupId: string | null;
  groupName: string | null;
  isMember: boolean;
}

/**
 * The screen an invitation link opens: `/join/:token`.
 *
 * The token is a path segment rather than a query parameter for the same reason a registration
 * link's is — `FrontendController` matches each segment as `[^.]*`, and a base64url token contains
 * no dot, so a pasted or reloaded link reaches the Angular router instead of the static-resource
 * handler.
 *
 * **It requires a session, and that is the whole shape of the feature.** An invitation joins an
 * account to a group; it does not create one. A visitor who is not signed in is sent to `/login`
 * with `redirectTo` pointing back here, so signing in — or registering, if they are a викладач or a
 * студент the institution has entered — lands them back on this page with the link intact.
 *
 * **The link is checked before anything is pressed**, so «термін дії посилання минув» and «Ви вже
 * учасник цієї групи» are sentences on arrival rather than the result of a failed mutation.
 *
 * After joining, the profile is reloaded before navigating away: the account's permissions are the
 * union of its own grants and its groups', so what the sidebar and every screen may show has just
 * changed, and a stale `me` would leave the new member looking at the application they had before.
 */
@Component({
  selector: 'app-join-group-page',
  templateUrl: './join-group-page.html',
  imports: [RouterLink]
})
export class JoinGroupPage {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private gql = inject(GraphqlService);
  auth = inject(AuthService);

  private token = this.route.snapshot.paramMap.get('token') ?? '';

  /** null while the link is still being checked. */
  check = signal<InvitationCheck | null>(null);
  loadError = signal('');
  joining = signal(false);
  joined = signal<string | null>(null);
  error = signal('');

  /** What a link that cannot be used says, and what to do next. */
  problem = computed(() => {
    const c = this.check();
    if (!c || c.isValid) return null;
    return c.status === 'EXPIRED'
      ? {
          title: 'Термін дії посилання минув.',
          detail: 'Попросіть того, хто його надіслав, створити нове.'
        }
      : {
          title: 'Посилання недійсне.',
          detail: 'Перевірте, чи скопійовано його повністю. Можливо, його вже видалено.'
        };
  });

  constructor() {
    if (!this.token) {
      this.check.set({ isValid: false, status: 'NOT_FOUND', groupId: null, groupName: null, isMember: false });
      return;
    }
    const query = `query($token: String!) {
      groupInvitation(token: $token) { isValid status groupId groupName isMember }
    }`;
    this.gql.request<{ groupInvitation: InvitationCheck }>(query, { token: this.token }).subscribe({
      next: (d) => this.check.set(d.groupInvitation),
      error: (e) => this.loadError.set(e.message)
    });
  }

  join() {
    this.error.set('');
    this.joining.set(true);
    const mutation = `mutation($token: String!) {
      joinGroupByInvitation(token: $token) { isSuccess groupId groupName errorStatus }
    }`;
    this.gql
      .request<{ joinGroupByInvitation: { isSuccess: boolean; groupName: string | null; errorStatus: string | null } }>(
        mutation, { token: this.token })
      .subscribe({
        next: (d) => {
          this.joining.set(false);
          const res = d.joinGroupByInvitation;
          if (res.isSuccess) {
            this.joined.set(res.groupName ?? this.check()?.groupName ?? '');
            // The session's grants have just changed — this account is now in a group, and its
            // effective access is the union of its own grants and its groups'. Both halves of the
            // client's picture have to be rebuilt: `me` for the sidebar and everything gated on
            // `creatableResourceTypes`, and the per-row cache behind `accessLevel(type, id)`, which
            // would otherwise keep answering «no» for every row already looked at. `ResourceAccessPanel`
            // clears it after granting or revoking for exactly this reason; joining a group is the
            // third way a caller's own access changes under them.
            this.auth.clearAccessCache();
            this.auth.refreshMe().subscribe();
            return;
          }
          switch (res.errorStatus) {
            case 'ALREADY_MEMBER':
              this.check.update((c) => (c ? { ...c, isMember: true } : c));
              return;
            case 'EXPIRED_TOKEN':
              this.check.set({ isValid: false, status: 'EXPIRED', groupId: null, groupName: null, isMember: false });
              return;
            case 'INVALID_TOKEN':
              this.check.set({ isValid: false, status: 'NOT_FOUND', groupId: null, groupName: null, isMember: false });
              return;
            default:
              this.error.set('Не вдалося приєднатися. Спробуйте ще раз.');
          }
        },
        error: (e) => { this.joining.set(false); this.error.set(e.message); }
      });
  }

  goHome() {
    void this.router.navigateByUrl('/');
  }
}
