import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { ENTITIES } from './entities';
import { toResourceType } from './resource-type';

interface AdminUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  mustChangePassword: boolean;
  isActive: boolean;
}

interface AdminGroup {
  id: string;
  name: string;
  description: string | null;
}

interface AdminGrant {
  id: string;
  granteeType: 'USER' | 'GROUP';
  resourceType: string;
  resourceId: string | null;
  resourceLabel: string | null;
  user?: { id: string; email: string } | null;
  group?: { id: string; name: string } | null;
}

/**
 * Administrator console: create user accounts (with a temporary password — self-registration is
 * intentionally not supported anywhere in the app), manage groups and membership, and grant/revoke
 * entity-scoped "modify" permissions. Reachable at /admin, gated by `adminGuard`.
 */
@Component({
  selector: 'app-admin-page',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './admin-page.html'
})
export class AdminPage implements OnInit {
  private gql = inject(GraphqlService);
  auth = inject(AuthService);

  /** Resource types a grant can target: every entity in the generic framework, plus GLOBAL (full
   *  access) and the curriculum/scheduling entities that only have bespoke (non-generic-table) UI. */
  readonly resourceTypes = [
    'GLOBAL',
    ...ENTITIES.map((e) => toResourceType(e.name)),
    'CURRICULUM_ITEM', 'CURRICULUM_ITEM_HOURS', 'WORKING_CURRICULUM_ITEM',
    'COMBINED_WORKING_CURRICULUM_ITEM', 'LECTURER_WORKLOAD'
  ];

  users = signal<AdminUser[]>([]);
  groups = signal<AdminGroup[]>([]);
  grants = signal<AdminGrant[]>([]);
  error = signal('');

  // create user form
  newUser = { email: '', firstName: '', lastName: '', temporaryPassword: '' };
  createUserError = signal('');
  createUserSuccess = signal('');

  // create group form
  newGroup = { name: '', description: '' };
  createGroupError = signal('');

  // membership form
  membership = { userId: '', groupId: '' };
  membershipError = signal('');

  // grant form
  grant = { granteeType: 'USER' as 'USER' | 'GROUP', userId: '', groupId: '', resourceType: 'FACULTY', resourceId: '' };
  grantError = signal('');
  grantsLoading = signal(false);

  ngOnInit() {
    this.reload();
  }

  reload() {
    this.loadUsers();
    this.loadGroups();
  }

  private loadUsers() {
    const q = `{ users { id email firstName lastName mustChangePassword isActive } }`;
    this.gql.request<{ users: AdminUser[] }>(q).subscribe({
      next: (d) => this.users.set(d.users),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadGroups() {
    const q = `{ groups { id name description } }`;
    this.gql.request<{ groups: AdminGroup[] }>(q).subscribe({
      next: (d) => this.groups.set(d.groups),
      error: (e) => this.error.set(e.message)
    });
  }

  /** Loads who currently has access on the resource selected in the grant form (see
   *  Query.grantsForResource) — requires the caller to already be able to manage grants there. */
  loadGrantsForSelectedResource() {
    this.grantError.set('');
    const resourceId = this.grant.resourceType === 'GLOBAL' ? null : this.grant.resourceId || null;
    if (this.grant.resourceType !== 'GLOBAL' && !resourceId) {
      this.grants.set([]);
      return;
    }
    this.grantsLoading.set(true);
    const q = `query($resourceType: String!, $resourceId: ID) {
      grantsForResource(resourceType: $resourceType, resourceId: $resourceId) {
        id granteeType resourceType resourceId resourceLabel
        user { id email }
        group { id name }
      }
    }`;
    this.gql.request<{ grantsForResource: AdminGrant[] }>(q, { resourceType: this.grant.resourceType, resourceId }).subscribe({
      next: (d) => { this.grants.set(d.grantsForResource); this.grantsLoading.set(false); },
      error: (e) => { this.grantError.set(e.message); this.grantsLoading.set(false); }
    });
  }

  revokeGrant(g: AdminGrant) {
    const q = `mutation($permissionId: ID!) { revokePermission(permissionId: $permissionId) { isSuccess errorStatus } }`;
    this.gql.request(q, { permissionId: g.id }).subscribe({
      next: (d: any) => {
        if (d.revokePermission.isSuccess) {
          this.auth.clearModifyCache();
          this.loadGrantsForSelectedResource();
        } else {
          this.grantError.set('Помилка відкликання доступу.');
        }
      },
      error: (e) => this.grantError.set(e.message)
    });
  }

  createUser() {
    this.createUserError.set('');
    this.createUserSuccess.set('');
    const q = `mutation($email: String!, $firstName: String!, $lastName: String!, $temporaryPassword: String!) {
      createUser(email: $email, firstName: $firstName, lastName: $lastName, temporaryPassword: $temporaryPassword) {
        isSuccess errorStatus data { id email }
      }
    }`;
    this.gql.request(q, this.newUser).subscribe({
      next: (d: any) => {
        const res = d.createUser;
        if (res.isSuccess) {
          this.createUserSuccess.set(`Створено користувача ${res.data.email}. Тимчасовий пароль: ${this.newUser.temporaryPassword}`);
          this.newUser = { email: '', firstName: '', lastName: '', temporaryPassword: '' };
          this.loadUsers();
        } else {
          this.createUserError.set(res.errorStatus === 'DUPLICATE_EMAIL' ? 'Ця ел. пошта вже використовується.' : 'Помилка створення.');
        }
      },
      error: (e) => this.createUserError.set(e.message)
    });
  }

  setUserActive(u: AdminUser, active: boolean) {
    const q = `mutation($userId: ID!, $active: Boolean!) { setUserActive(userId: $userId, active: $active) { isSuccess errorStatus } }`;
    this.gql.request(q, { userId: u.id, active }).subscribe({
      next: (d: any) => { if (d.setUserActive.isSuccess) this.loadUsers(); },
      error: (e) => this.error.set(e.message)
    });
  }

  createGroup() {
    this.createGroupError.set('');
    const q = `mutation($name: String!, $description: String) {
      createGroup(name: $name, description: $description) { isSuccess errorStatus }
    }`;
    this.gql.request(q, this.newGroup).subscribe({
      next: (d: any) => {
        if (d.createGroup.isSuccess) {
          this.newGroup = { name: '', description: '' };
          this.loadGroups();
        } else {
          this.createGroupError.set(d.createGroup.errorStatus === 'DUPLICATE_NAME' ? 'Група з такою назвою вже існує.' : 'Помилка створення.');
        }
      },
      error: (e) => this.createGroupError.set(e.message)
    });
  }

  addToGroup() {
    this.membershipError.set('');
    const q = `mutation($userId: ID!, $groupId: ID!) { addUserToGroup(userId: $userId, groupId: $groupId) { isSuccess errorStatus } }`;
    this.gql.request(q, this.membership).subscribe({
      next: (d: any) => { if (!d.addUserToGroup.isSuccess) this.membershipError.set('Помилка додавання.'); },
      error: (e) => this.membershipError.set(e.message)
    });
  }

  removeFromGroup() {
    this.membershipError.set('');
    const q = `mutation($userId: ID!, $groupId: ID!) { removeUserFromGroup(userId: $userId, groupId: $groupId) { isSuccess errorStatus } }`;
    this.gql.request(q, this.membership).subscribe({
      next: (d: any) => { if (!d.removeUserFromGroup.isSuccess) this.membershipError.set('Помилка видалення.'); },
      error: (e) => this.membershipError.set(e.message)
    });
  }

  submitGrant() {
    this.grantError.set('');
    const variables: Record<string, any> = {
      granteeType: this.grant.granteeType,
      resourceType: this.grant.resourceType,
      resourceId: this.grant.resourceType === 'GLOBAL' ? null : this.grant.resourceId,
      userId: this.grant.granteeType === 'USER' ? this.grant.userId : null,
      groupId: this.grant.granteeType === 'GROUP' ? this.grant.groupId : null
    };
    const q = `mutation($granteeType: String!, $userId: ID, $groupId: ID, $resourceType: String!, $resourceId: ID) {
      grantPermission(granteeType: $granteeType, userId: $userId, groupId: $groupId, resourceType: $resourceType, resourceId: $resourceId) {
        isSuccess errorStatus
      }
    }`;
    this.gql.request(q, variables).subscribe({
      next: (d: any) => {
        const res = d.grantPermission;
        if (!res.isSuccess) {
          this.grantError.set(
            res.errorStatus === 'FORBIDDEN'
              ? 'Ви не маєте права надавати доступ до цього ресурсу.'
              : (res.errorStatus || 'Помилка надання доступу.')
          );
          return;
        }
        this.auth.clearModifyCache();
        this.loadGrantsForSelectedResource();
      },
      error: (e) => this.grantError.set(e.message)
    });
  }
}
