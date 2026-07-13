import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { SearchSelect, Option } from './search-select';
import { MultiSelect } from './multi-select';
import { CONTROL_FORM_OPTIONS, HOUR_TYPE_OPTIONS, TEACHING_FORMAT_OPTIONS } from './entities';

interface GroupRef {
  id: string;
  name: string;
}

interface LecturerRef {
  id: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
}

interface Workload {
  id: string;
  lecturer: LecturerRef;
  academicGroups: GroupRef[];
  combinedGroups: GroupRef[];
}

interface WorkingItem {
  id: string;
  lecturerCount: number;
  teachingFormat: string;
  course?: { id: string; name: string } | null;
  academicGroups: GroupRef[];
  workloads: Workload[];
  curriculumItemHours: {
    id: string;
    hourType: string;
    hours: number;
    curriculumItem: {
      id: string;
      semester: number;
      controlForm: string;
      ectsCredits?: number;
      specialty: { id: string; name: string };
      course: { id: string; name: string; courseType: string };
    };
  };
}

/** A curriculum_item_hours sub-block (e.g. "Лекції: 32"), holding the working curriculum items delivered by the current department for it. */
interface HoursGroup {
  id: string;
  hourType: string;
  hours: number;
  items: WorkingItem[];
}

/** A curriculum item block (semester / specialty / discipline / control form / ECTS), grouping its hours sub-blocks. */
interface CurriculumItemGroup {
  id: string;
  semester: number;
  controlForm: string;
  ectsCredits?: number;
  specialty: { id: string; name: string };
  course: { id: string; name: string; courseType: string };
  hoursGroups: HoursGroup[];
}

const HOUR_TYPE_ORDER = ['LECTURE', 'PRACTICAL', 'LAB', 'INDEPENDENT_WORK'];

/**
 * Lecturer workload input for a department: pre-loads every working curriculum item already
 * delivered by the department (with its curriculum item / hours context), grouped into
 * semester → discipline → hour-type → working-curriculum-item blocks, and lets the user
 * assign lecturers (with their academic/combined groups) under each one.
 */
@Component({
  selector: 'app-lecturer-workload-list',
  templateUrl: './lecturer-workload-list.html',
  imports: [FormsModule, SearchSelect, MultiSelect]
})
export class LecturerWorkloadList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);

  @Input() departmentId!: string;

  readonly CONTROL_FORM_OPTIONS = CONTROL_FORM_OPTIONS;
  readonly HOUR_TYPE_OPTIONS = HOUR_TYPE_OPTIONS;
  readonly TEACHING_FORMAT_OPTIONS = TEACHING_FORMAT_OPTIONS;

  private rawItems = signal<WorkingItem[]>([]);
  error = signal('');

  lecturerOptions = signal<Option[]>([]);
  combinedGroupOptions = signal<Option[]>([]);

  /** The working curriculum items for this department, grouped for display (see interfaces above). */
  groups = computed(() => this.buildGroups(this.rawItems()));

  showForm = signal(false);
  editingId = signal<string | null>(null);
  formError = signal('');
  form: Record<string, any> = {};
  formAcademicGroupIds: string[] = [];
  formCombinedGroupIds: string[] = [];

  /** Academic-group options for the modal: the specific working curriculum item's own groups. */
  activeAcademicGroupOptions = signal<Option[]>([]);

  /**
   * The working curriculum item's teaching format the modal was opened from. "Об'єднані групи"
   * only makes sense when lecturers teach their groups separately (SEPARATELY) — when everyone
   * teaches together (TOGETHER) there's nothing to combine, so only academic groups apply.
   */
  activeTeachingFormat = signal<string | null>(null);

  private activeWorkingCurriculumItemId: string | null = null;
  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    this.loadCombinedGroupOptions();
    if (this.departmentId) {
      this.loadLecturerOptions();
      this.loadItems();
    }
  }

  ngOnChanges() {
    if (this.initialized && this.departmentId) {
      this.loadLecturerOptions();
      this.loadItems();
    }
  }

  private loadItems() {
    if (!this.departmentId) return;
    const q = `{ workingCurriculumItems { workingCurriculumItemConnection(limit: 1000, offset: 0, departmentId: "${this.departmentId}") { nodes {
      id lecturerCount teachingFormat
      course { id name }
      academicGroups { id name }
      curriculumItemHours {
        id hourType hours
        curriculumItem {
          id semester controlForm ectsCredits
          specialty { id name }
          course { id name courseType }
        }
      }
      workloads {
        id
        lecturer { id firstName middleName lastName }
        academicGroups { id name }
        combinedGroups { id name }
      }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.rawItems.set(d.workingCurriculumItems.workingCurriculumItemConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  private buildGroups(items: WorkingItem[]): CurriculumItemGroup[] {
    const byItem = new Map<string, CurriculumItemGroup>();
    for (const wci of items) {
      const ci = wci.curriculumItemHours.curriculumItem;
      let group = byItem.get(ci.id);
      if (!group) {
        group = {
          id: ci.id, semester: ci.semester, controlForm: ci.controlForm, ectsCredits: ci.ectsCredits,
          specialty: ci.specialty, course: ci.course, hoursGroups: []
        };
        byItem.set(ci.id, group);
      }
      let hg = group.hoursGroups.find((h) => h.id === wci.curriculumItemHours.id);
      if (!hg) {
        hg = { id: wci.curriculumItemHours.id, hourType: wci.curriculumItemHours.hourType, hours: wci.curriculumItemHours.hours, items: [] };
        group.hoursGroups.push(hg);
      }
      hg.items.push(wci);
    }

    const groups = Array.from(byItem.values());
    groups.sort((a, b) => a.semester - b.semester || a.specialty.name.localeCompare(b.specialty.name) || a.course.name.localeCompare(b.course.name));
    for (const g of groups) {
      g.hoursGroups.sort((a, b) => HOUR_TYPE_ORDER.indexOf(a.hourType) - HOUR_TYPE_ORDER.indexOf(b.hourType));
    }
    return groups;
  }

  private loadLecturerOptions() {
    if (!this.departmentId) return;
    const q = `{ lecturers { lecturerConnection(limit: 500, offset: 0, departmentId: "${this.departmentId}") { nodes { id firstName middleName lastName } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.lecturers.lecturerConnection.nodes.map((l: any) => ({ id: l.id, label: this.lecturerName(l) }));
        this.lecturerOptions.set(opts);
      },
      error: () => {}
    });
  }

  private loadCombinedGroupOptions() {
    const q = `{ combinedGroups { combinedGroupConnection(limit: 1000, offset: 0) { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.combinedGroups.combinedGroupConnection.nodes.map((g: any) => ({ id: g.id, label: g.name }));
        this.combinedGroupOptions.set(opts);
      },
      error: () => {}
    });
  }

  private lecturerName(l: LecturerRef): string {
    return [l.lastName, l.firstName, l.middleName].filter(Boolean).join(' ');
  }

  controlFormLabel(v: string): string {
    return this.CONTROL_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  hourTypeLabel(v: string): string {
    return this.HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  teachingFormatLabel(v: string): string {
    return this.TEACHING_FORMAT_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  /** "Вибіркова дисципліна" only applies when the discipline itself is a group of electives. */
  isElectiveGroupCourse(group: CurriculumItemGroup): boolean {
    return group.course.courseType === 'ELECTIVE_GROUP';
  }

  academicGroupNames(refs: GroupRef[]): string {
    return (refs ?? []).map((g) => g.name).join(', ') || '—';
  }

  combinedGroupNames(refs: GroupRef[]): string {
    return (refs ?? []).map((g) => g.name).join(', ') || '—';
  }

  lecturerFullName(w: Workload): string {
    return this.lecturerName(w.lecturer);
  }

  // ── Create / Edit ────────────────────────────────────────────────────────

  openCreate(wci: WorkingItem) {
    this.editingId.set(null);
    this.activeWorkingCurriculumItemId = wci.id;
    this.activeAcademicGroupOptions.set(wci.academicGroups.map((g) => ({ id: g.id, label: g.name })));
    this.activeTeachingFormat.set(wci.teachingFormat);
    this.form = { lecturerId: '' };
    this.formAcademicGroupIds = [];
    this.formCombinedGroupIds = [];
    this.formError.set('');
    this.showForm.set(true);
  }

  openEdit(wci: WorkingItem, w: Workload) {
    this.editingId.set(w.id);
    this.activeWorkingCurriculumItemId = wci.id;
    this.activeAcademicGroupOptions.set(wci.academicGroups.map((g) => ({ id: g.id, label: g.name })));
    this.activeTeachingFormat.set(wci.teachingFormat);
    this.form = { lecturerId: w.lecturer.id };
    this.formAcademicGroupIds = (w.academicGroups ?? []).map((g) => g.id);
    this.formCombinedGroupIds = (w.combinedGroups ?? []).map((g) => g.id);
    this.formError.set('');
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.formError.set('');
  }

  /** "Об'єднані групи" only applies when the item's teaching format is SEPARATELY. */
  canUseCombinedGroups(): boolean {
    return this.activeTeachingFormat() === 'SEPARATELY';
  }

  save() {
    if (!this.activeWorkingCurriculumItemId) return;
    const input: Record<string, any> = {
      workingCurriculumItemId: this.activeWorkingCurriculumItemId,
      academicGroupIds: this.formAcademicGroupIds,
      // Combined groups only make sense for SEPARATELY items; force-clear them otherwise so
      // switching a working curriculum item back to TOGETHER also drops any stale assignment.
      combinedGroupIds: this.canUseCombinedGroups() ? this.formCombinedGroupIds : [],
    };
    if (this.form['lecturerId']) input['lecturerId'] = this.form['lecturerId'];

    const id = this.editingId();
    const op = id ? 'updateLecturerWorkload' : 'createLecturerWorkload';
    const q = id
      ? `mutation($id: ID!, $input: LecturerWorkloadInputPayload!) { lecturerWorkloads { ${op}(id: $id, lecturerWorkload: $input) { isSuccess errorStatus } } }`
      : `mutation($input: LecturerWorkloadInputPayload!) { lecturerWorkloads { ${op}(lecturerWorkload: $input) { isSuccess errorStatus } } }`;

    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = d.lecturerWorkloads[op];
        if (res.isSuccess) { this.closeForm(); this.loadItems(); }
        else this.formError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.formError.set(e.message)
    });
  }

  remove(w: Workload) {
    const q = `mutation($id: ID!) { lecturerWorkloads { deleteLecturerWorkload(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: w.id }).subscribe({
      next: (d: any) => {
        const res = d.lecturerWorkloads.deleteLecturerWorkload;
        if (res.isSuccess) this.loadItems();
        else this.error.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.error.set(e.message)
    });
  }
}
