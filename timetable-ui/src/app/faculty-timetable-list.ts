import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { Option, SearchSelect } from './search-select';
import { DAY_OF_WEEK_OPTIONS, HOUR_TYPE_OPTIONS, WEEK_PARITY_OPTIONS } from './entities';
import { compareUk } from './sort';

/** Semester parity — ODD/EVEN — matching curriculum_items.semester (1,3,5.. vs 2,4,6..). Options for
 *  the "current_semester_parity" global property are also enumerated here (see global-properties-page.ts). */
const SEMESTER_PARITY_OPTIONS: Option[] = [
  { id: 'ODD', label: 'Перший (непарний)' },
  { id: 'EVEN', label: 'Другий (парний)' }
];

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
  lecturers: LecturerRef[];
  academicGroups: GroupRef[];
  combinedGroups: { id: string; academicGroups: GroupRef[] }[];
  timetableEntries: RawEntry[];
}

interface RawWorkingItem {
  id: string;
  /** Non-empty when merged into a combined_working_curriculum_item — such items are handled via
   *  the combined item instead, so they're skipped here to avoid double-counting their workload. */
  combinedWorkingCurriculumItems: { id: string }[];
  /** The specific elective chosen for this working curriculum item (working_curriculum_items.course_id),
   *  set only when the item's curriculum item course is an ELECTIVE_GROUP — see courseNameFor(). */
  course?: { id: string; name: string } | null;
  curriculumItemHours: { hourType: string; hours: number; curriculumItem: { course: { id: string; name: string; courseType: string } } };
  workloads: RawWorkload[];
}

interface RawCombinedItem {
  id: string;
  // Server-filtered to this faculty and semester parity already (see loadCombinedItems), so
  // members no longer need their own department/semester for client-side filtering.
  workingCurriculumItems: {
    id: string;
    course?: { id: string; name: string } | null;
    curriculumItemHours: { hourType: string; hours: number; curriculumItem: { course: { id: string; name: string; courseType: string } } };
  }[];
  workloads: RawWorkload[];
}

/** One lecturer_workloads row, normalized regardless of whether it targets a working curriculum
 *  item directly or a combined_working_curriculum_item. */
interface WorkloadSource {
  workloadId: string;
  courseName: string;
  hourType: string;
  hours: number;
  durationHours: number;
  academicGroupNames: string[];
  lecturerNames: string[];
  entries: RawEntry[];
}

/** One schedulable class session derived from a workload's required weekly/biweekly class count. */
interface Block {
  key: string;
  workloadId: string;
  entryId: string | null;
  courseName: string;
  hourType: string;
  durationHours: number;
  academicGroupNames: string[];
  lecturerNames: string[];
  isBiweekly: boolean;
  dayOfWeek: number | null;
  classStartTimeId: string | null;
  roomId: string | null;
  weekParity: string; // 'WEEKLY' for non-biweekly blocks; 'NUMERATOR' | 'DENOMINATOR' for biweekly ones
}

interface BlockForm {
  dayOfWeek: string;
  classStartTimeId: string;
  roomId: string;
  weekParity: string;
}

/**
 * Faculty-wide schedule builder: auto-generates one "block" per class session required by every
 * lecturer_workload delivered by the faculty's departments (based on curriculum_item_hours.hours,
 * the semester_duration_weeks global property, and each workload's own duration_hours — see
 * classCounts()), and lets the user assign each block a day of week, class start time and room
 * (plus week parity for biweekly blocks), creating/updating/deleting the corresponding
 * timetable_entries row.
 */
@Component({
  selector: 'app-faculty-timetable-list',
  templateUrl: './faculty-timetable-list.html',
  imports: [FormsModule, SearchSelect]
})
export class FacultyTimetableList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);

  @Input() facultyId!: string;

  readonly HOUR_TYPE_OPTIONS = HOUR_TYPE_OPTIONS;
  readonly DAY_OF_WEEK_OPTIONS: Option[] = DAY_OF_WEEK_OPTIONS.map((o) => ({ id: o.value, label: o.label }));
  readonly BIWEEKLY_PARITY_OPTIONS: Option[] = WEEK_PARITY_OPTIONS
    .filter((o) => o.value !== 'WEEKLY')
    .map((o) => ({ id: o.value, label: o.label }));
  readonly SEMESTER_PARITY_OPTIONS = SEMESTER_PARITY_OPTIONS;

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
  classStartTimeOptions = signal<Option[]>([]);
  private classStartTimeOrdinals = new Map<string, number>();
  private classStartTimeStarts = new Map<string, string>();

  error = signal('');
  actionError = signal('');

  /** Per-block editable selection, keyed by Block.key; survives across data reloads by position. */
  formState: Record<string, BlockForm> = {};

  blocks = computed(() => this.buildBlocks());

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

  private loadItems() {
    this.loadWorkingCurriculumItems();
    this.loadCombinedItems();
  }

  onParityChange(value: string) {
    this.selectedSemesterParity.set(value);
    this.loadItems();
  }

  // Filtered server-side by facultyId (an EXISTS subquery through departments) and semesterParity
  // (an EXISTS subquery through curriculum_item_hours/curriculum_items) — see
  // CurriculumSchemaConfig#configureWorkingCurriculumItem — so there's no need to fetch every
  // working curriculum item in the system and narrow it down client-side.
  private loadWorkingCurriculumItems() {
    const q = `{ workingCurriculumItems { workingCurriculumItemConnection(limit: 5000, offset: 0, facultyId: "${this.facultyId}", semesterParity: "${this.selectedSemesterParity()}") { nodes {
      id
      combinedWorkingCurriculumItems { id }
      course { id name }
      curriculumItemHours { hourType hours curriculumItem { course { id name courseType } } }
      workloads {
        id
        durationHours
        lecturers { id firstName middleName lastName }
        academicGroups { id name }
        combinedGroups { id academicGroups { id name } }
        timetableEntries {
          id dayOfWeek weekParity
          classStartTime { id ordinal startTime }
          room { id number }
        }
      }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.wciItems.set(d.workingCurriculumItems.workingCurriculumItemConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  // Filtered server-side by facultyId and semesterParity (EXISTS subqueries through the member
  // working curriculum items — see CurriculumSchemaConfig#configureCombinedWorkingCurriculumItem),
  // so there's no need to fetch every combined item in the system and narrow it down client-side.
  private loadCombinedItems() {
    const q = `{ combinedWorkingCurriculumItems { combinedWorkingCurriculumItemConnection(limit: 2000, offset: 0, facultyId: "${this.facultyId}", semesterParity: "${this.selectedSemesterParity()}") { nodes {
      id
      workingCurriculumItems {
        id
        course { id name }
        curriculumItemHours { hourType hours curriculumItem { course { id name courseType } } }
      }
      workloads {
        id
        durationHours
        lecturers { id firstName middleName lastName }
        academicGroups { id name }
        combinedGroups { id academicGroups { id name } }
        timetableEntries {
          id dayOfWeek weekParity
          classStartTime { id ordinal startTime }
          room { id number }
        }
      }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.combinedItems.set(d.combinedWorkingCurriculumItems.combinedWorkingCurriculumItemConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadGlobalProperties() {
    const q = `{ globalProperties {
      parity: globalProperty(name: "current_semester_parity") { value }
      weeks: globalProperty(name: "semester_duration_weeks") { value }
      hourMinutes: globalProperty(name: "academic_hour_duration_minutes") { value }
    } }`;
    this.gql.request(q).subscribe({
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
    const q = `{ rooms { roomConnection(limit: 500, facultyId: "${this.facultyId}") { nodes { id number name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.rooms.roomConnection.nodes.map((r: any) => ({ id: r.id, label: r.name ? `${r.number} (${r.name})` : r.number }));
        this.roomOptions.set(opts);
      },
      error: () => {}
    });
  }

  private loadClassStartTimes() {
    const q = `{ classStartTimes { classStartTimeConnection(limit: 100) { nodes { id ordinal startTime } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const nodes = [...d.classStartTimes.classStartTimeConnection.nodes].sort((a: any, b: any) => a.ordinal - b.ordinal);
        this.classStartTimeOrdinals.clear();
        this.classStartTimeStarts.clear();
        const opts: Option[] = nodes.map((t: any) => {
          this.classStartTimeOrdinals.set(t.id, t.ordinal);
          this.classStartTimeStarts.set(t.id, t.startTime);
          return { id: t.id, label: `${t.ordinal}. ${t.startTime}` };
        });
        this.classStartTimeOptions.set(opts);
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

  /** Computed end time for a block's currently-selected class start time, or '' if none selected yet. */
  computedEndTime(block: Block): string {
    const f = this.formState[block.key];
    const start = f ? this.classStartTimeStarts.get(f.classStartTimeId) : undefined;
    return start ? this.endTimeFor(start, block.durationHours) : '';
  }

  private lecturerName(l: LecturerRef): string {
    return [l.lastName, l.firstName, l.middleName].filter(Boolean).join(' ');
  }

  /** Union of a workload's own academic groups and every combined group's member groups (the
   *  students actually attending), deduplicated by id. */
  private academicGroupsFor(w: RawWorkload): string[] {
    const byId = new Map<string, string>();
    for (const g of w.academicGroups ?? []) byId.set(g.id, g.name);
    for (const cg of w.combinedGroups ?? []) {
      for (const g of cg.academicGroups ?? []) byId.set(g.id, g.name);
    }
    return Array.from(byId.values()).sort(compareUk);
  }

  /**
   * The discipline course of a working curriculum item is normally its curriculum item's course.
   * But when that course is an ELECTIVE_GROUP (a group of electives students choose between), the
   * curriculum item's course is just the umbrella group — the actual discipline being taught is
   * the specific elective referenced by working_curriculum_items.course_id.
   */
  private courseNameFor(wci: { course?: { id: string; name: string } | null; curriculumItemHours: { curriculumItem: { course: { name: string; courseType: string } } } }): string {
    const ci = wci.curriculumItemHours.curriculumItem;
    if (ci.course.courseType === 'ELECTIVE_GROUP' && wci.course) return wci.course.name;
    return ci.course.name;
  }

  private toSource(w: RawWorkload, courseName: string, hourType: string, hours: number): WorkloadSource {
    return {
      workloadId: w.id,
      courseName,
      hourType,
      hours,
      durationHours: w.durationHours,
      academicGroupNames: this.academicGroupsFor(w),
      lecturerNames: (w.lecturers ?? []).map((l) => this.lecturerName(l)),
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
      const courseName = this.courseNameFor(wci);
      for (const w of wci.workloads ?? []) out.push(this.toSource(w, courseName, cih.hourType, cih.hours));
    }

    // Already scoped to this faculty and semester parity server-side (see loadCombinedItems), no
    // client-side filtering needed.
    for (const c of this.combinedItems()) {
      const first = c.workingCurriculumItems[0];
      if (!first) continue;
      const cih = first.curriculumItemHours;
      const courseName = this.courseNameFor(first);
      for (const w of c.workloads ?? []) out.push(this.toSource(w, courseName, cih.hourType, cih.hours));
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
      courseName: s.courseName,
      hourType: s.hourType,
      durationHours: s.durationHours,
      academicGroupNames: s.academicGroupNames,
      lecturerNames: s.lecturerNames,
      isBiweekly,
      dayOfWeek: entry?.dayOfWeek ?? null,
      classStartTimeId: entry?.classStartTime?.id ?? null,
      roomId: entry?.room?.id ?? null,
      weekParity: entry?.weekParity ?? (isBiweekly ? 'NUMERATOR' : 'WEEKLY')
    };
    this.formState[key] = {
      dayOfWeek: block.dayOfWeek != null ? String(block.dayOfWeek) : '',
      classStartTimeId: block.classStartTimeId ?? '',
      roomId: block.roomId ?? '',
      weekParity: block.weekParity
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
    return id ? this.classStartTimeOrdinals.get(id) ?? 0 : 0;
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

  lecturerNamesLabel(b: Block): string {
    return b.lecturerNames.join(', ') || '—';
  }

  canSave(block: Block): boolean {
    const f = this.formState[block.key];
    if (!f) return false;
    return !!f.dayOfWeek && !!f.classStartTimeId && !!f.roomId && (!block.isBiweekly || !!f.weekParity);
  }

  save(block: Block) {
    const f = this.formState[block.key];
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
    this.loadWorkingCurriculumItems();
    this.loadCombinedItems();
  }
}
