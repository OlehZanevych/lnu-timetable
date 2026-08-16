import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { ENTITIES } from './entities';
import { toResourceType } from './resource-type';
import { Option, SearchSelect } from './search-select';
import { ResourceAccessPanel } from './resource-access';
import { compareUk } from './sort';

interface AdminUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  mustChangePassword: boolean;
  isActive: boolean;
  /** `users.lecturer_id` / `users.student_id` — at most one is ever set (see `schema.sql`). */
  lecturerId: string | null;
  studentId: string | null;
}

/** Which kind of person an account is being pointed at, in the two link forms. */
type LinkKind = 'NONE' | 'LECTURER' | 'STUDENT';

interface AdminGroup {
  id: string;
  name: string;
  description: string | null;
}

/**
 * Administrator console: create user accounts (with a temporary password — self-registration is
 * intentionally not supported anywhere in the app), manage groups and membership, and grant/revoke
 * entity-scoped "modify" permissions. Reachable at /admin, gated by `adminGuard`.
 */
@Component({
  selector: 'app-admin-page',
  standalone: true,
  imports: [FormsModule, RouterLink, SearchSelect, ResourceAccessPanel],
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
  error = signal('');

  // create user form
  newUser = { email: '', firstName: '', lastName: '', temporaryPassword: '' };
  newUserLink: { kind: LinkKind; lecturerId: string; studentId: string } =
    { kind: 'NONE', lecturerId: '', studentId: '' };
  createUserError = signal('');
  createUserSuccess = signal('');

  /**
   * Who an account *is* — `users.lecturer_id` / `users.student_id`, mutually exclusive by
   * `users_person_link_check`. It is not a permission and grants nothing: it decides whose
   * навантаження, навчальний план and розклад «Мій кабінет» shows, which is exactly why only an
   * administrator may set it — otherwise anyone could read anyone else's.
   */
  personLink: { userId: string; kind: LinkKind; lecturerId: string; studentId: string } =
    { userId: '', kind: 'NONE', lecturerId: '', studentId: '' };
  personLinkError = signal('');
  personLinkSuccess = signal('');

  lecturerOptions = signal<Option[]>([]);
  studentOptions = signal<Option[]>([]);
  // Signals, not plain Maps: `person()` is read unconditionally in the users table, while the
  // only consumers of the two option lists sit behind an `@if` that is closed by default. Under
  // zoneless change detection a write to a signal nothing is reading marks no view dirty, so plain
  // fields here left the column showing a placeholder until an unrelated click — the people query
  // resolves well after the (much smaller) users one.
  private lecturerNames = signal(new Map<string, string>());
  private studentNames = signal(new Map<string, string>());

  // create group form
  newGroup = { name: '', description: '' };
  createGroupError = signal('');

  /**
   * Which resource the access panel below is pointed at. The panel itself — `<app-resource-access>`
   * — is the same component the факультет and кафедра pages carry as their «Доступ» tab; all this
   * console adds is the ability to name any resource by type and id, including GLOBAL, which is the
   * one scope that has no page of its own.
   */
  target = { resourceType: 'FACULTY', resourceId: '' };
  activeTarget = signal<{ resourceType: string; resourceId: string | null } | null>(null);
  targetError = signal('');

  ngOnInit() {
    this.reload();
    this.loadPeople();
  }

  reload() {
    this.loadUsers();
    this.loadGroups();
  }

  /** Options for the two person pickers, and the names the users table shows the link by. */
  private loadPeople() {
    const q = `query($lecturerLimit: Int!, $offset: Int!, $studentLimit: Int!) {
      lecturers { lecturerConnection(limit: $lecturerLimit, offset: $offset) { nodes {
        id firstName middleName lastName department { name }
      } } }
      students { studentConnection(limit: $studentLimit, offset: $offset) { nodes {
        id firstName middleName lastName academicGroup { name }
      } } }
    }`;
    this.gql.request(q, { lecturerLimit: 3000, offset: 0, studentLimit: 2000 }).subscribe({
      next: (d: any) => {
        const fullName = (n: any) => [n.lastName, n.firstName, n.middleName].filter(Boolean).join(' ');
        const lecturers = (d.lecturers.lecturerConnection.nodes ?? []).map((n: any) => ({
          id: n.id,
          label: n.department?.name ? `${fullName(n)} — ${n.department.name}` : fullName(n)
        }));
        const students = (d.students.studentConnection.nodes ?? []).map((n: any) => ({
          id: n.id,
          label: n.academicGroup?.name ? `${fullName(n)} — ${n.academicGroup.name}` : fullName(n)
        }));
        lecturers.sort((a: Option, b: Option) => compareUk(a.label, b.label));
        students.sort((a: Option, b: Option) => compareUk(a.label, b.label));
        this.lecturerOptions.set(lecturers);
        this.studentOptions.set(students);
        this.lecturerNames.set(new Map(lecturers.map((o: Option) => [o.id, o.label])));
        this.studentNames.set(new Map(students.map((o: Option) => [o.id, o.label])));
      },
      // A failure here costs the pickers, not the page: everything else on it still works.
      error: (e) => this.personLinkError.set(e.message)
    });
  }

  /** What the users table prints in its «Особа» column. */
  /**
   * Who this account belongs to, for the «Особа» column: the kind of person, their name, and the
   * route to them when they have a page. A викладач does; a студент is only ever a row, so their
   * name is plain text. The name used to fall back to the raw `users.lecturer_id` when the option
   * lists had not resolved — a number that answered nothing the reader could act on.
   */
  person(u: AdminUser): { role: string; name: string; link: any[] | null } | null {
    if (u.lecturerId) {
      return { role: 'Викладач', name: this.lecturerNames().get(u.lecturerId) ?? 'без імені',
               link: ['/lecturer', u.lecturerId] };
    }
    if (u.studentId) {
      return { role: 'Студент', name: this.studentNames().get(u.studentId) ?? 'без імені', link: null };
    }
    return null;
  }

  /** Loads an existing account's current link into the edit form, so it opens on the truth. */
  editPersonLink(u: AdminUser) {
    this.personLinkError.set('');
    this.personLinkSuccess.set('');
    this.personLink = {
      userId: u.id,
      kind: u.lecturerId ? 'LECTURER' : u.studentId ? 'STUDENT' : 'NONE',
      lecturerId: u.lecturerId ?? '',
      studentId: u.studentId ?? ''
    };
  }

  /**
   * Sends the link. Only the id matching the chosen kind is sent and the other is nulled, so the
   * "one or the other, never both" rule cannot be broken from here — the database says the same
   * thing again, and the mutation answers BOTH_LINKS_SET if a caller bypasses this form.
   */
  savePersonLink() {
    this.personLinkError.set('');
    this.personLinkSuccess.set('');
    if (!this.personLink.userId) {
      this.personLinkError.set('Оберіть користувача.');
      return;
    }
    const lecturerId = this.personLink.kind === 'LECTURER' ? this.personLink.lecturerId || null : null;
    const studentId = this.personLink.kind === 'STUDENT' ? this.personLink.studentId || null : null;
    if (this.personLink.kind !== 'NONE' && !lecturerId && !studentId) {
      this.personLinkError.set(this.personLink.kind === 'LECTURER'
        ? 'Оберіть викладача.' : 'Оберіть студента.');
      return;
    }
    const q = `mutation($userId: ID!, $lecturerId: ID, $studentId: ID) {
      setUserLink(userId: $userId, lecturerId: $lecturerId, studentId: $studentId) { isSuccess errorStatus }
    }`;
    this.gql.request(q, { userId: this.personLink.userId, lecturerId, studentId }).subscribe({
      next: (d: any) => {
        const res = d.setUserLink;
        if (res.isSuccess) {
          this.personLinkSuccess.set(this.personLink.kind === 'NONE'
            ? 'Прив’язку знято.' : 'Прив’язку збережено.');
          this.loadUsers();
        } else {
          this.personLinkError.set(this.linkErrorMessage(res.errorStatus));
        }
      },
      error: (e) => this.personLinkError.set(e.message)
    });
  }

  /** The named statuses `setUserLink` / `createUser` can return for a bad link, in Ukrainian. */
  private linkErrorMessage(status: string): string {
    switch (status) {
      case 'ALREADY_LINKED': return 'Цього викладача або студента вже прив’язано до іншого запису.';
      case 'BOTH_LINKS_SET': return 'Обліковий запис може бути або викладачем, або студентом, не обома.';
      case 'INVALID_LINK':   return 'Такого викладача або студента не існує.';
      case 'USER_NOT_FOUND': return 'Користувача не знайдено.';
      default: return status || 'Не вдалося зберегти прив’язку.';
    }
  }

  private loadUsers() {
    const q = `{ users { id email firstName lastName mustChangePassword isActive lecturerId studentId } }`;
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

  /**
   * Points the access panel at the resource named in the two fields above. Kept as an explicit
   * action rather than reacting to every keystroke: `grantsForResource` refuses outright for a
   * resource the caller cannot manage, and a query fired on each character typed would report that
   * refusal against half-finished ids.
   */
  showAccessFor() {
    this.targetError.set('');
    const isGlobal = this.target.resourceType === 'GLOBAL';
    const resourceId = isGlobal ? null : this.target.resourceId.trim();
    if (!isGlobal && !resourceId) {
      this.activeTarget.set(null);
      this.targetError.set('Вкажіть ID ресурсу.');
      return;
    }
    this.activeTarget.set({ resourceType: this.target.resourceType, resourceId });
  }

  createUser() {
    this.createUserError.set('');
    this.createUserSuccess.set('');
    // The same check `savePersonLink` makes: «Викладач» chosen but nobody picked would otherwise
    // create an unlinked account and report success, which is the one failure the backend cannot
    // catch — it is a valid request, just not the one that was meant.
    if (this.newUserLink.kind === 'LECTURER' && !this.newUserLink.lecturerId) {
      this.createUserError.set('Оберіть викладача або зніміть вибір «Викладач».');
      return;
    }
    if (this.newUserLink.kind === 'STUDENT' && !this.newUserLink.studentId) {
      this.createUserError.set('Оберіть студента або зніміть вибір «Студент».');
      return;
    }
    const q = `mutation($email: String!, $firstName: String!, $lastName: String!, $temporaryPassword: String!,
                        $lecturerId: ID, $studentId: ID) {
      createUser(email: $email, firstName: $firstName, lastName: $lastName, temporaryPassword: $temporaryPassword,
                 lecturerId: $lecturerId, studentId: $studentId) {
        isSuccess errorStatus data { id email }
      }
    }`;
    const variables = {
      ...this.newUser,
      lecturerId: this.newUserLink.kind === 'LECTURER' ? this.newUserLink.lecturerId || null : null,
      studentId: this.newUserLink.kind === 'STUDENT' ? this.newUserLink.studentId || null : null
    };
    this.gql.request(q, variables).subscribe({
      next: (d: any) => {
        const res = d.createUser;
        if (res.isSuccess) {
          this.createUserSuccess.set(`Створено користувача ${res.data.email}. Тимчасовий пароль: ${this.newUser.temporaryPassword}`);
          this.newUser = { email: '', firstName: '', lastName: '', temporaryPassword: '' };
          this.newUserLink = { kind: 'NONE', lecturerId: '', studentId: '' };
          this.loadUsers();
        } else {
          this.createUserError.set(res.errorStatus === 'DUPLICATE_EMAIL'
            ? 'Ця ел. пошта вже використовується.'
            : this.linkErrorMessage(res.errorStatus));
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

}
