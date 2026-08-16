import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { sectionNav } from './section-route';

type GroupSection = 'members' | 'invitations';

/** Which slugs `/user-group/:id/:section` recognises — see `section-route.ts`. */
const SECTION_KEYS: GroupSection[] = ['members', 'invitations'];

interface GroupMember {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}

interface UserGroup {
  id: string;
  name: string;
  description: string | null;
  members: GroupMember[];
}

interface Invitation {
  id: string;
  token: string;
  expiresAt: string;
  isExpired: boolean;
  joinCount: number;
  createdAt: string;
  createdByName: string | null;
}

/** What the lifetime chooser is worth in minutes — bounded by the service and by a CHECK. */
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 30 * 24 * 60;

/**
 * One group of users: who is in it, and the invitation links that let people put themselves in it.
 *
 * **Why this screen exists.** Membership is how access travels — a grant may name a group, so adding
 * an account to «Деканат ФПМіІ» is handing it the факультет. The only way to do that used to be two
 * text boxes on «Користувачі та права» into which the numeric id of a user and the numeric id of a
 * group were typed, by an administrator, one account at a time. That is survivable while the system
 * has four users and impossible during the weeks the university's data is being entered, which is
 * the moment the most accounts are created and the fewest of them belong to anyone with an id to
 * hand. This page is the group itself: its members, with a search over accounts rather than a number,
 * and «Посилання-запрошення» so that twenty volunteers can join without twenty visits here.
 *
 * **Who may open it.** Whoever `manageableGroups` names — an administrator, or somebody holding
 * MANAGE over every resource the group holds a grant on. That is the service's rule
 * (`GroupAdminPolicy`), asked rather than reproduced: this page does not read the caller's grants
 * and reason about them, it asks which groups they may administer and believes the answer. A group
 * reached by URL without that right renders «Немає доступу» rather than an empty table, because an
 * empty table reads as «ця група порожня».
 *
 * The open tab is a path segment (`/user-group/3/invitations`), like every other tabbed page here.
 */
@Component({
  selector: 'app-user-group-page',
  templateUrl: './user-group-page.html',
  imports: [FormsModule, RouterLink]
})
export class UserGroupPage {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);
  auth = inject(AuthService);

  readonly groupId: string = this.route.snapshot.paramMap.get('id')!;

  group = signal<UserGroup | null>(null);
  mayAdminister = signal<boolean | null>(null);
  invitations = signal<Invitation[]>([]);
  error = signal('');

  private nav = sectionNav<GroupSection>(
    () => ['/user-group', this.groupId], () => SECTION_KEYS, () => 'members');
  readonly activeSection = this.nav.active;
  selectSection(key: GroupSection) { this.nav.select(key); }

  // --- members ---

  memberSearch = '';
  searchResults = signal<GroupMember[] | null>(null);
  searching = signal(false);
  memberError = signal('');

  // --- invitations ---

  /**
   * A number and a unit rather than a list of presets: «на 5 хвилин» and «на 30 діб» are both real
   * requests — the first for a link pasted into a call happening now, the second for the volunteers
   * arriving over a month — and anything between them is somebody's answer. The two bounds are the
   * service's, and are stated on screen rather than only enforced.
   */
  ttlAmount = 7;
  ttlUnit: 'minutes' | 'hours' | 'days' = 'days';
  createError = signal('');
  creating = signal(false);

  /** The link just created, shown once in full above the table so it can be copied straight away. */
  justCreated = signal<Invitation | null>(null);
  copied = signal<string | null>(null);

  readonly minTtl = MIN_TTL_MINUTES;
  readonly maxTtl = MAX_TTL_MINUTES;

  ttlMinutes = computed(() => {
    const amount = Number(this.ttlAmount);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const factor = this.ttlUnit === 'days' ? 1440 : this.ttlUnit === 'hours' ? 60 : 1;
    return Math.round(amount * factor);
  });

  ttlValid = computed(() => this.ttlMinutes() >= MIN_TTL_MINUTES && this.ttlMinutes() <= MAX_TTL_MINUTES);

  constructor() {
    this.load();
  }

  /**
   * Two requests rather than one, deliberately. `groupInvitations` refuses a caller who may not
   * administer the group — a GraphQL error, which this client turns into a thrown Error for the
   * whole document — so asking for the group's name in the same breath would replace the «Немає
   * доступу» card with a red message where the heading should be. This document asks only for what
   * any signed-in caller may read; the tokens are fetched once the answer says they may be.
   */
  private load() {
    const query = `{
      groups { id name description members { id email firstName lastName isActive } }
      manageableGroups { id }
    }`;
    this.gql.request<{ groups: UserGroup[]; manageableGroups: { id: string }[] }>(query).subscribe({
      next: (d) => {
        this.group.set(d.groups.find((g) => g.id === this.groupId) ?? null);
        const allowed = d.manageableGroups.some((g) => g.id === this.groupId);
        this.mayAdminister.set(allowed);
        if (allowed) this.loadInvitations();
      },
      error: (e) => this.error.set(e.message)
    });
  }

  private loadMembers() {
    const query = `{ groups { id name description members { id email firstName lastName isActive } } }`;
    this.gql.request<{ groups: UserGroup[] }>(query).subscribe({
      next: (d) => this.group.set(d.groups.find((g) => g.id === this.groupId) ?? null),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadInvitations() {
    const query = `query($groupId: ID!) {
      groupInvitations(groupId: $groupId) {
        id token expiresAt isExpired joinCount createdAt createdByName
      }
    }`;
    this.gql.request<{ groupInvitations: Invitation[] }>(query, { groupId: this.groupId }).subscribe({
      next: (d) => this.invitations.set(d.groupInvitations),
      error: (e) => this.error.set(e.message)
    });
  }

  // --- members ---

  searchUsers() {
    this.memberError.set('');
    const term = this.memberSearch.trim();
    if (term.length < 2) {
      this.searchResults.set([]);
      return;
    }
    this.searching.set(true);
    const query = `query($query: String!, $limit: Int) {
      searchUsers(query: $query, limit: $limit) { id email firstName lastName isActive }
    }`;
    this.gql.request<{ searchUsers: GroupMember[] }>(query, { query: term, limit: 20 }).subscribe({
      next: (d) => {
        this.searching.set(false);
        const already = new Set((this.group()?.members ?? []).map((m) => m.id));
        this.searchResults.set(d.searchUsers.filter((u) => !already.has(u.id)));
      },
      error: (e) => { this.searching.set(false); this.memberError.set(e.message); }
    });
  }

  addMember(user: GroupMember) {
    this.memberError.set('');
    const mutation = `mutation($userId: ID!, $groupId: ID!) {
      addUserToGroup(userId: $userId, groupId: $groupId) { isSuccess errorStatus }
    }`;
    this.gql.request(mutation, { userId: user.id, groupId: this.groupId }).subscribe({
      next: () => {
        this.searchResults.update((rows) => (rows ?? []).filter((r) => r.id !== user.id));
        this.loadMembers();
      },
      error: (e) => this.memberError.set(e.message)
    });
  }

  removeMember(user: GroupMember) {
    this.memberError.set('');
    const mutation = `mutation($userId: ID!, $groupId: ID!) {
      removeUserFromGroup(userId: $userId, groupId: $groupId) { isSuccess errorStatus }
    }`;
    this.gql.request(mutation, { userId: user.id, groupId: this.groupId }).subscribe({
      next: () => this.loadMembers(),
      error: (e) => this.memberError.set(e.message)
    });
  }

  // --- invitations ---

  createInvitation() {
    this.createError.set('');
    if (!this.ttlValid()) {
      this.createError.set('Термін дії має бути від 5 хвилин до 30 діб.');
      return;
    }
    this.creating.set(true);
    const mutation = `mutation($groupId: ID!, $ttlMinutes: Int!) {
      createGroupInvitation(groupId: $groupId, ttlMinutes: $ttlMinutes) {
        isSuccess
        errorStatus
        data { id token expiresAt isExpired joinCount createdAt createdByName }
      }
    }`;
    this.gql
      .request<{ createGroupInvitation: { isSuccess: boolean; errorStatus: string | null; data: Invitation | null } }>(
        mutation, { groupId: this.groupId, ttlMinutes: this.ttlMinutes() })
      .subscribe({
        next: (d) => {
          this.creating.set(false);
          const res = d.createGroupInvitation;
          if (res.isSuccess && res.data) {
            this.justCreated.set(res.data);
            this.invitations.update((rows) => [res.data as Invitation, ...rows]);
            return;
          }
          this.createError.set(
            res.errorStatus === 'INVALID_TTL' ? 'Термін дії має бути від 5 хвилин до 30 діб.'
              : res.errorStatus === 'GROUP_NOT_FOUND' ? 'Групу не знайдено.'
                : 'Не вдалося створити посилання.');
        },
        error: (e) => { this.creating.set(false); this.createError.set(e.message); }
      });
  }

  deleteInvitation(invitation: Invitation) {
    this.createError.set('');
    const mutation = `mutation($invitationId: ID!) {
      deleteGroupInvitation(invitationId: $invitationId) { isSuccess errorStatus }
    }`;
    this.gql.request(mutation, { invitationId: invitation.id }).subscribe({
      next: () => {
        this.invitations.update((rows) => rows.filter((r) => r.id !== invitation.id));
        if (this.justCreated()?.id === invitation.id) this.justCreated.set(null);
      },
      error: (e) => this.createError.set(e.message)
    });
  }

  /** The address that is actually shared. Built from the browser's own origin, not from the server's. */
  linkFor(invitation: Invitation): string {
    return `${location.origin}/join/${invitation.token}`;
  }

  copyLink(invitation: Invitation) {
    const url = this.linkFor(invitation);
    // `navigator.clipboard` needs a secure context, which `http://` on anything but localhost is
    // not. Selecting the field is the fallback, so «скопіюйте вручну» is at least one keystroke away
    // rather than a dead button.
    navigator.clipboard?.writeText(url).then(
      () => { this.copied.set(invitation.id); setTimeout(() => this.copied.set(null), 2000); },
      () => this.selectLinkField(invitation)
    );
  }

  private selectLinkField(invitation: Invitation) {
    const field = document.getElementById(`invite-link-${invitation.id}`) as HTMLInputElement | null;
    field?.select();
  }

  /** `2026-08-16T14:05:00` → `16.08.2026, 14:05`. The column holds a local timestamp; so does this. */
  formatMoment(iso: string): string {
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(value.getDate())}.${pad(value.getMonth() + 1)}.${value.getFullYear()}, `
      + `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  }

  /** «ще 6 діб», «ще 40 хвилин» — what is actually asked of the column headed «Діє до». */
  remaining(invitation: Invitation): string {
    if (invitation.isExpired) return 'термін минув';
    const minutes = Math.round((new Date(invitation.expiresAt).getTime() - Date.now()) / 60000);
    if (!Number.isFinite(minutes) || minutes <= 0) return 'термін минув';
    if (minutes < 60) return `ще ${minutes} хв`;
    if (minutes < 1440) return `ще ${Math.round(minutes / 60)} год`;
    return `ще ${Math.round(minutes / 1440)} діб`;
  }

  memberName(member: GroupMember): string {
    return [member.lastName, member.firstName].filter(Boolean).join(' ');
  }
}
