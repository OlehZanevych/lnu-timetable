import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { Option, SearchSelect } from './search-select';
import { MultiSelect } from './multi-select';
import { CONTROL_FORM_OPTIONS, DURATION_HOURS_OPTIONS, HOUR_TYPE_OPTIONS, TEACHING_FORMAT_OPTIONS, toOptions } from './entities';

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
  durationHours: number;
  lecturers: LecturerRef[];
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
  /** Non-empty when this item has been merged into a combined_working_curriculum_item — such
   *  items are excluded from the tree (see buildGroups) and shown only in the section above it. */
  combinedWorkingCurriculumItems: { id: string }[];
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

/** A working curriculum item as it appears inside a combined item's member list. */
interface CombinedMember {
  id: string;
  academicGroups: GroupRef[];
  curriculumItemHours: {
    hourType: string;
    hours: number;
    curriculumItem: {
      semester: number;
      specialty: { id: string; name: string };
      course: { id: string; name: string };
    };
  };
}

/** A combined_working_curriculum_item relevant to this department, with its own workloads. */
interface CombinedItem {
  id: string;
  workingCurriculumItems: CombinedMember[];
  workloads: Workload[];
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

/** Must stay in step with the hour_type enum in schema.sql (unknown types sort last). */
const HOUR_TYPE_ORDER = ['LECTURE', 'PRACTICAL', 'LAB', 'CONSULTATION', 'ASSESSMENT', 'INDEPENDENT_WORK'];

/**
 * Lecturer workload input for a department: pre-loads every working curriculum item already
 * delivered by the department (with its curriculum item / hours context), grouped into
 * semester → discipline → hour-type → working-curriculum-item blocks, and lets the user
 * assign lecturers (with their academic/combined groups) under each one.
 *
 * Working curriculum items that have been merged into a combined_working_curriculum_item (see the
 * "Об'єднані позиції РНП" subpage) are handled separately, in a dedicated section above the tree,
 * and excluded from the tree itself to avoid showing the same assignment twice: their workload is
 * assigned once against the combined item, covering every merged specialty at once.
 */
@Component({
  selector: 'app-lecturer-workload-list',
  templateUrl: './lecturer-workload-list.html',
  imports: [FormsModule, MultiSelect, SearchSelect]
})
export class LecturerWorkloadList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);

  @Input() departmentId!: string;

  readonly CONTROL_FORM_OPTIONS = CONTROL_FORM_OPTIONS;
  readonly HOUR_TYPE_OPTIONS = HOUR_TYPE_OPTIONS;
  readonly TEACHING_FORMAT_OPTIONS = TEACHING_FORMAT_OPTIONS;
  readonly DURATION_HOURS_OPTIONS = DURATION_HOURS_OPTIONS;
  readonly durationHoursSelectOptions: Option[] = toOptions(DURATION_HOURS_OPTIONS);

  /** default_class_duration_hours global property — pre-filled as formDurationHours when creating
   *  a new workload (see openCreate/openCreateCombined and loadDefaultDurationHours). */
  private defaultDurationHours = signal('2');

  private rawItems = signal<WorkingItem[]>([]);
  /** Combined items with at least one member belonging to this department — filtered server-side
   *  (see loadCombined) via the departmentIds relation filter on combinedWorkingCurriculumItemConnection. */
  combinedItems = signal<CombinedItem[]>([]);
  error = signal('');

  lecturerOptions = signal<Option[]>([]);
  combinedGroupOptions = signal<Option[]>([]);

  /** The working curriculum items for this department, grouped for display (see interfaces above). */
  groups = computed(() => this.buildGroups(this.rawItems()));

  showForm = signal(false);
  editingId = signal<string | null>(null);
  formError = signal('');
  formLecturerIds: string[] = [];
  formAcademicGroupIds: string[] = [];
  formCombinedGroupIds: string[] = [];
  formDurationHours = '2';

  /** Academic-group options for the modal: the specific working curriculum item's own groups. */
  activeAcademicGroupOptions = signal<Option[]>([]);

  /**
   * The working curriculum item's teaching format the modal was opened from. "Об'єднані групи"
   * only makes sense when lecturers teach their groups separately (SEPARATELY) — when everyone
   * teaches together (TOGETHER) there's nothing to combine, so only academic groups apply.
   */
  activeTeachingFormat = signal<string | null>(null);

  private activeWorkingCurriculumItemId: string | null = null;
  private activeCombinedWorkingCurriculumItemId: string | null = null;
  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    this.loadCombinedGroupOptions();
    this.loadDefaultDurationHours();
    if (this.departmentId) {
      this.loadLecturerOptions();
      this.loadAll();
    }
  }

  ngOnChanges() {
    if (this.initialized && this.departmentId) {
      this.loadLecturerOptions();
      this.loadAll();
    }
  }

  private loadAll() {
    this.loadItems();
    this.loadCombined();
  }

  private loadItems() {
    if (!this.departmentId) return;
    const q = `{ workingCurriculumItems { workingCurriculumItemConnection(limit: 1000, offset: 0, departmentId: "${this.departmentId}") { nodes {
      id lecturerCount teachingFormat
      course { id name }
      academicGroups { id name }
      combinedWorkingCurriculumItems { id }
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
        durationHours
        lecturers { id firstName middleName lastName }
        academicGroups { id name }
        combinedGroups { id name }
      }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.rawItems.set(d.workingCurriculumItems.workingCurriculumItemConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadCombined() {
    if (!this.departmentId) return;
    const q = `{ combinedWorkingCurriculumItems { combinedWorkingCurriculumItemConnection(limit: 1000, offset: 0, departmentIds: ["${this.departmentId}"]) { nodes {
      id
      workingCurriculumItems {
        id
        academicGroups { id name }
        curriculumItemHours {
          hourType hours
          curriculumItem { semester specialty { id name } course { id name } }
        }
      }
      workloads {
        id
        durationHours
        lecturers { id firstName middleName lastName }
        academicGroups { id name }
        combinedGroups { id name }
      }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.combinedItems.set(d.combinedWorkingCurriculumItems.combinedWorkingCurriculumItemConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  private buildGroups(items: WorkingItem[]): CurriculumItemGroup[] {
    const byItem = new Map<string, CurriculumItemGroup>();
    // Items already merged into a combined_working_curriculum_item are managed exclusively in the
    // "Об'єднані позиції" section above, so leaving them out here avoids showing the same
    // assignment twice (and curriculum items whose every item is merged simply don't appear).
    for (const wci of items) {
      if (this.isMerged(wci)) continue;
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

  private loadDefaultDurationHours() {
    const q = `{ globalProperties { globalProperty(name: "default_class_duration_hours") { value } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const value = d.globalProperties.globalProperty?.value;
        if (value) this.defaultDurationHours.set(value);
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

  lecturerNames(w: Workload): string {
    return (w.lecturers ?? []).map((l) => this.lecturerName(l)).join(', ') || '—';
  }

  /** True once this working curriculum item has been merged into a combined item — such items are
   *  excluded from the tree in buildGroups() and shown only in the "Об'єднані позиції" section. */
  private isMerged(wci: WorkingItem): boolean {
    return (wci.combinedWorkingCurriculumItems ?? []).length > 0;
  }

  /** "Дисципліна · Семестр N · Тип годин: H год." summary line for a combined item's card header. */
  combinedSummary(c: CombinedItem): string {
    const first = c.workingCurriculumItems[0];
    if (!first) return '';
    const ci = first.curriculumItemHours.curriculumItem;
    return `${ci.course.name} · Семестр ${ci.semester} · ${this.hourTypeLabel(first.curriculumItemHours.hourType)}: ${first.curriculumItemHours.hours} год.`;
  }

  combinedMemberLabel(m: CombinedMember): string {
    return `${m.curriculumItemHours.curriculumItem.specialty.name} (${this.academicGroupNames(m.academicGroups)})`;
  }

  combinedMembersLabel(c: CombinedItem): string {
    return c.workingCurriculumItems.map((m) => this.combinedMemberLabel(m)).join('; ');
  }

  /** The union of academic groups across every member of a combined item, deduplicated by id. */
  private unionAcademicGroups(c: CombinedItem): Option[] {
    const byId = new Map<string, GroupRef>();
    for (const m of c.workingCurriculumItems) {
      for (const g of m.academicGroups ?? []) byId.set(g.id, g);
    }
    return Array.from(byId.values()).map((g) => ({ id: g.id, label: g.name }));
  }

  // ── Create / Edit ────────────────────────────────────────────────────────

  openCreate(wci: WorkingItem) {
    this.editingId.set(null);
    this.activeWorkingCurriculumItemId = wci.id;
    this.activeCombinedWorkingCurriculumItemId = null;
    this.activeAcademicGroupOptions.set(wci.academicGroups.map((g) => ({ id: g.id, label: g.name })));
    this.activeTeachingFormat.set(wci.teachingFormat);
    this.formLecturerIds = [];
    this.formAcademicGroupIds = [];
    this.formCombinedGroupIds = [];
    this.formDurationHours = this.defaultDurationHours();
    this.formError.set('');
    this.showForm.set(true);
  }

  openEdit(wci: WorkingItem, w: Workload) {
    this.editingId.set(w.id);
    this.activeWorkingCurriculumItemId = wci.id;
    this.activeCombinedWorkingCurriculumItemId = null;
    this.activeAcademicGroupOptions.set(wci.academicGroups.map((g) => ({ id: g.id, label: g.name })));
    this.activeTeachingFormat.set(wci.teachingFormat);
    this.formLecturerIds = (w.lecturers ?? []).map((l) => l.id);
    this.formAcademicGroupIds = (w.academicGroups ?? []).map((g) => g.id);
    this.formCombinedGroupIds = (w.combinedGroups ?? []).map((g) => g.id);
    this.formDurationHours = String(w.durationHours);
    this.formError.set('');
    this.showForm.set(true);
  }

  /**
   * Same modal, but for a combined item: the assignment covers every merged specialty at once, so
   * the available academic groups are the union across all its members, and "Об'єднані групи"
   * doesn't apply (it's a per-item SEPARATELY-teaching concept — see canUseCombinedGroups).
   */
  openCreateCombined(c: CombinedItem) {
    this.editingId.set(null);
    this.activeWorkingCurriculumItemId = null;
    this.activeCombinedWorkingCurriculumItemId = c.id;
    this.activeAcademicGroupOptions.set(this.unionAcademicGroups(c));
    this.activeTeachingFormat.set(null);
    this.formLecturerIds = [];
    this.formAcademicGroupIds = [];
    this.formCombinedGroupIds = [];
    this.formDurationHours = this.defaultDurationHours();
    this.formError.set('');
    this.showForm.set(true);
  }

  openEditCombined(c: CombinedItem, w: Workload) {
    this.editingId.set(w.id);
    this.activeWorkingCurriculumItemId = null;
    this.activeCombinedWorkingCurriculumItemId = c.id;
    this.activeAcademicGroupOptions.set(this.unionAcademicGroups(c));
    this.activeTeachingFormat.set(null);
    this.formLecturerIds = (w.lecturers ?? []).map((l) => l.id);
    this.formAcademicGroupIds = (w.academicGroups ?? []).map((g) => g.id);
    this.formCombinedGroupIds = [];
    this.formDurationHours = String(w.durationHours);
    this.formError.set('');
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.formError.set('');
  }

  /** "Об'єднані групи" only applies when a single item's teaching format is SEPARATELY. */
  canUseCombinedGroups(): boolean {
    return this.activeTeachingFormat() === 'SEPARATELY';
  }

  save() {
    if (!this.activeWorkingCurriculumItemId && !this.activeCombinedWorkingCurriculumItemId) return;
    const input: Record<string, any> = {
      lecturerIds: this.formLecturerIds,
      academicGroupIds: this.formAcademicGroupIds,
      // Combined groups only make sense for SEPARATELY items; force-clear them otherwise so
      // switching a working curriculum item back to TOGETHER also drops any stale assignment.
      combinedGroupIds: this.canUseCombinedGroups() ? this.formCombinedGroupIds : [],
      durationHours: Number(this.formDurationHours),
    };
    // Exactly one of these two is sent, matching whichever entry point (single item or combined
    // item) the modal was opened from.
    if (this.activeWorkingCurriculumItemId) input['workingCurriculumItemId'] = this.activeWorkingCurriculumItemId;
    if (this.activeCombinedWorkingCurriculumItemId) input['combinedWorkingCurriculumItemId'] = this.activeCombinedWorkingCurriculumItemId;

    const id = this.editingId();
    const op = id ? 'updateLecturerWorkload' : 'createLecturerWorkload';
    const q = id
      ? `mutation($id: ID!, $input: LecturerWorkloadInputPayload!) { lecturerWorkloads { ${op}(id: $id, lecturerWorkload: $input) { isSuccess errorStatus } } }`
      : `mutation($input: LecturerWorkloadInputPayload!) { lecturerWorkloads { ${op}(lecturerWorkload: $input) { isSuccess errorStatus } } }`;

    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = d.lecturerWorkloads[op];
        if (res.isSuccess) { this.closeForm(); this.loadAll(); }
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
        if (res.isSuccess) this.loadAll();
        else this.error.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.error.set(e.message)
    });
  }
}
