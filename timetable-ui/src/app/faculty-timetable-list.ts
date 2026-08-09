import { Component, Input, OnChanges, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { GqlVars, GraphqlService } from './graphql.service';
import { Option, SearchSelect } from './search-select';
import { DAY_OF_WEEK_OPTIONS, HOUR_TYPE_OPTIONS, SEMESTER_PARITY_OPTIONS, WEEK_PARITY_OPTIONS } from './entities';
import { compareUk } from './sort';
// Types only: the solver itself must not land in the initial bundle. It is reached through the Web
// Worker, and — in the rare host with no `Worker` — through a dynamic import in runSolver().
import type {
  SolverConstraint,
  SolverFixedEntry,
  SolverOptions,
  SolverPlacement,
  SolverConflict,
  SolverProblem,
  SolverProgress,
  SolverRequirement,
  SolverResult
} from './timetable-solver';
import type { SerializedProblem, SolverRequest, SolverResponse } from './timetable-solver.worker';
import { CourseTagRef, courseLabel } from './course-label';

/** How long the solver may run. Small faculties converge in seconds; the longest setting is for a
 *  full re-generation of a large one, where the window-reduction phase keeps paying for a while. */
const SEARCH_BUDGET_OPTIONS: Option[] = [
  { id: '10000', label: '10 секунд' },
  { id: '30000', label: '30 секунд' },
  { id: '60000', label: '1 хвилина' },
  { id: '120000', label: '2 хвилини' }
];

/** Working days a class may be put on — timetable_entries.day_of_week, 1 = Monday. */
const WORKING_DAYS = DAY_OF_WEEK_OPTIONS.map((o) => Number(o.value));

/** How many mutations are sent per GraphQL request when the plan is applied (aliased into one document). */
const APPLY_BATCH = 25;

interface GroupRef {
  id: string;
  name: string;
}

interface RoomRef {
  id: string;
  number: string;
  name?: string | null;
}

interface LecturerRef {
  id: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
}

interface RawEntry {
  id: string;
  dayOfWeek: number;
  weekParity: string;
  classStartTime: { id: string; ordinal: number; startTime: string };
  room: { id: string; number: string };
}

interface RawWorkload {
  id: string;
  durationHours: number;
  classStartTimeSet: { id: string; name: string } | null;
  lecturers: LecturerRef[];
  academicGroups: GroupRef[];
  combinedGroups: { id: string; academicGroups: GroupRef[] }[];
  /** Where the class may be held: the union of these two, empty meaning unrestricted. */
  rooms: RoomRef[];
  roomGroups: { id: string; name: string; rooms: RoomRef[] }[];
  timetableEntries: RawEntry[];
}

interface RawWorkingItem {
  id: string;
  /** Non-empty when merged into a combined_working_curriculum_item — such items are handled via
   *  the combined item instead, so they're skipped here to avoid double-counting their workload. */
  combinedWorkingCurriculumItems: { id: string }[];
  /** The specific elective chosen for this working curriculum item (working_curriculum_items.course_id),
   *  set only when the item's curriculum item course is an ELECTIVE_GROUP — see courseNameFor(). */
  course?: { id: string; name: string; semester?: number | null; tags?: CourseTagRef[] | null } | null;
  curriculumItemHours: { hourType: string; hours: number; curriculumItem: { course: { id: string; name: string; courseType: string; semester?: number | null; tags?: CourseTagRef[] | null } } };
  workloads: RawWorkload[];
}

interface RawCombinedItem {
  id: string;
  // Server-filtered to this faculty and semester parity already (see loadCombinedItems), so
  // members no longer need their own department/semester for client-side filtering.
  workingCurriculumItems: {
    id: string;
    course?: { id: string; name: string; semester?: number | null; tags?: CourseTagRef[] | null } | null;
    curriculumItemHours: { hourType: string; hours: number; curriculumItem: { course: { id: string; name: string; courseType: string; semester?: number | null; tags?: CourseTagRef[] | null } } };
  }[];
  workloads: RawWorkload[];
}

/** The discipline a block belongs to: its id, its bare name for sorting, its label for display. */
interface CourseRef {
  id: string;
  name: string;
  label: string;
}

/** One lecturer_workloads row, normalized regardless of whether it targets a working curriculum
 *  item directly or a combined_working_curriculum_item. */
interface WorkloadSource {
  workloadId: string;
  /** `courses.id` behind courseName — what the block's heading links to. */
  courseId: string;
  /** Bare `courses.name` — what `sortBlocks` collates on. */
  courseName: string;
  /** `courseName` with the course's tags in parentheses — what every heading here shows. */
  courseLabel: string;
  hourType: string;
  hours: number;
  durationHours: number;
  classStartTimeSetId: string | null;
  classStartTimeSetName: string;
  academicGroupNames: string[];
  lecturerNames: string[];
  lecturerIds: string[];
  academicGroupIds: string[];
  /** Eligible rooms (rooms ∪ roomGroups' rooms); empty means "any room of the faculty". */
  roomIds: string[];
  entries: RawEntry[];
}

/** One schedulable class session derived from a workload's required weekly/biweekly class count. */
interface Block {
  key: string;
  workloadId: string;
  entryId: string | null;
  courseId: string;
  /** Bare `courses.name` — sorted on. */
  courseName: string;
  /** `courseName` with the course's tags in parentheses — displayed. */
  courseLabel: string;
  hourType: string;
  durationHours: number;
  academicGroupNames: string[];
  lecturerNames: string[];
  lecturerIds: string[];
  academicGroupIds: string[];
  roomIds: string[];
  isBiweekly: boolean;
  dayOfWeek: number | null;
  /** The grid of bells this class runs on — decided per workload, not per occurrence. */
  classStartTimeSetId: string | null;
  classStartTimeSetName: string;
  classStartTimeId: string | null;
  roomId: string | null;
  weekParity: string; // 'WEEKLY' for non-biweekly blocks; 'NUMERATOR' | 'DENOMINATOR' for biweekly ones
}

interface BlockForm {
  dayOfWeek: string;
  classStartTimeId: string;
  roomId: string;
  weekParity: string;
  /** The server state this form was last seeded from — see `form()`. */
  stamp: string;
}

/** What applying the generated schedule would do, before anything is written. */
interface Plan {
  creates: { block: Block; placement: SolverPlacement }[];
  updates: { block: Block; placement: SolverPlacement }[];
  unchanged: number;
  /** Blocks the generator was told to leave alone (the "fill the gaps" mode). */
  kept: number;
  /**
   * Blocks that are scheduled today but that the solver could not place. Their rows are left
   * exactly as they are: the generator refusing to find a slot is not evidence that the deanery
   * wanted the class removed, and deleting a legal row because a heuristic ran out of options
   * would make "перевизначити весь розклад" destructive.
   */
  unresolved: Block[];
}

type GenerationMode = 'gaps' | 'all';
type GenerationStage = 'loading' | 'solving' | 'preview' | 'applying' | 'done' | 'error';

const PHASE_LABELS: Record<string, string> = {
  PREPARE: 'Підготовка даних',
  CONSTRUCT: 'Початкове розміщення занять',
  REPAIR: 'Усунення накладок',
  WINDOWS: 'Зменшення вікон у розкладі',
  PERTURB: 'Перезапуск пошуку',
  DONE: 'Завершено'
};

/** Selection shared by the three "current timetable around this faculty" queries. */
const EXTERNAL_ENTRY_SELECTION = `nodes {
  id dayOfWeek weekParity
  classStartTime { id startTime }
  room { id }
  workload {
    id durationHours
    lecturers { id }
    academicGroups { id }
    combinedGroups { academicGroups { id } }
  }
}`;

/**
 * Faculty-wide schedule builder: auto-generates one "block" per class session required by every
 * lecturer_workload delivered by the faculty's departments (based on curriculum_item_hours.hours,
 * the semester_duration_weeks global property, and each workload's own duration_hours — see
 * classCounts()), and lets the user assign each block a day of week, class start time and room
 * (plus week parity for biweekly blocks), creating/updating/deleting the corresponding
 * timetable_entries row.
 *
 * Those blocks can also be filled in automatically: "Згенерувати розклад" hands them to the
 * client-side solver in `timetable-solver.ts` (running in a Web Worker), together with every
 * scheduling constraint that applies and with the *current* timetable of the rooms, lecturers and
 * groups this faculty shares with the rest of the university. Those shared classes are read but
 * never moved — see TIMETABLE-GENERATION.md.
 */
@Component({
  selector: 'app-faculty-timetable-list',
  templateUrl: './faculty-timetable-list.html',
  imports: [FormsModule, RouterLink, SearchSelect]
})
export class FacultyTimetableList implements OnInit, OnChanges, OnDestroy {
  private gql = inject(GraphqlService);

  @Input() facultyId!: string;

  readonly HOUR_TYPE_OPTIONS = HOUR_TYPE_OPTIONS;
  readonly DAY_OF_WEEK_OPTIONS: Option[] = DAY_OF_WEEK_OPTIONS.map((o) => ({ id: o.value, label: o.label }));
  readonly BIWEEKLY_PARITY_OPTIONS: Option[] = WEEK_PARITY_OPTIONS
    .filter((o) => o.value !== 'WEEKLY')
    .map((o) => ({ id: o.value, label: o.label }));
  readonly SEMESTER_PARITY_OPTIONS = SEMESTER_PARITY_OPTIONS;
  readonly SEARCH_BUDGET_OPTIONS = SEARCH_BUDGET_OPTIONS;

  /** Which semester (by parity) to build the schedule for; defaults to the current_semester_parity
   *  global property once it loads (see loadGlobalProperties), but the user can override it. */
  selectedSemesterParity = signal('ODD');

  /** semester_duration_weeks / academic_hour_duration_minutes global properties — used to compute
   *  how many classes a workload's total hours require (see classCounts) and each class's end time
   *  (see endTimeFor). Defaults match data.sql's seed values until loadGlobalProperties resolves. */
  semesterDurationWeeks = signal(16);
  academicHourDurationMinutes = signal(40);

  private wciItems = signal<RawWorkingItem[]>([]);
  private combinedItems = signal<RawCombinedItem[]>([]);

  roomOptions = signal<Option[]>([]);
  /** Rooms belonging to this faculty — the domain a workload with no room restriction may use. */
  private facultyRoomIds = signal<string[]>([]);

  // Every derived view of the bells is a computed over one signal, not a Map filled by a
  // subscription. The blocks list sorts by start-time ordinal, so if the ordinals lived in a plain
  // Map the blocks computed would never be invalidated when they arrived — and since the times and
  // the items are independent requests, a late times response left the list mis-sorted (and an
  // early "Згенерувати" would have handed the solver no bells at all).
  private classStartTimes = signal<{ id: string; setId: string; ordinal: number; startTime: string }[]>([]);
  /** setId -> that set's times, in ordinal order. */
  private classStartTimeOptionsBySet = computed(() => {
    const bySet = new Map<string, Option[]>();
    for (const t of this.classStartTimes()) {
      const list = bySet.get(t.setId) ?? [];
      list.push({ id: t.id, label: `${t.ordinal}. ${t.startTime}` });
      bySet.set(t.setId, list);
    }
    return bySet;
  });
  private classStartTimeOrdinals = computed(() => new Map(this.classStartTimes().map((t) => [t.id, t.ordinal])));
  private classStartTimeStarts = computed(() => new Map(this.classStartTimes().map((t) => [t.id, t.startTime])));

  error = signal('');
  actionError = signal('');

  /** Per-block editable selection, keyed by Block.key — see `form()`. */
  formState: Record<string, BlockForm> = {};

  blocks = computed(() => this.buildBlocks());

  // ── Generation state ──────────────────────────────────────────────────────

  genMode = signal<GenerationMode>('gaps');
  genBudget = signal('30000');
  genOpen = signal(false);
  genStage = signal<GenerationStage>('loading');
  genProgress = signal<SolverProgress | null>(null);
  genResult = signal<SolverResult | null>(null);
  genPlan = signal<Plan | null>(null);
  genError = signal('');
  genLoadingStep = signal('');
  applyDone = signal(0);
  applyTotal = signal(0);

  private worker: Worker | null = null;
  private cancelRequested = false;
  private genBusy = false;
  private pendingBlocks: Block[] = [];

  private initialized = false;
  /** True once the global properties (current_semester_parity, semester_duration_weeks,
   *  academic_hour_duration_minutes) have been resolved (or given up on) — see
   *  loadGlobalProperties, which items loading waits on so the first request already uses the
   *  right parity instead of firing once with a placeholder default and again right after. */
  private parityResolved = false;

  ngOnInit() {
    this.initialized = true;
    this.loadClassStartTimes();
    if (this.facultyId) {
      this.loadRooms();
      this.loadGlobalProperties();
    }
  }

  ngOnChanges() {
    if (!this.initialized || !this.facultyId) return;
    this.loadRooms();
    if (this.parityResolved) this.loadItems();
    else this.loadGlobalProperties();
  }

  ngOnDestroy() {
    this.worker?.terminate();
    this.worker = null;
  }

  /**
   * A semester or faculty change fires both item loaders again. The token drops a response that
   * belongs to a selection the user has already moved off — without it, a slow first request can
   * land after a fast second one and win. Both loaders of one round share the token.
   */
  private loadToken = 0;

  private loadItems() {
    const token = ++this.loadToken;
    this.loadWorkingCurriculumItems(token);
    this.loadCombinedItems(token);
  }

  onParityChange(value: string) {
    this.selectedSemesterParity.set(value);
    this.loadItems();
  }

  // Filtered server-side by facultyId (an EXISTS subquery through departments) and semesterParity
  // (an EXISTS subquery through curriculum_item_hours/curriculum_items) — see
  // CurriculumSchemaConfig#configureWorkingCurriculumItem — so there's no need to fetch every
  // working curriculum item in the system and narrow it down client-side.
  private loadWorkingCurriculumItems(token: number) {
    const q =`query($facultyId: ID, $semesterParity: String, $limit: Int!, $offset: Int!) { workingCurriculumItems { workingCurriculumItemConnection(limit: $limit, offset: $offset, facultyId: $facultyId, semesterParity: $semesterParity) { nodes {
      id
      combinedWorkingCurriculumItems { id }
      course { id name semester tags { tag } }
      curriculumItemHours { hourType hours curriculumItem { course { id name courseType semester tags { tag } } } }
      workloads { ${WORKLOAD_SELECTION} }
    } } } }`;
    this.gql.request(q, { facultyId: this.facultyId, semesterParity: this.selectedSemesterParity(), limit: 5000, offset: 0 }).subscribe({
      next: (d: any) => {
        if (token !== this.loadToken) return;
        this.wciItems.set(d.workingCurriculumItems.workingCurriculumItemConnection.nodes);
        this.error.set('');
      },
      error: (e) => { if (token === this.loadToken) this.error.set(e.message); }
    });
  }

  // Filtered server-side by facultyId and semesterParity (EXISTS subqueries through the member
  // working curriculum items — see CurriculumSchemaConfig#configureCombinedWorkingCurriculumItem),
  // so there's no need to fetch every combined item in the system and narrow it down client-side.
  private loadCombinedItems(token: number) {
    const q = `query($facultyId: ID, $semesterParity: String, $limit: Int!, $offset: Int!) { combinedWorkingCurriculumItems { combinedWorkingCurriculumItemConnection(limit: $limit, offset: $offset, facultyId: $facultyId, semesterParity: $semesterParity) { nodes {
      id
      workingCurriculumItems {
        id
        course { id name semester tags { tag } }
        curriculumItemHours { hourType hours curriculumItem { course { id name courseType semester tags { tag } } } }
      }
      workloads { ${WORKLOAD_SELECTION} }
    } } } }`;
    this.gql.request(q, { facultyId: this.facultyId, semesterParity: this.selectedSemesterParity(), limit: 2000, offset: 0 }).subscribe({
      next: (d: any) => {
        if (token !== this.loadToken) return;
        this.combinedItems.set(d.combinedWorkingCurriculumItems.combinedWorkingCurriculumItemConnection.nodes);
        this.error.set('');
      },
      error: (e) => { if (token === this.loadToken) this.error.set(e.message); }
    });
  }

  private loadGlobalProperties() {
    const q = `query($parityName: ID!, $weeksName: ID!, $hourMinutesName: ID!) { globalProperties {
      parity: globalProperty(name: $parityName) { value }
      weeks: globalProperty(name: $weeksName) { value }
      hourMinutes: globalProperty(name: $hourMinutesName) { value }
    } }`;
    this.gql.request(q, { parityName: 'current_semester_parity', weeksName: 'semester_duration_weeks', hourMinutesName: 'academic_hour_duration_minutes' }).subscribe({
      next: (d: any) => {
        const props = d.globalProperties;
        const parity = props.parity?.value;
        if (parity === 'ODD' || parity === 'EVEN') this.selectedSemesterParity.set(parity);
        const weeks = Number(props.weeks?.value);
        if (weeks > 0) this.semesterDurationWeeks.set(weeks);
        const hourMinutes = Number(props.hourMinutes?.value);
        if (hourMinutes > 0) this.academicHourDurationMinutes.set(hourMinutes);
        this.parityResolved = true;
        this.loadItems();
      },
      error: () => {
        // keep the defaults if the properties can't be read, but still proceed with loading
        this.parityResolved = true;
        this.loadItems();
      }
    });
  }

  private loadRooms() {
    const q = `query($facultyId: ID, $limit: Int!) { rooms { roomConnection(limit: $limit, facultyId: $facultyId) { nodes { id number name } } } }`;
    this.gql.request(q, { facultyId: this.facultyId, limit: 1000 }).subscribe({
      next: (d: any) => {
        const nodes = d.rooms.roomConnection.nodes as RoomRef[];
        this.facultyRoomIds.set(nodes.map((r) => r.id));
        this.mergeRoomOptions(nodes);
      },
      error: () => {}
    });
  }

  /**
   * Rooms are not only this faculty's: a workload may name a room (or a room group) belonging to
   * another faculty or to none, and an already-scheduled entry may sit in one. The dropdown has to
   * offer every such room, or opening the page would silently blank the room of an entry it can't
   * name.
   */
  private mergeRoomOptions(rooms: RoomRef[]) {
    const byId = new Map<string, Option>();
    for (const o of this.roomOptions()) byId.set(o.id, o);
    for (const r of rooms) {
      if (!r?.id) continue;
      byId.set(r.id, { id: r.id, label: r.name ? `${r.number} (${r.name})` : r.number });
    }
    this.roomOptions.set(Array.from(byId.values()).sort((a, b) => compareUk(a.label, b.label)));
  }

  /**
   * Loads every start time, grouped by the set it belongs to.
   *
   * A flat list would be wrong now that ordinals restart within each set: "2. 10:10" and
   * "2. 10:40" would sit side by side in one dropdown with nothing to tell them apart, and a class
   * could be scheduled on bells its workload does not run on. Each block is therefore offered only
   * its own set's times — see classStartTimeOptionsFor.
   */
  private loadClassStartTimes() {
    const q = `query($limit: Int!) { classStartTimes { classStartTimeConnection(limit: $limit) { nodes {
      id ordinal startTime classStartTimeSet { id }
    } } } }`;
    this.gql.request(q, { limit: 500 }).subscribe({
      next: (d: any) => {
        const nodes = [...d.classStartTimes.classStartTimeConnection.nodes]
          .sort((a: any, b: any) => a.ordinal - b.ordinal);
        this.classStartTimes.set(nodes.map((t: any) => ({
          id: t.id, setId: t.classStartTimeSet?.id ?? '', ordinal: t.ordinal, startTime: t.startTime
        })));
      },
      error: () => {}
    });
  }

  /** End time of a class starting at `startTime` and lasting `durationHours` academic hours,
   *  using the academic_hour_duration_minutes global property (see loadGlobalProperties). */
  private endTimeFor(startTime: string, durationHours: number): string {
    const [h, m] = startTime.split(':').map(Number);
    const total = h * 60 + m + durationHours * this.academicHourDurationMinutes();
    const hh = Math.floor(total / 60) % 24;
    const mm = total % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  /**
   * The editable selection for a block, seeded from the server and refreshed only when the server
   * value it was seeded from actually changed.
   *
   * Seeding used to happen inside `buildBlocks`, which is a `computed` — so every reload (after
   * saving one block, say) silently reset every *other* block's in-progress selection, and a
   * computed was writing to state besides. Comparing the stamp keeps unsaved edits across a reload
   * while still picking up a block whose stored entry really did change.
   */
  form(block: Block): BlockForm {
    const stamp = [block.entryId ?? '', block.dayOfWeek ?? '', block.classStartTimeId ?? '',
                   block.roomId ?? '', block.weekParity].join('|');
    const seed = (): BlockForm => ({
      dayOfWeek: block.dayOfWeek != null ? String(block.dayOfWeek) : '',
      classStartTimeId: block.classStartTimeId ?? '',
      roomId: block.roomId ?? '',
      weekParity: block.weekParity,
      stamp
    });
    const existing = this.formState[block.key];
    if (!existing) return (this.formState[block.key] = seed());
    if (existing.stamp !== stamp) Object.assign(existing, seed());
    return existing;
  }

  /** Computed end time for a block's currently-selected class start time, or '' if none selected yet. */
  computedEndTime(block: Block): string {
    const start = this.classStartTimeStarts().get(this.form(block).classStartTimeId);
    return start ? this.endTimeFor(start, block.durationHours) : '';
  }

  private lecturerName(l: LecturerRef): string {
    return [l.lastName, l.firstName, l.middleName].filter(Boolean).join(' ');
  }

  /** Union of a workload's own academic groups and every combined group's member groups (the
   *  students actually attending), deduplicated by id. */
  private academicGroupsFor(w: RawWorkload): GroupRef[] {
    const byId = new Map<string, GroupRef>();
    for (const g of w.academicGroups ?? []) byId.set(g.id, g);
    for (const cg of w.combinedGroups ?? []) {
      for (const g of cg.academicGroups ?? []) byId.set(g.id, g);
    }
    return Array.from(byId.values());
  }

  /** Where a workload's classes may be held: the union of its named rooms and its room groups'
   *  rooms. An empty union is not "nowhere" but "anywhere" — see the backend README. */
  private eligibleRoomsFor(w: RawWorkload): RoomRef[] {
    const byId = new Map<string, RoomRef>();
    for (const r of w.rooms ?? []) byId.set(r.id, r);
    for (const rg of w.roomGroups ?? []) {
      for (const r of rg.rooms ?? []) byId.set(r.id, r);
    }
    return Array.from(byId.values());
  }

  /**
   * The discipline course of a working curriculum item is normally its curriculum item's course.
   * But when that course is an ELECTIVE_GROUP (a group of electives students choose between), the
   * curriculum item's course is just the umbrella group — the actual discipline being taught is
   * the specific elective referenced by working_curriculum_items.course_id.
   */
  private courseRefFor(wci: { course?: { id: string; name: string; semester?: number | null; tags?: CourseTagRef[] | null } | null; curriculumItemHours: { curriculumItem: { course: { id: string; name: string; courseType: string; semester?: number | null; tags?: CourseTagRef[] | null } } } }): CourseRef {
    const ci = wci.curriculumItemHours.curriculumItem;
    const c = ci.course.courseType === 'ELECTIVE_GROUP' && wci.course ? wci.course : ci.course;
    // Both, not one: the label is what every heading on this board shows, the raw name is what
    // `sortBlocks` collates on — folding tags into that would let the tag text drive the ordering
    // and split two same-named disciplines apart.
    return { id: c.id, name: c.name, label: courseLabel(c.name, c.tags, c.semester) };
  }

  private toSource(w: RawWorkload, course: CourseRef, hourType: string, hours: number): WorkloadSource {
    const groups = this.academicGroupsFor(w);
    const rooms = this.eligibleRoomsFor(w);
    return {
      workloadId: w.id,
      courseId: course.id,
      courseName: course.name,
      courseLabel: course.label,
      hourType,
      hours,
      durationHours: w.durationHours,
      classStartTimeSetId: w.classStartTimeSet?.id ?? null,
      classStartTimeSetName: w.classStartTimeSet?.name ?? '',
      academicGroupNames: groups.map((g) => g.name).sort(compareUk),
      academicGroupIds: groups.map((g) => g.id),
      lecturerNames: (w.lecturers ?? []).map((l) => this.lecturerName(l)),
      lecturerIds: (w.lecturers ?? []).map((l) => l.id),
      roomIds: rooms.map((r) => r.id),
      entries: w.timetableEntries ?? []
    };
  }

  private sources(): WorkloadSource[] {
    const out: WorkloadSource[] = [];

    // Already scoped to this faculty and semester parity server-side (see
    // loadWorkingCurriculumItems), no client-side filtering needed.
    for (const wci of this.wciItems()) {
      if ((wci.combinedWorkingCurriculumItems ?? []).length > 0) continue;
      const cih = wci.curriculumItemHours;
      const course = this.courseRefFor(wci);
      for (const w of wci.workloads ?? []) out.push(this.toSource(w, course, cih.hourType, cih.hours));
    }

    // Already scoped to this faculty and semester parity server-side (see loadCombinedItems), no
    // client-side filtering needed.
    for (const c of this.combinedItems()) {
      const first = c.workingCurriculumItems[0];
      if (!first) continue;
      const cih = first.curriculumItemHours;
      const course = this.courseRefFor(first);
      for (const w of c.workloads ?? []) out.push(this.toSource(w, course, cih.hourType, cih.hours));
    }

    return out;
  }

  /**
   * How many classes-per-week a workload's total hours require over a semester of
   * semesterDurationWeeks weeks, where one lesson = durationHours academic hours (e.g. 16 weeks *
   * 2h = 32h ≈ one weekly-recurring class). A remainder of at least half a weekly class becomes one
   * additional class held every other week (biweekly): e.g. 32h → 1 weekly class; 80h → 80/32 = 2.5
   * → 2 weekly classes + 1 biweekly class.
   */
  private classCounts(hours: number, durationHours: number, semesterWeeks: number): { weekly: number; biweekly: boolean } {
    const hoursPerWeeklyClass = semesterWeeks * durationHours;
    const perWeek = hoursPerWeeklyClass > 0 ? hours / hoursPerWeeklyClass : 0;
    const weekly = Math.floor(perWeek + 1e-9);
    const remainder = perWeek - weekly;
    return { weekly, biweekly: remainder >= 0.5 - 1e-9 };
  }

  private buildBlocks(): Block[] {
    const blocks: Block[] = [];
    const semesterWeeks = this.semesterDurationWeeks();

    for (const s of this.sources()) {
      const { weekly, biweekly } = this.classCounts(s.hours, s.durationHours, semesterWeeks);
      const weeklyEntries = s.entries.filter((e) => e.weekParity === 'WEEKLY');
      const biweeklyEntries = s.entries.filter((e) => e.weekParity !== 'WEEKLY');

      const weeklyTotal = Math.max(weekly, weeklyEntries.length);
      for (let i = 0; i < weeklyTotal; i++) blocks.push(this.makeBlock(s, weeklyEntries[i] ?? null, false, i));

      const biweeklyTotal = Math.max(biweekly ? 1 : 0, biweeklyEntries.length);
      for (let i = 0; i < biweeklyTotal; i++) blocks.push(this.makeBlock(s, biweeklyEntries[i] ?? null, true, i));
    }

    return this.sortBlocks(blocks);
  }

  private makeBlock(s: WorkloadSource, entry: RawEntry | null, isBiweekly: boolean, index: number): Block {
    // Position-based key (not entry id) so an unscheduled block keeps its form state stable across
    // the reload that follows scheduling it.
    const key = `${s.workloadId}::${isBiweekly ? 'bi' : 'wk'}::${index}`;
    const block: Block = {
      key,
      workloadId: s.workloadId,
      entryId: entry?.id ?? null,
      courseId: s.courseId,
      courseName: s.courseName,
      courseLabel: s.courseLabel,
      hourType: s.hourType,
      durationHours: s.durationHours,
      academicGroupNames: s.academicGroupNames,
      lecturerNames: s.lecturerNames,
      lecturerIds: s.lecturerIds,
      academicGroupIds: s.academicGroupIds,
      roomIds: s.roomIds,
      isBiweekly,
      dayOfWeek: entry?.dayOfWeek ?? null,
      classStartTimeSetId: s.classStartTimeSetId,
      classStartTimeSetName: s.classStartTimeSetName,
      classStartTimeId: entry?.classStartTime?.id ?? null,
      roomId: entry?.room?.id ?? null,
      weekParity: entry?.weekParity ?? (isBiweekly ? 'NUMERATOR' : 'WEEKLY')
    };
    return block;
  }

  private sortBlocks(blocks: Block[]): Block[] {
    const parityOrder = ['WEEKLY', 'NUMERATOR', 'DENOMINATOR'];
    const scheduled = blocks.filter((b) => b.dayOfWeek != null);
    const unscheduled = blocks.filter((b) => b.dayOfWeek == null);

    unscheduled.sort((a, b) => compareUk(a.courseName, b.courseName));
    scheduled.sort((a, b) =>
      (a.dayOfWeek! - b.dayOfWeek!) ||
      (this.classStartTimeOrdinal(a.classStartTimeId) - this.classStartTimeOrdinal(b.classStartTimeId)) ||
      (parityOrder.indexOf(a.weekParity) - parityOrder.indexOf(b.weekParity)) ||
      compareUk(a.courseName, b.courseName)
    );

    // Unscheduled blocks are displayed from the beginning, ahead of every scheduled one.
    return [...unscheduled, ...scheduled];
  }

  private classStartTimeOrdinal(id: string | null): number {
    return id ? this.classStartTimeOrdinals().get(id) ?? 0 : 0;
  }

  /**
   * The times a block may be scheduled at: only those of the grid its workload runs on. Offering
   * every set's times would let a physical-education class be put on the main bells, which is the
   * very thing the sets exist to prevent — and the ordinals would collide in the dropdown.
   */
  classStartTimeOptionsFor(block: Block): Option[] {
    return this.classStartTimeOptionsBySet().get(block.classStartTimeSetId ?? '') ?? [];
  }

  unscheduledCount(): number {
    return this.blocks().filter((b) => b.dayOfWeek == null).length;
  }

  hourTypeLabel(v: string): string {
    return this.HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  groupNames(b: Block): string {
    return b.academicGroupNames.join(', ') || '—';
  }

  /**
   * The block's lecturers as ids and names, so the header can link each to their own page.
   * `lecturerNames` and `lecturerIds` are parallel arrays built together in {@link toSource}.
   */
  lecturerRefs(b: Block): { id: string; name: string }[] {
    return b.lecturerIds.map((id, i) => ({ id, name: b.lecturerNames[i] ?? '' }));
  }

  lecturerNamesLabel(b: Block): string {
    return b.lecturerNames.join(', ') || '—';
  }

  canSave(block: Block): boolean {
    const f = this.form(block);
    return !!f.dayOfWeek && !!f.classStartTimeId && !!f.roomId && (!block.isBiweekly || !!f.weekParity);
  }

  save(block: Block) {
    const f = this.form(block);
    if (!this.canSave(block)) return;
    const input = {
      dayOfWeek: Number(f.dayOfWeek),
      weekParity: block.isBiweekly ? f.weekParity : 'WEEKLY',
      workloadId: block.workloadId,
      classStartTimeId: f.classStartTimeId,
      roomId: f.roomId
    };
    this.actionError.set('');
    const op = block.entryId ? 'updateTimetableEntry' : 'createTimetableEntry';
    const q = block.entryId
      ? `mutation($id: ID!, $input: TimetableEntryInputPayload!) { timetableEntries { ${op}(id: $id, timetableEntry: $input) { isSuccess errorStatus } } }`
      : `mutation($input: TimetableEntryInputPayload!) { timetableEntries { ${op}(timetableEntry: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, block.entryId ? { id: block.entryId, input } : { input }).subscribe({
      next: (d: any) => {
        const res = d.timetableEntries[op];
        if (res.isSuccess) this.reloadItems();
        else this.actionError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.actionError.set(e.message)
    });
  }

  remove(block: Block) {
    if (!block.entryId) return;
    this.actionError.set('');
    const q = `mutation($id: ID!) { timetableEntries { deleteTimetableEntry(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: block.entryId }).subscribe({
      next: (d: any) => {
        const res = d.timetableEntries.deleteTimetableEntry;
        if (res.isSuccess) this.reloadItems();
        else this.actionError.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.actionError.set(e.message)
    });
  }

  private reloadItems() {
    this.loadItems();
  }

  // ── Automatic generation ──────────────────────────────────────────────────

  private request<T = any>(query: string, variables: Record<string, any> = {}): Promise<T> {
    return firstValueFrom(this.gql.request<T>(query, variables));
  }

  /** Blocks the generator is allowed to move, given the chosen mode. */
  private targetBlocks(mode: GenerationMode): Block[] {
    const all = this.blocks();
    return mode === 'all' ? all : all.filter((b) => b.entryId == null);
  }

  generatableCount(): number {
    return this.targetBlocks(this.genMode()).length;
  }

  setMode(mode: GenerationMode) {
    this.genMode.set(mode);
  }

  async generate() {
    // Without this, closing the modal and starting again would queue a second `solve` behind a
    // still-running first one, and the *old* result would arrive first and be planned against the
    // new block list.
    if (this.genBusy) return;
    if (this.generatableCount() === 0) return;
    this.genBusy = true;
    this.cancelRequested = false;
    this.genError.set('');
    this.genResult.set(null);
    this.genPlan.set(null);
    this.genProgress.set(null);
    this.applyDone.set(0);
    this.applyTotal.set(0);
    this.genStage.set('loading');
    this.genOpen.set(true);

    try {
      const problem = await this.buildProblem();
      if (this.cancelRequested) { this.genOpen.set(false); return; }
      this.genStage.set('solving');
      await this.runSolver(problem);
    } catch (e) {
      this.genBusy = false;
      this.genError.set(e instanceof Error ? e.message : String(e));
      this.genStage.set('error');
    }
  }

  /**
   * Collects everything the solver needs, in four requests:
   *
   *  1. the scheduling constraints of every lecturer, academic group and room of this faculty;
   *  2. the same for the handful of lecturers / groups / rooms a workload reaches outside it —
   *     a lecturer of another department teaching for us, a room belonging to another faculty;
   *  3. the current timetable of those rooms, lecturers and groups, whoever owns the classes;
   *  4. (already in memory) the blocks, bells and global properties the page is built on.
   *
   * Step 3 is what makes cross-faculty scheduling correct: a room of ours also hosts other
   * faculties' classes, our lecturers also teach their specialties, and our groups are also taught
   * by their departments. Those entries are loaded as *immovable* — the generator schedules around
   * them and never rewrites them.
   */
  private async buildProblem(): Promise<SolverProblem> {
    const mode = this.genMode();
    const all = this.blocks();
    const target = new Set(this.targetBlocks(mode).map((b) => b.key));
    this.pendingBlocks = all;

    const lecturerIds = new Set<string>();
    const groupIds = new Set<string>();
    const roomIds = new Set<string>(this.facultyRoomIds());
    const workloadIds = new Set<string>();
    for (const b of all) {
      b.lecturerIds.forEach((id) => lecturerIds.add(id));
      b.academicGroupIds.forEach((id) => groupIds.add(id));
      b.roomIds.forEach((id) => roomIds.add(id));
      if (b.roomId) roomIds.add(b.roomId);
      workloadIds.add(b.workloadId);
    }

    this.genLoadingStep.set('Читаємо обмеження розкладу факультету…');
    const scoped = await this.request(`query($facultyId: ID, $limit: Int!, $travelLimit: Int!, $offset: Int!) {
      lecturers { lecturerConnection(limit: $limit, facultyId: $facultyId) { nodes {
        id timetableConstraints { constraintType dayOfWeek constraintValue } } } }
      academicGroups { academicGroupConnection(limit: $limit, facultyId: $facultyId) { nodes {
        id timetableConstraints { constraintType dayOfWeek constraintValue } } } }
      rooms { roomConnection(limit: $limit, facultyId: $facultyId) { nodes {
        id number name building { id }
        timetableConstraints { constraintType dayOfWeek constraintValue } } } }
      buildingTravelTimes { buildingTravelTimeConnection(limit: $travelLimit, offset: $offset) { nodes {
        minutes fromBuilding { id } toBuilding { id } } } }
    }`, { facultyId: this.facultyId, limit: 2000, travelLimit: 5000, offset: 0 });

    const lecturerConstraints = new Map<string, SolverConstraint[]>();
    const groupConstraints = new Map<string, SolverConstraint[]>();
    const roomConstraints = new Map<string, SolverConstraint[]>();
    // Where each room is, and how long it takes to get between two of those places. A room with no
    // building contributes nothing — see the solver's `roomBuilding`, which reads absence as
    // "no journey" rather than inventing one.
    const roomBuilding = new Map<string, string>();
    const buildingTravel = new Map<string, number>();
    for (const t of scoped.buildingTravelTimes?.buildingTravelTimeConnection?.nodes ?? []) {
      const from = t.fromBuilding?.id, to = t.toBuilding?.id;
      if (from && to && t.minutes != null) buildingTravel.set(`${from}>${to}`, t.minutes);
    }
    const known = { lecturer: new Set<string>(), group: new Set<string>(), room: new Set<string>() };

    for (const n of scoped.lecturers.lecturerConnection.nodes) {
      known.lecturer.add(n.id);
      lecturerConstraints.set(n.id, toConstraints(n.timetableConstraints));
    }
    for (const n of scoped.academicGroups.academicGroupConnection.nodes) {
      known.group.add(n.id);
      groupConstraints.set(n.id, toConstraints(n.timetableConstraints));
    }
    const scopedRooms: RoomRef[] = scoped.rooms.roomConnection.nodes;
    for (const n of scoped.rooms.roomConnection.nodes) {
      known.room.add(n.id);
      roomConstraints.set(n.id, toConstraints(n.timetableConstraints));
      if (n.building?.id) roomBuilding.set(String(n.id), String(n.building.id));
    }
    this.mergeRoomOptions(scopedRooms);

    // A workload may reach outside this faculty — its lecturer may sit in another department, its
    // room may belong to another faculty, its groups may study on another one's specialty. Those
    // few are fetched by id rather than by widening the connections above to the whole university.
    const extraLecturers = [...lecturerIds].filter((id) => !known.lecturer.has(id));
    const extraGroups = [...groupIds].filter((id) => !known.group.has(id));
    const extraRooms = [...roomIds].filter((id) => !known.room.has(id));
    if (extraLecturers.length || extraGroups.length || extraRooms.length) {
      this.genLoadingStep.set('Читаємо обмеження для викладачів, груп та аудиторій інших факультетів…');
      const RULES = 'timetableConstraints { constraintType dayOfWeek constraintValue }';
      const v = new GqlVars();
      const sections = [
        extraLecturers.length
          ? `lecturers { ${extraLecturers.map((id, i) => `l${i}: lecturer(id: ${v.ref(`lecturer${i}`, 'ID!', id)}) { id ${RULES} }`).join('\n')} }` : '',
        extraGroups.length
          ? `academicGroups { ${extraGroups.map((id, i) => `g${i}: academicGroup(id: ${v.ref(`group${i}`, 'ID!', id)}) { id ${RULES} }`).join('\n')} }` : '',
        extraRooms.length
          ? `rooms { ${extraRooms.map((id, i) => `r${i}: room(id: ${v.ref(`room${i}`, 'ID!', id)}) { id number name building { id } ${RULES} }`).join('\n')} }` : ''
      ].filter(Boolean).join('\n');

      const extra = await this.request(`${v.declaration()}{ ${sections} }`, v.values);
      const extraRoomRefs: RoomRef[] = [];
      extraLecturers.forEach((id, i) => {
        const n = extra.lecturers?.[`l${i}`];
        if (n) lecturerConstraints.set(id, toConstraints(n.timetableConstraints));
      });
      extraGroups.forEach((id, i) => {
        const n = extra.academicGroups?.[`g${i}`];
        if (n) groupConstraints.set(id, toConstraints(n.timetableConstraints));
      });
      extraRooms.forEach((id, i) => {
        const n = extra.rooms?.[`r${i}`];
        if (!n) return;
        roomConstraints.set(id, toConstraints(n.timetableConstraints));
        if (n.building?.id) roomBuilding.set(String(id), String(n.building.id));
        extraRoomRefs.push(n);
      });
      this.mergeRoomOptions(extraRoomRefs);
    }

    this.genLoadingStep.set('Читаємо поточний розклад спільних аудиторій, викладачів і груп…');
    const shared = await this.request(`query($parity: String, $roomIds: [ID!], $lecturerIds: [ID!], $groupIds: [ID!], $limit: Int!) {
      timetableEntries {
        byRoom: timetableEntryConnection(limit: $limit, semesterParity: $parity, roomIds: $roomIds) { ${EXTERNAL_ENTRY_SELECTION} }
        byLecturer: timetableEntryConnection(limit: $limit, semesterParity: $parity, lecturerIds: $lecturerIds) { ${EXTERNAL_ENTRY_SELECTION} }
        byGroup: timetableEntryConnection(limit: $limit, semesterParity: $parity, academicGroupIds: $groupIds) { ${EXTERNAL_ENTRY_SELECTION} }
      }
    }`, {
      limit: 5000, parity: this.selectedSemesterParity(),
      roomIds: [...roomIds],
      lecturerIds: [...lecturerIds],
      groupIds: [...groupIds]
    });

    const fixedById = new Map<string, SolverFixedEntry>();
    for (const slice of ['byRoom', 'byLecturer', 'byGroup']) {
      for (const n of shared.timetableEntries[slice].nodes as any[]) {
        // Our own classes are represented as requirements, not as fixed obstacles — otherwise a
        // rescheduled class would be asked to avoid the slot it is being moved out of.
        if (workloadIds.has(n.workload?.id)) continue;
        if (fixedById.has(n.id)) continue;
        const groups = new Set<string>();
        for (const g of n.workload?.academicGroups ?? []) groups.add(g.id);
        for (const cg of n.workload?.combinedGroups ?? []) {
          for (const g of cg.academicGroups ?? []) groups.add(g.id);
        }
        fixedById.set(n.id, {
          id: n.id,
          dayOfWeek: n.dayOfWeek,
          weekParity: n.weekParity,
          startTime: n.classStartTime?.startTime ?? '',
          durationHours: n.workload?.durationHours ?? 2,
          lecturerIds: (n.workload?.lecturers ?? []).map((l: any) => l.id),
          groupIds: [...groups],
          roomId: n.room?.id ?? null
        });
      }
    }

    const requirements: SolverRequirement[] = all.map((b) => ({
      key: b.key,
      workloadId: b.workloadId,
      entryId: b.entryId,
      courseName: b.courseLabel,
      hourType: this.hourTypeLabel(b.hourType),
      durationHours: b.durationHours,
      classStartTimeSetId: b.classStartTimeSetId ?? '',
      lecturerIds: b.lecturerIds,
      groupIds: b.academicGroupIds,
      roomIds: b.roomIds,
      isBiweekly: b.isBiweekly,
      current: b.entryId && b.dayOfWeek != null && b.classStartTimeId && b.roomId
        ? {
            dayOfWeek: b.dayOfWeek,
            classStartTimeId: b.classStartTimeId,
            roomId: b.roomId,
            weekParity: (b.weekParity as SolverPlacement['weekParity'])
          }
        : null,
      locked: !target.has(b.key)
    }));

    return {
      requirements,
      fixedEntries: [...fixedById.values()],
      classTimes: this.classStartTimes(),
      rooms: this.facultyRoomIds(),
      academicHourMinutes: this.academicHourDurationMinutes(),
      days: WORKING_DAYS,
      lecturerConstraints,
      groupConstraints,
      roomConstraints,
      roomBuilding,
      buildingTravel
    };
  }

  /**
   * What kind of clash this is, in the words the reader entered the data in. The travel kinds are
   * not overlaps at all — the two classes simply sit closer together than the walk between their
   * корпуси allows — so naming them «накладка» without qualification would send someone looking for
   * a double booking that is not there.
   */
  conflictKindLabel(kind: SolverConflict['kind']): string {
    switch (kind) {
      case 'LECTURER':        return 'викладач';
      case 'GROUP':           return 'група';
      case 'ROOM':            return 'аудиторія';
      case 'GROUP_TRAVEL':    return 'група не встигає перейти між корпусами';
      case 'LECTURER_TRAVEL': return 'викладач не встигає перейти між корпусами';
    }
  }

  /** Only what the panel decides; everything else comes from the solver's own DEFAULT_OPTIONS. */
  private solverOptions(): Partial<SolverOptions> {
    return { timeLimitMs: Number(this.genBudget()) || 30_000 };
  }

  private async runSolver(problem: SolverProblem) {
    const serialized: SerializedProblem = {
      ...problem,
      lecturerConstraints: [...problem.lecturerConstraints.entries()],
      groupConstraints: [...problem.groupConstraints.entries()],
      roomConstraints: [...problem.roomConstraints.entries()],
      roomBuilding: [...problem.roomBuilding.entries()],
      buildingTravel: [...problem.buildingTravel.entries()]
    };
    const options = this.solverOptions();

    if (typeof Worker === 'undefined') {
      // No worker available (a test host, say): run inline, imported on demand so the solver never
      // reaches the initial bundle. The page will not repaint until the budget is spent, which is
      // exactly why the worker exists.
      const { solveTimetable } = await import('./timetable-solver');
      const result = solveTimetable(problem, options, (p) => this.genProgress.set(p), () => this.cancelRequested);
      this.onSolved(result);
      return;
    }

    const worker = this.ensureWorker();
    const request: SolverRequest = { type: 'solve', problem: serialized, options };
    worker.postMessage(request);
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./timetable-solver.worker', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<SolverResponse>) => {
        if (data.type === 'progress') this.genProgress.set(data.progress);
        else if (data.type === 'done') this.onSolved(data.result);
        else {
          this.genError.set(data.message);
          this.genStage.set('error');
        }
      };
      this.worker.onerror = (e) => {
        this.genError.set(e.message || 'Помилка обчислення розкладу');
        this.genStage.set('error');
      };
    }
    return this.worker;
  }

  private onSolved(result: SolverResult) {
    if (!this.genBusy) return;
    this.genBusy = false;
    this.genResult.set(result);
    this.genPlan.set(this.buildPlan(result));
    this.genStage.set('preview');
  }

  /** Turns the solver's assignments into the exact set of writes they imply. */
  private buildPlan(result: SolverResult): Plan {
    const byKey = new Map(this.pendingBlocks.map((b) => [b.key, b]));
    const plan: Plan = { creates: [], updates: [], unchanged: 0, kept: 0, unresolved: [] };
    const touched = new Set<string>();

    for (const a of result.assignments) {
      const block = byKey.get(a.key);
      if (!block) continue;
      touched.add(a.key);
      if (!a.placement) {
        if (block.entryId) plan.unresolved.push(block);
        continue;
      }
      if (!block.entryId) {
        plan.creates.push({ block, placement: a.placement });
        continue;
      }
      const same = block.dayOfWeek === a.placement.dayOfWeek
        && block.classStartTimeId === a.placement.classStartTimeId
        && block.roomId === a.placement.roomId
        && block.weekParity === a.placement.weekParity;
      if (same) plan.unchanged++;
      else plan.updates.push({ block, placement: a.placement });
    }
    plan.kept = this.pendingBlocks.filter((b) => !touched.has(b.key)).length;
    return plan;
  }

  planChangeCount(): number {
    const p = this.genPlan();
    if (!p) return 0;
    return p.creates.length + p.updates.length;
  }

  /**
   * Stops the search.
   *
   * The solver is one synchronous loop, so the worker cannot read a `cancel` message until it has
   * finished — posting one would do nothing for up to two minutes. Terminating is the only thing
   * that actually stops it, which is why every progress message carries the best schedule so far:
   * «Зупинити» keeps that and drops the worker.
   */
  private stopSolver() {
    this.cancelRequested = true;
    this.genBusy = false;
    if (this.worker) {
      const request: SolverRequest = { type: 'cancel' };
      this.worker.postMessage(request);   // honoured by an inline (non-worker) run
      this.worker.terminate();
      this.worker = null;
    }
  }

  /** Stop early and plan whatever the last progress message carried. */
  stopAndShow() {
    const p = this.genProgress();
    this.stopSolver();
    if (!p?.assignments?.length) {
      this.genOpen.set(false);
      return;
    }
    const partial: SolverResult = {
      assignments: p.assignments,
      objective: p.objective,
      violations: p.violations,
      unplaced: [],
      conflicts: [],
      iterations: p.iteration,
      elapsedMs: p.elapsedMs,
      history: []
    };
    this.genResult.set(partial);
    this.genPlan.set(this.buildPlan(partial));
    this.genStage.set('preview');
  }

  closeGeneration() {
    if (this.genStage() === 'applying') return;
    this.stopSolver();
    this.genOpen.set(false);
  }

  /** Writes the plan: updates, then creates, batched into aliased documents. Nothing is deleted. */
  async applyPlan() {
    const plan = this.genPlan();
    if (!plan) return;
    const total = this.planChangeCount();
    if (total === 0) { this.genStage.set('done'); return; }

    this.applyTotal.set(total);
    this.applyDone.set(0);
    this.genStage.set('applying');
    this.genError.set('');

    try {
      // Moves before additions: an update frees the slot it leaves, so a class created into that
      // slot never briefly shares it with the class being moved out of it.
      await this.applyUpdates(plan.updates);
      await this.applyCreates(plan.creates);
      this.genStage.set('done');
      this.reloadItems();
    } catch (e) {
      this.genError.set(e instanceof Error ? e.message : String(e));
      this.genStage.set('error');
      this.reloadItems();
    }
  }

  private entryInput(block: Block, p: SolverPlacement) {
    return {
      dayOfWeek: p.dayOfWeek,
      weekParity: block.isBiweekly ? p.weekParity : 'WEEKLY',
      workloadId: block.workloadId,
      classStartTimeId: p.classStartTimeId,
      roomId: p.roomId
    };
  }

  private async applyCreates(items: { block: Block; placement: SolverPlacement }[]) {
    for (let from = 0; from < items.length; from += APPLY_BATCH) {
      const chunk = items.slice(from, from + APPLY_BATCH);
      const args = chunk.map((_, i) => `$i${i}: TimetableEntryInputPayload!`).join(', ');
      const fields = chunk.map((_, i) => `m${i}: createTimetableEntry(timetableEntry: $i${i}) { isSuccess errorStatus }`).join('\n');
      const vars: Record<string, any> = {};
      chunk.forEach((c, i) => { vars[`i${i}`] = this.entryInput(c.block, c.placement); });
      const d = await this.request(`mutation(${args}) { timetableEntries { ${fields} } }`, vars);
      this.checkBatch(d.timetableEntries, chunk.length, 'створення');
      this.applyDone.update((n) => n + chunk.length);
    }
  }

  private async applyUpdates(items: { block: Block; placement: SolverPlacement }[]) {
    for (let from = 0; from < items.length; from += APPLY_BATCH) {
      const chunk = items.slice(from, from + APPLY_BATCH);
      const args = chunk.map((_, i) => `$id${i}: ID!, $i${i}: TimetableEntryInputPayload!`).join(', ');
      const fields = chunk.map((_, i) => `m${i}: updateTimetableEntry(id: $id${i}, timetableEntry: $i${i}) { isSuccess errorStatus }`).join('\n');
      const vars: Record<string, any> = {};
      chunk.forEach((c, i) => {
        vars[`id${i}`] = c.block.entryId;
        vars[`i${i}`] = this.entryInput(c.block, c.placement);
      });
      const d = await this.request(`mutation(${args}) { timetableEntries { ${fields} } }`, vars);
      this.checkBatch(d.timetableEntries, chunk.length, 'оновлення');
      this.applyDone.update((n) => n + chunk.length);
    }
  }

  private checkBatch(payload: Record<string, { isSuccess: boolean; errorStatus?: string }>, size: number, what: string) {
    for (let i = 0; i < size; i++) {
      const res = payload[`m${i}`];
      if (res && !res.isSuccess) throw new Error(`Помилка ${what} запису розкладу: ${res.errorStatus || 'невідома помилка'}`);
    }
  }

  // ── Progress modal helpers ────────────────────────────────────────────────

  phaseLabel(): string {
    const p = this.genProgress();
    return p ? PHASE_LABELS[p.phase] ?? p.phase : 'Підготовка даних';
  }

  /** How full the progress bar is: whichever of the two budgets is further along. */
  progressPercent(): number {
    const p = this.genProgress();
    if (!p) return 0;
    const byTime = p.elapsedMs / Math.max(1, Number(this.genBudget()));
    return Math.min(100, Math.round(byTime * 100));
  }

  applyPercent(): number {
    const total = this.applyTotal();
    return total === 0 ? 0 : Math.round((this.applyDone() / total) * 100);
  }

  objectiveLabel(): string {
    const p = this.genProgress();
    if (!p) return '—';
    return p.objective.toLocaleString('uk-UA');
  }

  elapsedLabel(): string {
    const p = this.genProgress();
    if (!p) return '0.0 с';
    return `${(p.elapsedMs / 1000).toFixed(1)} с`;
  }

  dayLabel(day: number): string {
    return DAY_OF_WEEK_OPTIONS.find((o) => Number(o.value) === day)?.label ?? String(day);
  }
}

/** The workload fields both item queries need — kept in one place so they cannot drift apart. */
const WORKLOAD_SELECTION = `
  id
  durationHours
  classStartTimeSet { id name }
  lecturers { id firstName middleName lastName }
  academicGroups { id name }
  combinedGroups { id academicGroups { id name } }
  rooms { id number name }
  roomGroups { id name rooms { id number name } }
  timetableEntries {
    id dayOfWeek weekParity
    classStartTime { id ordinal startTime }
    room { id number }
  }`;

/** GraphQL constraint rows → the solver's shape. */
function toConstraints(rows: any[] | null | undefined): SolverConstraint[] {
  return (rows ?? []).map((c) => ({
    type: c.constraintType,
    dayOfWeek: c.dayOfWeek ?? null,
    value: c.constraintValue ?? ''
  }));
}
