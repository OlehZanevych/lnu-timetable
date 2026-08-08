import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { GraphqlService } from './graphql.service';
import { Option, SearchSelect } from './search-select';
import { MultiSelect } from './multi-select';
import { CONTROL_FORM_OPTIONS, DURATION_HOURS_OPTIONS, HOUR_TYPE_OPTIONS, TEACHING_FORMAT_OPTIONS, toOptions } from './entities';
import { compareUk } from './sort';
import { GenIssue, GenLecturer, GenResult, GenWorkload, generateWorkloads } from './workload-generator';
import { CourseTagRef, courseLabel } from './course-label';

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

/** MIN_STUDENTS / MAX_STUDENTS on a candidate — only used by INDIVIDUALLY-taught items. */
interface CandidateConstraintRef { id: string; constraintType: string; value: number }

/** A lecturer who could deliver a workload, with how desirable that would be (1..100). */
interface CandidateRef {
  id: string;
  lecturer: LecturerRef;
  desirability: number;
  constraints: CandidateConstraintRef[];
}

/** One row of the candidate roster in the modal; a blank score means "not a candidate". */
interface CandidateRow {
  lecturerId: string;
  lecturerLabel: string;
  /** Existing lecturer_workload_candidates row id, or null. */
  id: string | null;
  desirability: string;
  /** Desired number of students (MIN_STUDENTS); '' when unset. INDIVIDUALLY items only. */
  minStudents: string;
  /** Hard ceiling on students (MAX_STUDENTS); '' when unset. INDIVIDUALLY items only. */
  maxStudents: string;
  /** Row ids of the two limits, so an update reuses them instead of re-inserting. */
  minStudentsId: string | null;
  maxStudentsId: string | null;
  /** Snapshot of the four editable values as loaded, so save can skip untouched candidates. */
  original: string;
}

interface Workload {
  id: string;
  durationHours: number;
  classStartTimeSet?: { id: string; name: string } | null;
  lecturers: LecturerRef[];
  academicGroups: GroupRef[];
  combinedGroups: GroupRef[];
  /** Populated only for INDIVIDUALLY items; empty for TOGETHER/SEPARATELY ones. */
  studentAssignments: StudentAssignment[];
  /** Who could deliver this workload, and how desirable each option is. */
  candidates: CandidateRef[];
}

/**
 * One row of the INDIVIDUALLY modal: a student of the working curriculum item's academic groups,
 * with the lecturer supervising them. Every candidate student gets a row whether or not anyone is
 * assigned yet — filling a roster in is far quicker than adding pairs one at a time — so an empty
 * `lecturerId` simply means "not assigned" and is skipped on save.
 */
interface StudentRow {
  studentId: string;
  studentLabel: string;
  /** Existing lecturer_workload_students row id, or null when this student has no pairing yet. */
  id: string | null;
  lecturerId: string;
}

interface WorkingItem {
  id: string;
  lecturerCount: number;
  teachingFormat: string;
  course?: { id: string; name: string; tags?: CourseTagRef[] | null } | null;
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
      course: { id: string; name: string; courseType: string; tags?: CourseTagRef[] | null };
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
      course: { id: string; name: string; tags?: CourseTagRef[] | null };
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
  course: { id: string; name: string; courseType: string; tags?: CourseTagRef[] | null };
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
  imports: [FormsModule, RouterLink, MultiSelect, SearchSelect]
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

  /**
   * The grids of start times a workload may be scheduled on: the university-wide ones plus those
   * belonging to this department's faculty. A set scoped to another faculty is not offered at all —
   * see loadClassStartTimeSets.
   */
  classStartTimeSetOptions = signal<Option[]>([]);
  /** The set marked as default, pre-selected when creating a workload. */
  private defaultClassStartTimeSetId = signal('');

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
  formClassStartTimeSetId = '';

  /**
   * The student roster shown instead of academic groups when the item is taught INDIVIDUALLY:
   * every student of the item's groups, each with a lecturer picker. Held in a signal and replaced
   * (never mutated in place) so an edit re-renders — this app runs zoneless, so a mutated plain
   * array wouldn't.
   */
  formStudentRows = signal<StudentRow[]>([]);

  /** True while the roster is being fetched, so the modal can say so instead of looking empty. */
  loadingStudents = signal(false);

  /**
   * Candidate pool for the workload being edited: every lecturer of the department, each with a
   * desirability score. Blank means "not a candidate", so the roster doubles as the picker.
   */
  formCandidates = signal<CandidateRow[]>([]);


  /** Academic-group options for the modal: the specific working curriculum item's own groups. */
  activeAcademicGroupOptions = signal<Option[]>([]);

  /**
   * The working curriculum item's teaching format the modal was opened from. "Об'єднані групи"
   * only makes sense when lecturers teach their groups separately (SEPARATELY) — when everyone
   * teaches together (TOGETHER) there's nothing to combine, so only academic groups apply.
   */
  activeTeachingFormat = signal<string | null>(null);

  // ── Automatic generation ────────────────────────────────────────────────
  /** 'gaps' fills only missing/short assignments; 'all' reassigns the whole department. */
  genMode = signal<'gaps' | 'all'>('gaps');
  /** The proposed plan, held until the user applies or discards it — generation never writes directly. */
  genResult = signal<GenResult | null>(null);
  genRunning = signal(false);
  genApplying = signal(false);
  genError = signal('');
  /** Lecturer constraints + the annual default, loaded once per department for the generator. */
  private genLecturers = signal<GenLecturer[]>([]);
  private defaultMaxHoursPerYear = signal<number | null>(null);
  /** workloadId -> the students of its item's groups, for INDIVIDUALLY distribution. */
  private studentsByWorkload = new Map<string, string[]>();
  /**
   * workloadId -> its current durationHours. LecturerWorkloadInputPayload declares durationHours
   * non-null (the domain field carries no @Nullable), so an update that only means to change the
   * lecturers must still echo it or the mutation is rejected before it reaches the resolver.
   */
  private durationByWorkload = new Map<string, number>();
  /** workloadId -> its current class start time set, echoed for the same reason as the duration. */
  private startTimeSetByWorkload = new Map<string, string>();

  private activeWorkingCurriculumItemId: string | null = null;
  private activeCombinedWorkingCurriculumItemId: string | null = null;
  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    this.loadCombinedGroupOptions();
    this.loadDefaultDurationHours();
    if (this.departmentId) {
      this.loadLecturerOptions();
      this.loadClassStartTimeSets();
      this.loadAll();
    }
  }

  ngOnChanges() {
    if (this.initialized && this.departmentId) {
      this.loadLecturerOptions();
      this.loadClassStartTimeSets();
      this.loadAll();
    }
  }

  private loadAll() {
    this.loadItems();
    this.loadCombined();
    this.loadGeneratorInputs();
    this.genResult.set(null);   // any plan is stale once the tree reloads
  }

  /** Lecturer constraints and the global hour default — only needed by the generator. */
  private loadGeneratorInputs() {
    if (!this.departmentId) return;
    const q = `{
      lecturers { lecturerConnection(limit: 500, offset: 0, departmentId: "${this.departmentId}") { nodes {
        id firstName middleName lastName workloadConstraints { constraintType value }
      } } }
      globalProperties { globalProperty(name: "default_max_hours_per_year") { value } }
    }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        this.genLecturers.set(d.lecturers.lecturerConnection.nodes.map((n: any) => ({
          id: n.id,
          name: this.lecturerName(n),
          constraints: Object.fromEntries((n.workloadConstraints ?? []).map((c: any) => [c.constraintType, c.value]))
        })));
        const raw = d.globalProperties.globalProperty?.value;
        const parsed = raw != null ? Number(raw) : NaN;
        this.defaultMaxHoursPerYear.set(Number.isFinite(parsed) ? parsed : null);
      },
      error: () => {}
    });
  }

  private loadItems() {
    if (!this.departmentId) return;
    const q = `{ workingCurriculumItems { workingCurriculumItemConnection(limit: 1000, offset: 0, departmentId: "${this.departmentId}") { nodes {
      id lecturerCount teachingFormat
      course { id name tags { tag } }
      academicGroups { id name }
      combinedWorkingCurriculumItems { id }
      curriculumItemHours {
        id hourType hours
        curriculumItem {
          id semester controlForm ectsCredits
          specialty { id name }
          course { id name courseType tags { tag } }
        }
      }
      workloads {
        id
        durationHours
        classStartTimeSet { id name }
        lecturers { id firstName middleName lastName }
        academicGroups { id name }
        combinedGroups { id name }
        studentAssignments {
          id
          lecturer { id firstName middleName lastName }
          student { id firstName middleName lastName academicGroup { id name } }
        }
        candidates { id desirability lecturer { id firstName middleName lastName } constraints { id constraintType value } }
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
          curriculumItem { semester specialty { id name } course { id name tags { tag } } }
        }
      }
      workloads {
        id
        durationHours
        classStartTimeSet { id name }
        lecturers { id firstName middleName lastName }
        academicGroups { id name }
        combinedGroups { id name }
        candidates { id desirability lecturer { id firstName middleName lastName } constraints { id constraintType value } }
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

  /**
   * Loads the start-time grids this department may schedule on, and remembers which is the default.
   *
   * The connection is fetched unfiltered and narrowed here rather than by `facultyId`: that filter
   * matches on equality, so asking for this faculty's sets would exclude the university-wide ones
   * (faculty_id IS NULL), which are exactly the sets most workloads use.
   */
  private loadClassStartTimeSets() {
    if (!this.departmentId) return;
    // The department's faculty comes along in the same round trip, because which sets are usable
    // depends on it.
    const q = `{
      departments { department(id: "${this.departmentId}") { faculty { id } } }
      classStartTimeSets { classStartTimeSetConnection(limit: 200, offset: 0) { nodes {
        id name isDefault faculty { id }
      } } }
    }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const nodes = d.classStartTimeSets.classStartTimeSetConnection.nodes ?? [];
        const facultyId = d.departments?.department?.faculty?.id ?? '';
        const usable = nodes.filter((n: any) => !n.faculty || n.faculty.id === facultyId);
        this.classStartTimeSetOptions.set(
          usable
            .map((n: any) => ({ id: n.id, label: n.isDefault ? `${n.name} (типовий)` : n.name }))
            .sort((a: Option, b: Option) => compareUk(a.label, b.label)));
        this.defaultClassStartTimeSetId.set(nodes.find((n: any) => n.isDefault)?.id ?? '');
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
   * Builds the roster for the INDIVIDUALLY modal: every student of the given academic groups, in
   * one round trip (one aliased studentConnection per group — the connection only takes a single
   * academicGroupId), deduplicated by id in case a student appears under two of them, and merged
   * with whatever pairings the workload being edited already has.
   *
   * A pairing whose student is no longer in any of those groups (they changed group after the
   * assignment was made, say) is appended rather than dropped, so opening the form never silently
   * deletes it.
   */
  private loadStudentRows(groups: GroupRef[], existing: StudentAssignment[]) {
    const assigned = new Map<string, StudentAssignment>();
    for (const a of existing ?? []) {
      if (a.student?.id) assigned.set(a.student.id, a);
    }

    const list = groups ?? [];
    if (!list.length) {
      this.formStudentRows.set(this.orphanRows(assigned, new Set()));
      return;
    }

    this.loadingStudents.set(true);
    const parts = list
      .map((g, i) => `g${i}: studentConnection(limit: 500, offset: 0, academicGroupId: "${g.id}") { nodes { id firstName middleName lastName academicGroup { id name } } }`)
      .join(' ');
    this.gql.request(`{ students { ${parts} } }`).subscribe({
      next: (d: any) => {
        const byId = new Map<string, StudentRef>();
        for (const key of Object.keys(d.students ?? {})) {
          for (const n of d.students[key]?.nodes ?? []) byId.set(n.id, n);
        }
        const rows: StudentRow[] = Array.from(byId.values())
          .map((st) => {
            const a = assigned.get(st.id);
            return {
              studentId: st.id,
              studentLabel: this.studentName(st),
              id: a?.id ?? null,
              lecturerId: a?.lecturer?.id ?? ''
            };
          })
          .sort((a, b) => compareUk(a.studentLabel, b.studentLabel));
        this.formStudentRows.set([...rows, ...this.orphanRows(assigned, new Set(byId.keys()))]);
        this.loadingStudents.set(false);
      },
      error: () => {
        this.formStudentRows.set(this.orphanRows(assigned, new Set()));
        this.loadingStudents.set(false);
      }
    });
  }

  /** Rows for already-assigned students who aren't in the item's groups any more. */
  /**
   * Builds the candidate roster from the department's lecturers, pre-filling the scores this
   * workload already has. A candidate who is no longer in the department keeps their row rather
   * than being silently dropped on the next save.
   */
  private buildCandidateRows(existing: CandidateRef[]) {
    const byLecturer = new Map<string, CandidateRef>();
    for (const c of existing ?? []) {
      if (c.lecturer?.id) byLecturer.set(c.lecturer.id, c);
    }
    const known = new Set<string>();
    const rows: CandidateRow[] = this.lecturerOptions().map((o) => {
      known.add(o.id);
      return this.toCandidateRow(o.id, o.label, byLecturer.get(o.id));
    });
    const orphans: CandidateRow[] = Array.from(byLecturer.values())
      .filter((c) => !known.has(c.lecturer.id))
      .map((c) => this.toCandidateRow(c.lecturer.id, this.lecturerName(c.lecturer), c));
    this.formCandidates.set([...rows, ...orphans]);
  }

  private toCandidateRow(lecturerId: string, lecturerLabel: string, c?: CandidateRef): CandidateRow {
    const limit = (type: string) => (c?.constraints ?? []).find((x) => x.constraintType === type);
    const min = limit('MIN_STUDENTS');
    const max = limit('MAX_STUDENTS');
    const row: CandidateRow = {
      lecturerId,
      lecturerLabel,
      id: c?.id ?? null,
      desirability: c?.desirability != null ? String(c.desirability) : '',
      minStudents: min?.value != null ? String(min.value) : '',
      maxStudents: max?.value != null ? String(max.value) : '',
      minStudentsId: min?.id ?? null,
      maxStudentsId: max?.id ?? null,
      original: ''
    };
    row.original = candidateSnapshot(row);
    return row;
  }

  private orphanRows(assigned: Map<string, StudentAssignment>, known: Set<string>): StudentRow[] {
    return Array.from(assigned.values())
      .filter((a) => a.student?.id && !known.has(a.student.id))
      .map((a) => ({
        studentId: a.student.id,
        studentLabel: this.studentName(a.student),
        id: a.id,
        lecturerId: a.lecturer?.id ?? ''
      }))
      .sort((a, b) => compareUk(a.studentLabel, b.studentLabel));
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
   * The same lecturers as {@link lecturerNames}, but as ids and names rather than one joined string,
   * so the cell can link each of them to their own page. The string form is kept because the
   * generated-plan preview and the PDF still want one label.
   */
  lecturerRefs(w: Workload): { id: string; name: string }[] {
    return (w.lecturers ?? []).map((l) => ({ id: l.id, name: this.lecturerName(l) }));
  }

  /**
   * The workload's lecturer<->student pairings, rendered as two aligned columns for INDIVIDUALLY
   * items. Both cells iterate this one list in the same order, so line N of "Викладач" always
   * belongs with line N of "Студент".
   */
  pairRows(w: Workload): { lecturerId: string; lecturer: string; student: string }[] {
    return (w.studentAssignments ?? []).map((a) => ({
      lecturerId: a.lecturer.id,
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
    // (see INDIVIDUAL_DURATION_HOURS), so showing "1 год." on every row says nothing. Every layout
    // carries the start-time set, though: it applies to individual consultations just as much.
    if (this.isIndividuallyItem(wci)) return 4;          // lecturer, student, bells, actions
    return wci.teachingFormat === 'SEPARATELY' ? 6 : 5;  // lecturers, groups, (+ combined), duration, bells, actions
  }

  /** Name of the grid of bells a workload is scheduled on, for the tree's "Дзвінки" column. */
  startTimeSetName(w: Workload): string {
    return w.classStartTimeSet?.name ?? '—';
  }

  /** True once this working curriculum item has been merged into a combined item — such items are
   *  excluded from the tree in buildGroups() and shown only in the "Об'єднані позиції" section. */
  private isMerged(wci: WorkingItem): boolean {
    return (wci.combinedWorkingCurriculumItems ?? []).length > 0;
  }

  /** Exposed for the template — the shared rule, see `course-label.ts`. */
  courseLabel = courseLabel;

  /** "Дисципліна · Семестр N · Тип годин: H год." summary line for a combined item's card header. */
  combinedSummary(c: CombinedItem): string {
    const ref = this.combinedCourseRef(c);
    return ref ? `${ref.label}${this.combinedSummaryTail(c)}` : '';
  }

  /** The discipline of a combined item's card header, split out so the header can link it. */
  combinedCourseRef(c: CombinedItem): { id: string; name: string; label: string } | null {
    const ci = c.workingCurriculumItems[0]?.curriculumItemHours?.curriculumItem;
    return ci
      ? { id: ci.course.id, name: ci.course.name, label: courseLabel(ci.course.name, ci.course.tags) }
      : null;
  }

  /** Everything after the discipline in that header — " · Семестр N · Лекції: 32 год." */
  combinedSummaryTail(c: CombinedItem): string {
    const first = c.workingCurriculumItems[0];
    if (!first) return '';
    const ci = first.curriculumItemHours.curriculumItem;
    return ` · Семестр ${ci.semester} · ${this.hourTypeLabel(first.curriculumItemHours.hourType)}: ${first.curriculumItemHours.hours} год.`;
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
    this.loadStudentRows(this.isIndividuallyItem(wci) ? wci.academicGroups : [], []);
    this.buildCandidateRows([]);
    this.formDurationHours = this.isIndividuallyItem(wci) ? INDIVIDUAL_DURATION_HOURS : this.defaultDurationHours();
    this.formClassStartTimeSetId = this.defaultClassStartTimeSetId();
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
    this.loadStudentRows(this.isIndividuallyItem(wci) ? wci.academicGroups : [], w.studentAssignments ?? []);
    this.buildCandidateRows(w.candidates ?? []);
    this.formDurationHours = this.isIndividuallyItem(wci) ? INDIVIDUAL_DURATION_HOURS : String(w.durationHours);
    this.formClassStartTimeSetId = w.classStartTimeSet?.id ?? this.defaultClassStartTimeSetId();
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
    this.formStudentRows.set([]);
    this.buildCandidateRows([]);
    this.formDurationHours = this.defaultDurationHours();
    this.formClassStartTimeSetId = this.defaultClassStartTimeSetId();
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
    this.formStudentRows.set([]);
    this.buildCandidateRows(w.candidates ?? []);
    this.formDurationHours = String(w.durationHours);
    this.formClassStartTimeSetId = w.classStartTimeSet?.id ?? this.defaultClassStartTimeSetId();
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

  // ── Student roster (INDIVIDUALLY) ───────────────────────────────────────

  /**
   * Sets (or clears, with an empty value) the lecturer supervising one student. Clearing a row
   * that has a stored pairing is how that pairing gets deleted — the row is then skipped on save,
   * and the backend's nested-list reconciliation removes any row not present in the list.
   *
   * One student can only appear once in the roster, so UNIQUE (lecturer_workload_id, student_id)
   * is structurally unreachable here rather than needing to be guarded.
   */
  setRowLecturer(row: StudentRow, value: any) {
    const lecturerId = value == null ? '' : String(value);
    this.formStudentRows.set(this.formStudentRows().map(
      (r) => (r.studentId === row.studentId ? { ...r, lecturerId } : r)));
  }

  /** Clears every row's lecturer, to start the roster over without reopening the modal. */
  clearAllRows() {
    this.formStudentRows.set(this.formStudentRows().map((r) => ({ ...r, lecturerId: '' })));
  }

  assignedCount(): number {
    return this.formStudentRows().filter((r) => r.lecturerId).length;
  }

  // ── Candidate pool ──────────────────────────────────────────────────────

  setCandidateScore(row: CandidateRow, value: any) {
    this.replaceCandidate(row, { desirability: value == null ? '' : String(value) });
  }

  setCandidateMinStudents(row: CandidateRow, value: any) {
    this.replaceCandidate(row, { minStudents: value == null ? '' : String(value) });
  }

  setCandidateMaxStudents(row: CandidateRow, value: any) {
    this.replaceCandidate(row, { maxStudents: value == null ? '' : String(value) });
  }

  private replaceCandidate(row: CandidateRow, patch: Partial<CandidateRow>) {
    this.formCandidates.set(this.formCandidates().map(
      (r) => (r.lecturerId === row.lecturerId ? { ...r, ...patch } : r)));
  }

  /** A student limit is a non-negative integer, or blank. */
  isBadStudentCount(raw: string): boolean {
    const v = raw.trim();
    if (v === '') return false;
    const n = Number(v);
    return !Number.isInteger(n) || n < 0;
  }

  /** The desired count can't exceed the ceiling. */
  hasBadStudentRange(row: CandidateRow): boolean {
    const min = row.minStudents.trim();
    const max = row.maxStudents.trim();
    if (min === '' || max === '') return false;
    if (this.isBadStudentCount(min) || this.isBadStudentCount(max)) return false;
    return Number(min) > Number(max);
  }

  candidateCount(): number {
    return this.formCandidates().filter((r) => r.desirability.trim() !== '').length;
  }

  /** Clears every score, removing the whole pool on the next save. */
  clearCandidates() {
    this.formCandidates.set(this.formCandidates().map((r) => ({ ...r, desirability: '' })));
  }

  /** Out-of-range scores are highlighted rather than silently clamped. */
  isBadScore(row: CandidateRow): boolean {
    const raw = row.desirability.trim();
    if (raw === '') return false;
    const n = Number(raw);
    return !Number.isInteger(n) || n < 1 || n > 100;
  }

  /** "Прізвище І. (90)" lines, best first — shown under the lecturers cell of the workload table. */
  candidateLabels(w: Workload): string[] {
    return (w.candidates ?? [])
      .slice()
      .sort((a, b) => (b.desirability ?? 0) - (a.desirability ?? 0)
        || compareUk(this.lecturerName(a.lecturer), this.lecturerName(b.lecturer)))
      .map((c) => {
        const limit = (t: string) => (c.constraints ?? []).find((x) => x.constraintType === t)?.value;
        const min = limit('MIN_STUDENTS');
        const max = limit('MAX_STUDENTS');
        const students = min != null || max != null
          ? `, студентів ${min ?? '?'}\u2013${max ?? '\u221E'}`
          : '';
        return `${this.lecturerName(c.lecturer)} — ${c.desirability}${students}`;
      });
  }

  save() {
    if (!this.activeWorkingCurriculumItemId && !this.activeCombinedWorkingCurriculumItemId) return;

    const bad = this.formCandidates().find((r) => this.isBadScore(r));
    if (bad) {
      this.formError.set(`Бажаність для «${bad.lecturerLabel}» має бути цілим числом від 1 до 100.`);
      return;
    }
    if (this.isIndividually()) {
      const badCount = this.formCandidates().find(
        (r) => this.isBadStudentCount(r.minStudents) || this.isBadStudentCount(r.maxStudents));
      if (badCount) {
        this.formError.set(`Кількість студентів для «${badCount.lecturerLabel}» має бути цілим невід'ємним числом.`);
        return;
      }
      const badRange = this.formCandidates().find((r) => this.hasBadStudentRange(r));
      if (badRange) {
        this.formError.set(`Бажана кількість студентів для «${badRange.lecturerLabel}» перевищує максимальну.`);
        return;
      }
    }

    const individually = this.isIndividually();
    // Only students with a lecturer chosen become pairings; the rest of the roster is just the
    // list of who is still unassigned, and is not sent.
    const assignedRows = this.formStudentRows().filter((r) => r.lecturerId);
    if (individually && !assignedRows.length) {
      this.formError.set('Оберіть викладача щонайменше для одного студента.');
      return;
    }

    // lecturer_workloads.class_start_time_set_id is NOT NULL, so an empty picker would fail at the
    // database with a message nobody can act on. Caught here instead, in Ukrainian.
    if (!this.formClassStartTimeSetId) {
      this.formError.set('Оберіть набір часів початку занять.');
      return;
    }

    const input: Record<string, any> = {
      // For INDIVIDUALLY items the lecturer list is derived from the pairs rather than picked
      // separately, so `lecturers` can never disagree with who actually supervises whom.
      lecturerIds: individually ? Array.from(new Set(assignedRows.map((r) => r.lecturerId))) : this.formLecturerIds,
      // Academic groups are meaningless once the assignment is per-student; force-clear them (and
      // vice versa below) so switching an item's teaching format never leaves a stale half-state.
      academicGroupIds: individually ? [] : this.formAcademicGroupIds,
      // Combined groups only make sense for SEPARATELY items; force-clear them otherwise so
      // switching a working curriculum item back to TOGETHER also drops any stale assignment.
      combinedGroupIds: this.canUseCombinedGroups() ? this.formCombinedGroupIds : [],
      // Always sent: the nested-list reconciliation reads an empty array as "delete every pairing",
      // which is exactly what a non-INDIVIDUALLY item should end up with.
      studentAssignments: individually
        ? assignedRows.map((r) => (r.id ? { id: r.id, lecturerId: r.lecturerId, studentId: r.studentId }
                                        : { lecturerId: r.lecturerId, studentId: r.studentId }))
        : [],
      // Not user-selectable for individual work — see INDIVIDUAL_DURATION_HOURS.
      durationHours: Number(individually ? INDIVIDUAL_DURATION_HOURS : this.formDurationHours),
      // Non-null in the database, so it is always sent rather than omitted when unchanged.
      classStartTimeSetId: this.formClassStartTimeSetId,
      // `roomIds`/`roomGroupIds` are deliberately absent. Where a class may be held is assigned on
      // the faculty's «Призначення аудиторій» tab and on the discipline's own page, not here, and a
      // many-to-many field left out of the input leaves its rows untouched (see the note in
      // base-entity.ts) — so saving a workload from this modal cannot silently clear either.
    };
    // Exactly one of these two is sent, matching whichever entry point (single item or combined
    // item) the modal was opened from.
    if (this.activeWorkingCurriculumItemId) input['workingCurriculumItemId'] = this.activeWorkingCurriculumItemId;
    if (this.activeCombinedWorkingCurriculumItemId) input['combinedWorkingCurriculumItemId'] = this.activeCombinedWorkingCurriculumItemId;

    const id = this.editingId();
    const op = id ? 'updateLecturerWorkload' : 'createLecturerWorkload';
    // A candidate carries children of its own (its student limits) and the framework's nested
    // lists only go one level deep, so the pool is written separately — see reconcileCandidates.
    const q = id
      ? `mutation($id: ID!, $input: LecturerWorkloadInputPayload!) { lecturerWorkloads { ${op}(id: $id, lecturerWorkload: $input) { isSuccess errorStatus } } }`
      : `mutation($input: LecturerWorkloadInputPayload!) { lecturerWorkloads { ${op}(lecturerWorkload: $input) { isSuccess errorStatus data { id } } } }`;

    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = d.lecturerWorkloads[op];
        if (!res.isSuccess) { this.formError.set(res.errorStatus || 'Помилка операції'); return; }
        const workloadId = id ?? res.data?.id;
        if (!workloadId) { this.closeForm(); this.loadAll(); return; }
        this.reconcileCandidates(String(workloadId));
      },
      error: (e) => this.formError.set(e.message)
    });
  }

  /**
   * Brings the candidate pool in line with the roster: scored rows are created or updated (each
   * carrying its own student limits as a nested list), and a row whose score was cleared is
   * deleted. Untouched rows are skipped, so an unchanged pool costs no requests at all.
   */
  private reconcileCandidates(workloadId: string) {
    const individually = this.isIndividually();
    const ops: any[] = [];

    for (const row of this.formCandidates()) {
      const scored = row.desirability.trim() !== '';
      if (!scored) {
        // Was a candidate, no longer is.
        if (row.id) ops.push(this.gql.request(
          `mutation($id: ID!) { lecturerWorkloadCandidates { deleteLecturerWorkloadCandidate(id: $id) { isSuccess errorStatus } } }`,
          { id: row.id }));
        continue;
      }
      if (row.id && candidateSnapshot(row) === row.original) continue;   // nothing changed

      // Student limits apply to individual work only; for anything else the list is sent empty,
      // which clears whatever was there if the item's format changed.
      const constraints: Record<string, any>[] = [];
      if (individually) {
        if (row.minStudents.trim() !== '') {
          const c: Record<string, any> = { constraintType: 'MIN_STUDENTS', value: Number(row.minStudents) };
          if (row.minStudentsId) c['id'] = row.minStudentsId;
          constraints.push(c);
        }
        if (row.maxStudents.trim() !== '') {
          const c: Record<string, any> = { constraintType: 'MAX_STUDENTS', value: Number(row.maxStudents) };
          if (row.maxStudentsId) c['id'] = row.maxStudentsId;
          constraints.push(c);
        }
      }

      const input: Record<string, any> = {
        lecturerWorkloadId: workloadId,
        lecturerId: row.lecturerId,
        desirability: Number(row.desirability),
        constraints
      };
      ops.push(row.id
        ? this.gql.request(
            `mutation($id: ID!, $input: LecturerWorkloadCandidateInputPayload!) { lecturerWorkloadCandidates { updateLecturerWorkloadCandidate(id: $id, lecturerWorkloadCandidate: $input) { isSuccess errorStatus } } }`,
            { id: row.id, input })
        : this.gql.request(
            `mutation($input: LecturerWorkloadCandidateInputPayload!) { lecturerWorkloadCandidates { createLecturerWorkloadCandidate(lecturerWorkloadCandidate: $input) { isSuccess errorStatus } } }`,
            { input }));
    }

    if (!ops.length) { this.closeForm(); this.loadAll(); return; }
    forkJoin(ops).subscribe({
      next: (results: any[]) => {
        const failed = results
          .map((r) => Object.values(Object.values(r)[0] as any)[0] as any)
          .find((r) => !r.isSuccess);
        if (failed) {
          // The workload itself saved; only part of the pool didn't.
          this.formError.set(`Навантаження збережено, але кандидатів оновлено не повністю: ${failed.errorStatus || 'помилка'}`);
          this.loadAll();
          return;
        }
        this.closeForm();
        this.loadAll();
      },
      error: (e: any) => { this.formError.set(`Навантаження збережено, але кандидатів оновлено не повністю: ${e.message}`); this.loadAll(); }
    });
  }

  // ── Automatic generation: build inputs, run, preview, apply ─────────────

  /**
   * Flattens the loaded tree into the generator's plain input shape. Every workload of the
   * department is included — both those hanging off a single working curriculum item and those on a
   * combined item — because a lecturer's annual load spans all of them.
   */
  private buildGenWorkloads(): GenWorkload[] {
    const out: GenWorkload[] = [];
    this.durationByWorkload.clear();
    this.startTimeSetByWorkload.clear();

    for (const group of this.groups()) {
      for (const hg of group.hoursGroups) {
        for (const wci of hg.items) {
          // An elective group's real discipline is the chosen elective, not the container.
          const course = wci.course ?? group.course;
          for (const w of wci.workloads) {
            this.durationByWorkload.set(w.id, w.durationHours);
            this.startTimeSetByWorkload.set(w.id, w.classStartTimeSet?.id ?? '');
            out.push({
              id: w.id,
              lecturerCount: wci.lecturerCount || 1,
              assignedLecturerIds: (w.lecturers ?? []).map((l) => l.id),
              candidates: (w.candidates ?? []).map((c) => ({
                lecturerId: c.lecturer.id,
                desirability: c.desirability,
                minStudents: (c.constraints ?? []).find((x) => x.constraintType === 'MIN_STUDENTS')?.value ?? null,
                maxStudents: (c.constraints ?? []).find((x) => x.constraintType === 'MAX_STUDENTS')?.value ?? null
              })),
              hours: hg.hours ?? 0,
              hourType: hg.hourType as any,
              courseId: course.id,
              courseType: (course as any).courseType ?? group.course.courseType,
              teachingFormat: (wci.teachingFormat as any) ?? 'TOGETHER',
              studentIds: this.studentsByWorkload.get(w.id),
              assignedStudents: (w.studentAssignments ?? []).map((a) => ({
                studentId: a.student.id, lecturerId: a.lecturer.id
              })),
              label: `${courseLabel(group.course.name, group.course.tags)} · ${this.hourTypeLabel(hg.hourType)} · семестр ${group.semester}`
            });
          }
        }
      }
    }

    for (const c of this.combinedItems()) {
      const first = c.workingCurriculumItems[0];
      if (!first) continue;
      const ci = first.curriculumItemHours.curriculumItem;
      for (const w of c.workloads) {
        this.durationByWorkload.set(w.id, w.durationHours);
        this.startTimeSetByWorkload.set(w.id, w.classStartTimeSet?.id ?? '');
        out.push({
          id: w.id,
          lecturerCount: 1,
          assignedLecturerIds: (w.lecturers ?? []).map((l) => l.id),
          candidates: (w.candidates ?? []).map((x) => ({
            lecturerId: x.lecturer.id, desirability: x.desirability,
            minStudents: null, maxStudents: null
          })),
          hours: first.curriculumItemHours.hours ?? 0,
          hourType: first.curriculumItemHours.hourType as any,
          courseId: ci.course.id,
          courseType: (ci.course as any).courseType ?? 'MANDATORY',
          teachingFormat: 'TOGETHER',
          label: `${courseLabel(ci.course.name, ci.course.tags)} · ${this.hourTypeLabel(first.curriculumItemHours.hourType)} · семестр ${ci.semester} (об'єднана)`
        });
      }
    }
    return out;
  }

  /** INDIVIDUALLY workloads need their students up front; one aliased query covers every group. */
  private loadStudentsForGeneration(workloads: GenWorkload[], done: () => void) {
    const groupsByWorkload = new Map<string, GroupRef[]>();
    for (const group of this.groups()) {
      for (const hg of group.hoursGroups) {
        for (const wci of hg.items) {
          if (!this.isIndividuallyItem(wci)) continue;
          for (const w of wci.workloads) groupsByWorkload.set(w.id, wci.academicGroups ?? []);
        }
      }
    }
    const groupIds = Array.from(new Set(
      Array.from(groupsByWorkload.values()).flat().map((g) => g.id)));
    if (!groupIds.length) { done(); return; }

    const parts = groupIds
      .map((id, i) => `g${i}: studentConnection(limit: 500, offset: 0, academicGroupId: "${id}") { nodes { id } }`)
      .join(' ');
    this.gql.request(`{ students { ${parts} } }`).subscribe({
      next: (d: any) => {
        const byGroup = new Map<string, string[]>();
        groupIds.forEach((id, i) => {
          byGroup.set(id, (d.students?.[`g${i}`]?.nodes ?? []).map((n: any) => n.id));
        });
        this.studentsByWorkload.clear();
        for (const [workloadId, groups] of groupsByWorkload) {
          const ids = new Set<string>();
          for (const g of groups) for (const s of byGroup.get(g.id) ?? []) ids.add(s);
          this.studentsByWorkload.set(workloadId, Array.from(ids));
        }
        for (const w of workloads) w.studentIds = this.studentsByWorkload.get(w.id);
        done();
      },
      error: () => done()
    });
  }

  generate() {
    this.genError.set('');
    this.genResult.set(null);
    this.genRunning.set(true);
    const workloads = this.buildGenWorkloads();
    this.loadStudentsForGeneration(workloads, () => {
      try {
        this.genResult.set(generateWorkloads({
          workloads,
          lecturers: this.genLecturers(),
          defaultMaxHoursPerYear: this.defaultMaxHoursPerYear(),
          mode: this.genMode()
        }));
      } catch (e: any) {
        this.genError.set(e?.message ?? 'Не вдалося сформувати навантаження.');
      }
      this.genRunning.set(false);
    });
  }

  discardPlan() { this.genResult.set(null); this.genError.set(''); }

  /** Only the workloads the plan actually changes are written. */
  changedAssignments() {
    return (this.genResult()?.assignments ?? []).filter((a) => a.changed);
  }

  issuesOf(kind: GenIssue['kind']): GenIssue[] {
    return (this.genResult()?.issues ?? []).filter((i) => i.kind === kind);
  }

  applyPlan() {
    const changed = this.changedAssignments();
    if (!changed.length) return;
    this.genApplying.set(true);
    this.genError.set('');

    const ops = changed.map((a) => {
      const input: Record<string, any> = {
        lecturerIds: a.lecturerIds,
        // Required by the input payload even though generation never changes it — see
        // durationByWorkload.
        durationHours: this.durationByWorkload.get(a.workloadId) ?? Number(this.defaultDurationHours()),
        // Same reason as durationHours: non-null in the payload, and generation never changes it.
        classStartTimeSetId: this.startTimeSetByWorkload.get(a.workloadId) || this.defaultClassStartTimeSetId()
      };
      if (a.studentAssignments) {
        input['studentAssignments'] = a.studentAssignments.map((p) => ({
          lecturerId: p.lecturerId, studentId: p.studentId
        }));
      }
      return this.gql.request(
        `mutation($id: ID!, $input: LecturerWorkloadInputPayload!) { lecturerWorkloads { updateLecturerWorkload(id: $id, lecturerWorkload: $input) { isSuccess errorStatus } } }`,
        { id: a.workloadId, input });
    });

    forkJoin(ops).subscribe({
      next: (results: any[]) => {
        const failed = results
          .map((r) => Object.values(Object.values(r)[0] as any)[0] as any)
          .filter((r) => !r.isSuccess);
        this.genApplying.set(false);
        if (failed.length) {
          this.genError.set(`Застосовано частково: ${failed.length} з ${results.length} записів не оновлено (${failed[0].errorStatus || 'помилка'}).`);
        }
        this.loadAll();
      },
      error: (e: any) => { this.genApplying.set(false); this.genError.set(e.message); this.loadAll(); }
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

/** The four editable values of a candidate row, for cheap change detection between loads. */
function candidateSnapshot(row: CandidateRow): string {
  return [row.desirability, row.minStudents, row.maxStudents].map((v) => v.trim()).join('|');
}
