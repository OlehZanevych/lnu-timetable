import { Component, Input, OnChanges, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { AccessLevel, ACCESS_LEVELS, ACCESS_LEVEL_HINTS, ACCESS_LEVEL_LABELS, allows } from './access-level';
import { Option, SearchSelect } from './search-select';

export interface ResourceGrant {
  id: string;
  granteeType: 'USER' | 'GROUP';
  resourceType: string;
  resourceId: string | null;
  level: AccessLevel;
  resourceLabel: string | null;
  inherited: boolean;
  user?: { id: string; email: string; firstName: string; lastName: string } | null;
  group?: { id: string; name: string } | null;
  grantedBy?: { id: string; email: string } | null;
}

/**
 * «Доступ» — who can reach one resource, and the form for handing that reach to somebody else.
 *
 * The same panel appears in three places: on the administration console, where a resource is chosen
 * by type and id, and as a tab on the факультет and кафедра pages, where the resource is the page
 * itself. That is deliberate. Delegation used to live only on /admin, behind the administrator
 * guard, which meant the feature existed in the backend and was unreachable for exactly the people
 * it was for: a деканат holding MANAGE on their факультет had the right to hand out access and
 * nowhere to do it. Putting the panel on the resource's own page is what makes «дати кафедрі право
 * редагувати свої навантаження» something the деканат does themselves, in the place they are
 * already looking at.
 *
 * Inherited grants — a grant on the факультет, seen from a кафедра under it — are listed as
 * context, greyed, with no controls: they are why somebody can edit this page, and they are not
 * withdrawable from here.
 */
@Component({
  selector: 'app-resource-access',
  standalone: true,
  imports: [FormsModule, SearchSelect],
  templateUrl: './resource-access.html'
})
export class ResourceAccessPanel implements OnChanges {
  /** The securable's `resource_type` — an entity name in UPPER_SNAKE_CASE, or `GLOBAL`. */
  @Input({ required: true }) resourceType!: string;

  /** The row id; null only for `GLOBAL`. */
  @Input() resourceId: string | null = null;

  /** Shown above the table, e.g. «Факультет прикладної математики та інформатики». */
  @Input() resourceLabel = '';

  private gql = inject(GraphqlService);
  private auth = inject(AuthService);

  readonly levels = ACCESS_LEVELS;
  readonly levelLabels = ACCESS_LEVEL_LABELS;
  readonly levelHints = ACCESS_LEVEL_HINTS;

  grants = signal<ResourceGrant[]>([]);
  loading = signal(false);
  error = signal('');
  notice = signal('');

  /** Whether the caller may see this panel at all — MANAGE here, or a university-wide MANAGE. */
  canManage = signal(false);

  groupOptions = signal<Option[]>([]);
  userOptions = signal<Option[]>([]);
  userSearchPending = signal(false);

  form = {
    granteeType: 'USER' as 'USER' | 'GROUP',
    userId: '',
    groupId: '',
    level: 'EDIT' as AccessLevel
  };

  /** What the administrator typed into the "find a person" box. */
  userQuery = '';

  directGrants = computed(() => this.grants().filter((g) => !g.inherited));
  inheritedGrants = computed(() => this.grants().filter((g) => g.inherited));

  ngOnChanges() {
    this.error.set('');
    this.notice.set('');
    this.grants.set([]);
    this.canManage.set(false);
    if (!this.resourceType || (this.resourceType !== 'GLOBAL' && !this.resourceId)) return;
    this.checkAccessThenLoad();
  }

  private checkAccessThenLoad() {
    if (this.resourceType === 'GLOBAL') {
      this.canManage.set(this.auth.globalLevel() === 'MANAGE');
      if (this.canManage()) this.load();
      return;
    }
    // A university-wide MANAGE covers every resource; otherwise ask about this one specifically.
    if (this.auth.globalLevel() === 'MANAGE') {
      this.canManage.set(true);
      this.load();
      return;
    }
    this.auth.accessLevel(this.resourceType, this.resourceId!).subscribe((level) => {
      this.canManage.set(allows(level, 'MANAGE'));
      if (this.canManage()) this.load();
    });
  }

  load() {
    this.loading.set(true);
    this.error.set('');
    const q = `query($resourceType: String!, $resourceId: ID) {
      grantsForResource(resourceType: $resourceType, resourceId: $resourceId) {
        id granteeType resourceType resourceId level resourceLabel inherited
        user { id email firstName lastName }
        group { id name }
        grantedBy { id email }
      }
    }`;
    this.gql
      .request<{ grantsForResource: ResourceGrant[] }>(q, {
        resourceType: this.resourceType,
        resourceId: this.resourceType === 'GLOBAL' ? null : this.resourceId
      })
      .subscribe({
        next: (d) => {
          this.grants.set(d.grantsForResource);
          this.loading.set(false);
        },
        error: (e) => {
          this.error.set(e.message);
          this.loading.set(false);
        }
      });
    this.loadGroups();
  }

  private loadGroups() {
    if (this.groupOptions().length) return;
    this.gql.request<{ groups: { id: string; name: string }[] }>('{ groups { id name } }').subscribe({
      next: (d) => this.groupOptions.set(d.groups.map((g) => ({ id: g.id, label: g.name }))),
      error: () => this.groupOptions.set([])
    });
  }

  /**
   * Looks accounts up by what the administrator types rather than offering the whole staff list.
   * Two characters minimum, matching the server — a picker preloaded with every account would be
   * both a slow first paint and a directory of the university handed to anyone who can delegate.
   */
  findUsers() {
    const query = (this.userQuery || '').trim();
    if (query.length < 2) {
      this.userOptions.set([]);
      this.error.set('Введіть щонайменше два символи для пошуку.');
      return;
    }
    this.error.set('');
    this.userSearchPending.set(true);
    const q = `query($query: String!, $limit: Int) {
      searchUsers(query: $query, limit: $limit) { id email firstName lastName }
    }`;
    this.gql
      .request<{ searchUsers: { id: string; email: string; firstName: string; lastName: string }[] }>(q, {
        query,
        limit: 20
      })
      .subscribe({
        next: (d) => {
          this.userOptions.set(
            d.searchUsers.map((u) => ({ id: u.id, label: `${u.lastName} ${u.firstName} (${u.email})` }))
          );
          if (!d.searchUsers.length) this.error.set('За цим запитом нікого не знайдено.');
          this.userSearchPending.set(false);
        },
        error: () => {
          this.userOptions.set([]);
          this.userSearchPending.set(false);
        }
      });
  }

  granteeName(g: ResourceGrant): string {
    if (g.granteeType === 'GROUP') return g.group?.name ?? '—';
    const u = g.user;
    if (!u) return '—';
    return `${u.lastName} ${u.firstName} (${u.email})`;
  }

  /** Where an inherited grant actually sits, spelled the way the reader will recognise it. */
  sourceOf(g: ResourceGrant): string {
    if (!g.inherited) return 'Безпосередньо';
    if (g.resourceType === 'GLOBAL') return 'Загальний доступ (уся система)';
    return `Успадковано: ${g.resourceLabel || g.resourceType}`;
  }

  submit() {
    this.error.set('');
    this.notice.set('');
    if (this.form.granteeType === 'USER' && !this.form.userId) {
      this.error.set('Оберіть користувача.');
      return;
    }
    if (this.form.granteeType === 'GROUP' && !this.form.groupId) {
      this.error.set('Оберіть групу.');
      return;
    }
    this.grant(this.form.granteeType, this.form.userId, this.form.groupId, this.form.level, () => {
      this.form.userId = '';
      this.form.groupId = '';
    });
  }

  /**
   * Re-granting the same scope at another level. The mutation is an upsert, so this is one call and
   * not revoke-then-grant — there is no moment in between where the grantee has neither.
   */
  changeLevel(g: ResourceGrant, level: AccessLevel) {
    if (level === g.level) return;
    this.grant(g.granteeType, g.user?.id ?? '', g.group?.id ?? '', level);
  }

  /**
   * The one call both paths make. Kept separate from `form` on purpose: changing a row's level used
   * to work by writing that row's grantee into the grant form and submitting it, which left the
   * «Надати доступ» form below filled in with somebody the administrator had not chosen.
   */
  private grant(granteeType: 'USER' | 'GROUP', userId: string, groupId: string, level: AccessLevel,
                onSuccess?: () => void) {
    const q = `mutation($granteeType: String!, $userId: ID, $groupId: ID, $resourceType: String!, $resourceId: ID, $level: AccessLevel!) {
      grantPermission(granteeType: $granteeType, userId: $userId, groupId: $groupId,
                      resourceType: $resourceType, resourceId: $resourceId, level: $level) {
        isSuccess errorStatus
      }
    }`;
    this.gql
      .request(q, {
        granteeType,
        userId: granteeType === 'USER' ? userId : null,
        groupId: granteeType === 'GROUP' ? groupId : null,
        resourceType: this.resourceType,
        resourceId: this.resourceType === 'GLOBAL' ? null : this.resourceId,
        level
      })
      .subscribe({
        next: (d: any) => {
          const res = d.grantPermission;
          if (!res.isSuccess) {
            this.error.set(GRANT_ERRORS[res.errorStatus] ?? res.errorStatus ?? 'Помилка надання доступу.');
            // The row's <select> still shows what the administrator picked, which is now a lie —
            // reload so it goes back to saying what the grant actually is.
            this.load();
            return;
          }
          this.notice.set(res.errorStatus === 'UPDATED' ? 'Рівень доступу оновлено.' : 'Доступ надано.');
          onSuccess?.();
          this.auth.clearAccessCache();
          this.load();
        },
        error: (e) => { this.error.set(e.message); this.load(); }
      });
  }

  revoke(g: ResourceGrant) {
    this.error.set('');
    this.notice.set('');
    const q = `mutation($permissionId: ID!) { revokePermission(permissionId: $permissionId) { isSuccess errorStatus } }`;
    this.gql.request(q, { permissionId: g.id }).subscribe({
      next: (d: any) => {
        const res = d.revokePermission;
        if (!res.isSuccess) {
          this.error.set(REVOKE_ERRORS[res.errorStatus] ?? 'Помилка відкликання доступу.');
          return;
        }
        this.notice.set('Доступ відкликано.');
        this.auth.clearAccessCache();
        this.load();
      },
      error: (e) => this.error.set(e.message)
    });
  }
}

const GRANT_ERRORS: Record<string, string> = {
  FORBIDDEN: 'Ви не маєте права «Керування доступом» до цього ресурсу.',
  LEVEL_ABOVE_OWN: 'Не можна надати рівень доступу, вищий за власний.',
  UNKNOWN_RESOURCE_TYPE: 'Невідомий тип ресурсу.',
  UNKNOWN_ACCESS_LEVEL: 'Невідомий рівень доступу.',
  INVALID_GRANTEE: 'Оберіть або користувача, або групу.'
};

const REVOKE_ERRORS: Record<string, string> = {
  FORBIDDEN:
    'Відкликати цей дозвіл може той, хто має «Керування доступом» на рівні вище (наприклад, на факультеті), ' +
    'або той, хто його надав.',
  PERMISSION_NOT_FOUND: 'Дозвіл уже відкликано.'
};
