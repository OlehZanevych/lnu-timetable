import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { LecturerPage } from './entity-pages';
import { DepartmentWorkloadSummary } from './department-workload-summary';
import { LecturerConstraintList } from './lecturer-constraint-list';
import { TimetableConstraintList } from './timetable-constraint-list';
import { LecturerWorkloadDetail } from './lecturer-workload-detail';
import { LecturerWorkloadList } from './lecturer-workload-list';
import { CombinedWorkingCurriculumItemList } from './combined-working-curriculum-item-list';
import { TimetableView } from './timetable-view';
import { sectionNav } from './section-route';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { ResourceAccessPanel } from './resource-access';

type DeptSection = 'info' | 'lecturers' | 'combinedItems' | 'constraints'
  | 'timetableConstraints' | 'workloads' | 'workloadSummary' | 'workloadDetail' | 'timetable'
  | 'access';

/** Which slugs `/department/:id/:section` recognises — see `section-route.ts`. */
const SECTION_KEYS: DeptSection[] = ['info', 'lecturers', 'combinedItems', 'constraints',
  'timetableConstraints', 'workloads', 'workloadSummary', 'workloadDetail', 'timetable', 'access'];

interface Department {
  id: string;
  name: string;
  abbreviation?: string;
  email?: string;
  phone?: string;
  faculty: { id: string; name: string };
}

@Component({
  selector: 'app-department-page',
  templateUrl: './department-page.html',
  imports: [RouterLink, FormsModule, LecturerPage, LecturerConstraintList, TimetableConstraintList,
            LecturerWorkloadList, DepartmentWorkloadSummary, LecturerWorkloadDetail,
            CombinedWorkingCurriculumItemList, TimetableView, ResourceAccessPanel]
})
export class DepartmentDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);
  private auth = inject(AuthService);

  readonly departmentId: string = this.route.snapshot.paramMap.get('id')!;

  /**
   * This account's level on the кафедра. The «Редагувати» button used to render for everyone and
   * rely on the server to refuse — which it did, after the user had filled the form in.
   */
  departmentLevel = signal<AccessLevel | null>(null);
  private effectiveLevel = computed(() => maxLevel(this.auth.globalLevel(), this.departmentLevel()));
  canModifyDepartment = computed(() => allows(this.effectiveLevel(), 'EDIT'));
  canManageAccess = computed(() => allows(this.effectiveLevel(), 'MANAGE'));

  department = signal<Department | null>(null);
  error = signal('');

  /** The open tab, and the last segment of the URL — see `section-route.ts`. */
  private nav = sectionNav<DeptSection>(
    () => ['/department', this.departmentId], () => SECTION_KEYS, () => 'info');
  readonly activeSection = this.nav.active;

  selectSection(key: DeptSection) { this.nav.select(key); }

  /** Set when a lecturer is picked in the summary, so the assessment opens on them. */
  focusLecturerId = signal('');

  /** Every lecturer of the department — the columns of the викладацький розклад. */
  lecturerIds = signal<string[]>([]);

  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};

  ngOnInit() {
    this.load();
    this.loadLecturerIds();
    this.auth.accessLevel('DEPARTMENT', this.departmentId)
      .subscribe((level) => this.departmentLevel.set(level));
  }

  /**
   * A department's timetable is its lecturers' timetable: `timetableEntryConnection` filters by
   * `lecturerIds`, so they are resolved first and passed in.
   */
  private loadLecturerIds() {
    const q = `query($departmentId: ID, $limit: Int!, $offset: Int!) { lecturers { lecturerConnection(limit: $limit, offset: $offset, departmentId: $departmentId) { nodes { id } } } }`;
    this.gql.request(q, { departmentId: this.departmentId, limit: 500, offset: 0 }).subscribe({
      next: (d: any) => this.lecturerIds.set(
        d.lecturers.lecturerConnection.nodes.map((l: any) => String(l.id))),
      error: () => this.lecturerIds.set([])
    });
  }

  private load() {
    const q = `query($id: ID!) { departments { department(id: $id) { id name abbreviation email phone faculty { id name } } } }`;
    this.gql.request(q, { id: this.departmentId }).subscribe({
      next: (d: any) => this.department.set(d.departments.department),
      error: (e) => this.error.set(e.message)
    });
  }

  get deptPreset(): Record<string, string> { return { departmentId: this.departmentId }; }

  /** Summary row -> assessment: the natural next question after "who is overloaded?" is "why?". */
  openAssessment(lecturerId: string) {
    this.focusLecturerId.set(lecturerId);
    this.selectSection('workloadDetail');
  }

  openEdit() {
    const d = this.department();
    if (!d) return;
    this.editForm = {
      name:         d.name         ?? '',
      abbreviation: d.abbreviation ?? '',
      email:        d.email        ?? '',
      phone:        d.phone        ?? '',
    };
    this.editError.set('');
    this.showEditForm.set(true);
  }

  closeEdit() {
    this.showEditForm.set(false);
    this.editError.set('');
  }

  saveEdit() {
    const dept = this.department();
    if (!dept) return;
    // facultyId must be included in update payload (required field)
    const input: Record<string, any> = { facultyId: dept.faculty.id };
    for (const f of ['name', 'abbreviation', 'email', 'phone']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    const q = `mutation($id: ID!, $input: DepartmentInputPayload!) { departments { updateDepartment(id: $id, department: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.departmentId, input }).subscribe({
      next: (d: any) => {
        const res = d.departments.updateDepartment;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }
}
