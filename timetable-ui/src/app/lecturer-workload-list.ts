import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { Option, SearchSelect } from './search-select';
import { MultiSelect } from './multi-select';
import { CONTROL_FORM_OPTIONS, DURATION_HOURS_OPTIONS, HOUR_TYPE_OPTIONS, TEACHING_FORMAT_OPTIONS, toOptions } from './entities';
import { compareUk } from './sort';

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

interface StudentRef {
  id: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  academicGroup?: GroupRef | null;
}

/** One lecturer<->student pairing of an INDIVIDUALLY-taught workload (lecturer_workload_students). */
interface StudentAssignment {
  id: string;
  lecturer: LecturerRef;
  student: StudentRef;
}

interface Workload {
  id: string;
  durationHours: number;
  lecturers: LecturerRef[];
  academicGroups: GroupRef[];
  combinedGroups: GroupRef[];
  /** Populated only for INDIVIDUALLY items; empty for TOGETHER/SEPARATELY ones. */
  studentAssignments: StudentAssignment[];
}

/** A lecturer<->student pair being edited in the modal. */
interface PairDraft {
  key: number;
  /** Existing lecturer_workload_students row id, or null for a pair added in this session. */
  id: string | null;
  lecturerId: string;
  studentId: string;
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

/**
 * Duration for INDIVIDUALLY-taught workloads. One-to-one work with a student (a coursework
 * consultation, say) is booked as a single academic hour rather than as a lesson of a chosen
 * length, so the field is hidden in the modal and this value is sent implicitly.
 */
const INDIVIDUAL_DURATION_HOURS = '1';

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

  /**
   * Lecturer<->student pairs, used instead of academic groups when the item is taught
   * INDIVIDUALLY. Held in a signal and replaced (never mutated in place) so adding, removing or
   * editing a pair re-renders — this app runs zoneless, so a mutated plain array wouldn't.
   */
  formPairs = signal<PairDraft[]>([]);
  private nextPairKey = 1;

  /** Students of the active item's academic groups — the candidates a pair can point at. */
  activeStudentOptions = signal<Option[]>([]);

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
        studentAssignments {
          id
          lecturer { id firstName middleName lastName }
          student { id firstName middleName lastName academicGroup { id name } }
        }
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
    groups.sort((a, b) => a.semester - b.semester || compareUk(a.specialty.name, b.specialty.name) || compareUk(a.course.name, b.course.name));
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

  /**
   * Loads the students of the given academic groups in one round trip (one aliased
   * studentConnection per group — the connection only takes a single academicGroupId), then
   * deduplicates by id in case a student somehow appears under two of them.
   */
  private loadStudentOptions(groups: GroupRef[]) {
    const list = groups ?? [];
    if (!list.length) { this.activeStudentOptions.set([]); return; }
    const parts = list
      .map((g, i) => `g${i}: studentConnection(limit: 500, offset: 0, academicGroupId: "${g.id}") { nodes { id firstName middleName lastName academicGroup { id name } } }`)
      .join(' ');
    this.gql.request(`{ students { ${parts} } }`).subscribe({
      next: (d: any) => {
        const byId = new Map<string, StudentRef>();
        for (const key of Object.keys(d.students ?? {})) {
          for (const n of d.students[key]?.nodes ?? []) byId.set(n.id, n);
        }
        const opts = Array.from(byId.values())
          .map((st) => ({ id: st.id, label: this.studentName(st) }))
          .sort((a, b) => compareUk(a.label, b.label));
        this.activeStudentOptions.set(opts);
      },
      error: () => this.activeStudentOptions.set([])
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

  studentName(st: StudentRef): string {
    const name = [st.lastName, st.firstName, st.middleName].filter(Boolean).join(' ');
    return st.academicGroup ? `${name} (${st.academicGroup.name})` : name;
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

  /**
   * The workload's lecturer<->student pairings, rendered as two aligned columns for INDIVIDUALLY
   * items. Both cells iterate this one list in the same order, so line N of "Викладач" always
   * belongs with line N of "Студент".
   */
  pairRows(w: Workload): { lecturer: string; student: string }[] {
    return (w.studentAssignments ?? []).map((a) => ({
      lecturer: this.lecturerName(a.lecturer),
      student: this.studentName(a.student)
    }));
  }

  isIndividuallyItem(wci: WorkingItem): boolean {
    return wci.teachingFormat === 'INDIVIDUALLY';
  }

  /** Column count of a working curriculum item's workload table, for the empty row's colspan. */
  workloadColumns(wci: WorkingItem): number {
    // Individual work has no duration column — it is always one academic hour per student
    // (see INDIVIDUAL_DURATION_HOURS), so showing "1 год." on every row says nothing.
    if (this.isIndividuallyItem(wci)) return 3;          // lecturer, student, actions
    return wci.teachingFormat === 'SEPARATELY' ? 5 : 4;  // lecturers, groups, (+ combined), duration, actions
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
    this.formPairs.set([]);
    this.loadStudentOptions(this.isIndividuallyItem(wci) ? wci.academicGroups : []);
    this.formDurationHours = this.isIndividuallyItem(wci) ? INDIVIDUAL_DURATION_HOURS : this.defaultDurationHours();
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
    this.formPairs.set((w.studentAssignments ?? []).map((a) => ({
      key: this.nextPairKey++,
      id: a.id,
      lecturerId: a.lecturer?.id ?? '',
      studentId: a.student?.id ?? ''
    })));
    this.loadStudentOptions(this.isIndividuallyItem(wci) ? wci.academicGroups : []);
    this.formDurationHours = this.isIndividuallyItem(wci) ? INDIVIDUAL_DURATION_HOURS : String(w.durationHours);
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
    this.formPairs.set([]);
    this.activeStudentOptions.set([]);
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
    this.formPairs.set([]);
    this.activeStudentOptions.set([]);
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

  /**
   * INDIVIDUALLY items pair each student with their supervising lecturer instead of assigning
   * academic groups, so the modal swaps the group pickers for a list of pairs.
   */
  isIndividually(): boolean {
    return this.activeTeachingFormat() === 'INDIVIDUALLY';
  }

  // ── Lecturer<->student pairs ────────────────────────────────────────────

  addPair() {
    this.formPairs.set([...this.formPairs(), { key: this.nextPairKey++, id: null, lecturerId: '', studentId: '' }]);
  }

  removePair(pair: PairDraft) {
    this.formPairs.set(this.formPairs().filter((p) => p.key !== pair.key));
  }

  setPairLecturer(pair: PairDraft, value: any) {
    this.replacePair(pair, { lecturerId: value == null ? '' : String(value) });
  }

  setPairStudent(pair: PairDraft, value: any) {
    this.replacePair(pair, { studentId: value == null ? '' : String(value) });
  }

  private replacePair(pair: PairDraft, patch: Partial<PairDraft>) {
    this.formPairs.set(this.formPairs().map((p) => (p.key === pair.key ? { ...p, ...patch } : p)));
  }

  /**
   * Students still selectable for a pair: everyone except those another pair already claims, plus
   * this pair's own current pick. Mirrors UNIQUE (lecturer_workload_id, student_id) — a student has
   * one supervising lecturer per workload — so the constraint can't be hit through the UI.
   */
  studentOptionsFor(pair: PairDraft): Option[] {
    const taken = new Set(this.formPairs().filter((p) => p.key !== pair.key && p.studentId).map((p) => p.studentId));
    return this.activeStudentOptions().filter((o) => !taken.has(o.id) || o.id === pair.studentId);
  }

  /** True once every candidate student is already paired — nothing left to add. */
  canAddPair(): boolean {
    return this.formPairs().length < this.activeStudentOptions().length;
  }

  save() {
    if (!this.activeWorkingCurriculumItemId && !this.activeCombinedWorkingCurriculumItemId) return;

    const individually = this.isIndividually();
    const pairs = this.formPairs();
    if (individually) {
      if (!pairs.length) { this.formError.set('Додайте щонайменше одну пару «викладач — студент».'); return; }
      if (pairs.some((p) => !p.lecturerId || !p.studentId)) {
        this.formError.set('У кожній парі оберіть і викладача, і студента.'); return;
      }
    }

    const input: Record<string, any> = {
      // For INDIVIDUALLY items the lecturer list is derived from the pairs rather than picked
      // separately, so `lecturers` can never disagree with who actually supervises whom.
      lecturerIds: individually ? Array.from(new Set(pairs.map((p) => p.lecturerId))) : this.formLecturerIds,
      // Academic groups are meaningless once the assignment is per-student; force-clear them (and
      // vice versa below) so switching an item's teaching format never leaves a stale half-state.
      academicGroupIds: individually ? [] : this.formAcademicGroupIds,
      // Combined groups only make sense for SEPARATELY items; force-clear them otherwise so
      // switching a working curriculum item back to TOGETHER also drops any stale assignment.
      combinedGroupIds: this.canUseCombinedGroups() ? this.formCombinedGroupIds : [],
      // Always sent: the nested-list reconciliation reads an empty array as "delete every pairing",
      // which is exactly what a non-INDIVIDUALLY item should end up with.
      studentAssignments: individually
        ? pairs.map((p) => (p.id ? { id: p.id, lecturerId: p.lecturerId, studentId: p.studentId }
                                 : { lecturerId: p.lecturerId, studentId: p.studentId }))
        : [],
      // Not user-selectable for individual work — see INDIVIDUAL_DURATION_HOURS.
      durationHours: Number(individually ? INDIVIDUAL_DURATION_HOURS : this.formDurationHours),
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
