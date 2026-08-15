import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GqlVars, GraphqlService } from './graphql.service';
import { Option, SearchSelect } from './search-select';
import { MultiSelect } from './multi-select';
import { HOUR_TYPE_OPTIONS, ONLINE_CLASS_PLATFORM_OPTIONS, SEMESTER_PARITY_OPTIONS, toOptions } from './entities';
import { compareUk } from './sort';
import { CourseTagRef, courseLabel } from './course-label';

/**
 * Лекції → Практичні → Лабораторні → …, taken from the one list that already states that order
 * (`entities.ts`, itself in step with the `hour_type` enum in schema.sql) rather than restated here.
 * An unknown type sorts last.
 */
const hourTypeRank = (t: string): number => {
  const i = HOUR_TYPE_OPTIONS.findIndex((o) => o.value === t);
  return i === -1 ? HOUR_TYPE_OPTIONS.length : i;
};

interface GroupRef { id: string; name: string; }
interface RoomRef { id: string; number: string; name?: string | null; }
interface RoomGroupRef { id: string; name: string; }
interface AbstractRoomRef { id: string; name: string; capacity?: number | null; building?: { id: string } | null; }
interface OnlineClassRef { platform?: string | null; meetingUrl?: string | null; note?: string | null; }

/**
 * The three ways a class can be held, and they are alternatives: in one of a named set of rooms, in
 * an abstract room (a place several classes share at the same hour), or nowhere at all — online.
 * Choosing one is what clears the other two, both on screen and on save.
 */
type PlaceMode = 'ROOMS' | 'ABSTRACT' | 'ONLINE';

interface LecturerRef {
  id: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
}

interface RawWorkload {
  id: string;
  durationHours: number;
  lecturers: LecturerRef[];
  academicGroups: GroupRef[];
  combinedGroups: { id: string; name: string; academicGroups: GroupRef[] }[];
  rooms: RoomRef[];
  roomGroups: RoomGroupRef[];
  /** A list in GraphQL, at most one element in the database — `lecturer_workload_abstract_rooms`
   *  is keyed on the workload alone, so a second id would be a duplicate key, not a second place. */
  abstractRooms: AbstractRoomRef[];
  /** Present exactly when the class is online; its columns only say how to attend. */
  onlineClass?: OnlineClassRef | null;
}

interface RawCurriculumItemHours {
  hourType: string;
  hours: number;
  curriculumItem: {
    semester: number;
    degreeProgram?: { id: string; name: string } | null;
    course: { id: string; name: string; courseType: string; semester?: number | null; tags?: CourseTagRef[] | null };
  };
}

interface RawWorkingItem {
  id: string;
  combinedWorkingCurriculumItems: { id: string }[];
  department?: { id: string; name: string } | null;
  course?: { id: string; name: string; semester?: number | null; tags?: CourseTagRef[] | null } | null;
  curriculumItemHours: RawCurriculumItemHours;
  workloads: RawWorkload[];
}

interface RawCombinedItem {
  id: string;
  workingCurriculumItems: {
    id: string;
    department?: { id: string; name: string } | null;
    course?: { id: string; name: string; semester?: number | null; tags?: CourseTagRef[] | null } | null;
    curriculumItemHours: RawCurriculumItemHours;
  }[];
  workloads: RawWorkload[];
}

/**
 * One card: a class, and where it may be held. A class here is one `lecturer_workloads` row — the
 * unit the eligibility is actually stored on (`lecturer_workload_rooms` /
 * `lecturer_workload_room_groups`), and the unit every session of it shares.
 */
interface ClassCard {
  workloadId: string;
  courseId: string;
  /** Bare `courses.name` — what the list collates on, so a tag cannot drive the ordering. */
  courseName: string;
  /** `courseName` with the course's tags in parentheses — what the card shows. */
  courseLabel: string;
  hourType: string;
  hours: number;
  durationHours: number;
  semester: number;
  /** Every degreeProgram this class serves — one for a plain item, possibly several for a combined one. */
  degreeProgramIds: string[];
  degreeProgramNames: string;
  departmentName: string;
  groupNames: string;
  lecturerNames: string;
  combined: boolean;
  /** Assigned as stored — what the card's colour and the counter read. */
  roomIds: string[];
  roomGroupIds: string[];
  /** '' when no abstract room is named. Never more than one — see `RawWorkload.abstractRooms`. */
  abstractRoomId: string;
  /** Whether an online row exists, which *is* the fact that the class is online. */
  online: boolean;
  onlinePlatform: string;
  onlineMeetingUrl: string;
  onlineNote: string;
  /** Which of the three the stored state amounts to — what the form opens on. */
  mode: PlaceMode;
}

/**
 * The editable draft behind one card. Every mode's fields are held at once rather than one union of
 * them: switching mode and switching back must not lose what was typed before the trip, and only
 * `mode` decides which of them a save actually sends.
 */
interface CardForm {
  mode: PlaceMode;
  roomIds: string[];
  roomGroupIds: string[];
  abstractRoomId: string;
  onlinePlatform: string;
  onlineMeetingUrl: string;
  onlineNote: string;
  /** What the card looked like when this draft was seeded — see `form()`. */
  stamp: string;
}

/**
 * «Призначення аудиторій» — where each class of a faculty is held.
 *
 * A class is held in exactly one of three ways, and the card offers them as a choice rather than as
 * three independent fields, because that is what they are:
 *
 *  - **в аудиторії** — the eligible rooms are the **union** of the rooms named directly and the
 *    rooms of the room groups named (`schema.sql:487-499`); naming nothing means no restriction,
 *    and the timetable solver may then put the class in any room of the faculty;
 *  - **абстрактна аудиторія** — one place several classes legitimately occupy at the same hour
 *    (спортивні зали, «дистанційно з кафедри»). A list in GraphQL and at most one row in the
 *    database, so the card offers a single choice and sends a 0- or 1-element array;
 *  - **онлайн** — no place at all. The `lecturer_workload_online_classes` row's *presence* is the
 *    fact; платформа, посилання and нотатка only say how to attend, and all three may be empty.
 *
 * Picking one clears the other two on save, which is why a save is up to two requests rather than
 * one — see `save`.
 *
 * A class assigned none of the three is worth seeing at a glance rather than discovering when the
 * generator produces a schedule holding a lecture in a 12-seat lab, so those cards are tinted red.
 *
 * ## Why this is a faculty page and not part of «Навантаження викладачів»
 *
 * It used to be two multi-selects in the department's workload modal, beside the lecturers, the
 * groups and the duration. That put a faculty-wide resource inside a per-department form: a кафедра
 * editing its own teaching load was also, in the same dialog, laying claim to rooms shared with
 * every other department. Rooms belong to the faculty (`rooms.faculty_id`), the timetable that has
 * to fit in them is built at faculty level, and so is this.
 *
 * Nothing about the storage of the room half changed — this page writes the same two join tables
 * through the same `updateLecturerWorkload` mutation. The department modal simply stopped sending
 * `roomIds` / `roomGroupIds`, and a many-to-many field absent from a mutation input leaves its rows
 * untouched, so editing a workload there cannot clear what was assigned here.
 *
 * There is one other writer: a discipline's own page (`course-page.ts`) edits the same two lists on
 * its «Навантаження викладачів» tab, so a кафедра correcting one discipline does not have to come
 * here for the room half of the same row. Both send the lists in full, so the later save wins —
 * neither merges. This page remains the one that answers "what has nobody assigned yet?" across a
 * whole faculty, which is the question a board of red cards exists for.
 */
@Component({
  selector: 'app-room-assignment-list',
  standalone: true,
  imports: [FormsModule, RouterLink, SearchSelect, MultiSelect],
  templateUrl: './room-assignment-list.html'
})
export class RoomAssignmentList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);

  @Input() facultyId!: string;

  readonly SEMESTER_PARITY_OPTIONS = SEMESTER_PARITY_OPTIONS;
  /** The платформа dropdown. Adapted to app-search-select's `{ id, label }` shape once, here. */
  readonly PLATFORM_OPTIONS = toOptions(ONLINE_CLASS_PLATFORM_OPTIONS);

  /** Which half-year to show. Server-side (`semesterParity` on both working-item connections). */
  selectedSemesterParity = signal('ODD');
  /** Server-side too: `departmentId` on the working items, `departmentIds` on the combined ones. */
  selectedDepartmentId = signal('');
  /**
   * Client-side, because neither working-item connection carries a `degreeProgramId` relation filter —
   * the degreeProgram is two levels down, on the curriculum item. The rows are already narrowed to one
   * faculty and one half-year by then, so the list being filtered here is small.
   */
  selectedDegreeProgramId = signal('');

  departmentOptions = signal<Option[]>([]);
  /** DegreePrograms this faculty owns — the base of the filter list. */
  private facultyDegreeProgramOptions = signal<Option[]>([]);
  /** What this faculty may pick from — see `loadRoomOptions`. */
  private baseRoomOptions = signal<Option[]>([]);
  private baseRoomGroupOptions = signal<Option[]>([]);
  private baseAbstractRoomOptions = signal<Option[]>([]);

  private wciItems = signal<RawWorkingItem[]>([]);
  private combinedItems = signal<RawCombinedItem[]>([]);

  /** True until the first load lands. Starts true: the very first request is the parity lookup,
   *  and until it returns the page knows nothing — «0 занять» would be a claim, not a count. */
  loading = signal(true);
  error = signal('');
  /** Workload ids currently being saved, so each card's own button says «Збереження…» — and two
   *  cards saved in quick succession do not clear each other's state. */
  saving = signal<ReadonlySet<string>>(new Set());

  private initialized = false;
  /** Guards against a slow response from a superseded filter overwriting a newer one. */
  private loadToken = 0;

  /** Per-card drafts, keyed by workload id. Kept across reloads — see `form()`. */
  private formState: Record<string, CardForm> = {};

  ngOnInit() {
    this.initialized = true;
    if (!this.facultyId) { this.loading.set(false); return; }
    this.loadFilterOptions();
    this.loadRoomOptions();
    // The classes are loaded *by* loadGlobalParity, not beside it: the parity is a server-side
    // filter, so firing a load before the stored default arrives would fetch the wrong half-year
    // and then immediately fetch it again.
    this.loadGlobalParity();
  }

  ngOnChanges() {
    if (this.initialized && this.facultyId) {
      this.loadFilterOptions();
      this.loadRoomOptions();
      this.loadAll();
    }
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  onParityChange(v: string) {
    this.selectedSemesterParity.set(v);
    this.loadAll();
  }

  onDepartmentChange(v: string) {
    this.selectedDepartmentId.set(v);
    this.loadAll();
  }

  onDegreeProgramChange(v: string) {
    this.selectedDegreeProgramId.set(v);   // client-side: no reload
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  /**
   * The half-year the institution is currently in, as the default for the parity filter — then the
   * first load, on either path. A missing or unreadable property leaves the `'ODD'` default in
   * place rather than leaving the page empty.
   */
  private loadGlobalParity() {
    const q = `query($name: ID!) { globalProperties { globalProperty(name: $name) { value } } }`;
    this.gql.request(q, { name: 'current_semester_parity' }).subscribe({
      next: (d: any) => {
        const v = d.globalProperties?.globalProperty?.value;
        if (v === 'ODD' || v === 'EVEN') this.selectedSemesterParity.set(v);
        this.loadAll();
      },
      error: () => this.loadAll()
    });
  }

  private loadFilterOptions() {
    const q = `query($facultyId: ID, $limit: Int!, $offset: Int!) {
      departments { departmentConnection(limit: $limit, offset: $offset, facultyId: $facultyId) { nodes { id name } } }
      degreePrograms { degreeProgramConnection(limit: $limit, offset: $offset, facultyId: $facultyId) { nodes { id code name } } }
    }`;
    this.gql.request(q, { facultyId: this.facultyId, limit: 200, offset: 0 }).subscribe({
      next: (d: any) => {
        this.departmentOptions.set((d.departments.departmentConnection.nodes ?? [])
          .map((x: any) => ({ id: x.id, label: x.name }))
          .sort((a: Option, b: Option) => compareUk(a.label, b.label)));
        this.facultyDegreeProgramOptions.set((d.degreePrograms.degreeProgramConnection.nodes ?? [])
          .map((x: any) => ({ id: x.id, label: x.code ? `${x.code} ${x.name}` : x.name })));
        this.rememberDegreePrograms();
      },
      error: () => {}
    });
  }

  /**
   * Rooms, room groups and abstract rooms this faculty may assign.
   *
   * Rooms: this faculty's, plus those belonging to no faculty at all (shared sports halls and the
   * like). Groups: university-wide, this faculty's, and those of any of its departments. Abstract
   * rooms: the same rule as rooms — this faculty's plus the university-wide ones, which for an
   * abstract room is the *usual* case rather than the exception. All three are fetched unfiltered
   * and narrowed here rather than through the `facultyId` filter, because an equality filter would
   * drop exactly the unscoped rows that are most often wanted.
   */
  private loadRoomOptions() {
    const q = `query($roomLimit: Int!, $offset: Int!, $roomGroupLimit: Int!, $abstractRoomLimit: Int!) {
      rooms { roomConnection(limit: $roomLimit, offset: $offset) { nodes { id number name faculty { id } } } }
      roomGroups { roomGroupConnection(limit: $roomGroupLimit, offset: $offset) { nodes {
        id name faculty { id } department { id faculty { id } }
      } } }
      abstractRooms { abstractRoomConnection(limit: $abstractRoomLimit, offset: $offset) { nodes {
        id name capacity faculty { id } building { id name }
      } } }
    }`;
    this.gql.request(q, { roomLimit: 1000, offset: 0, roomGroupLimit: 500, abstractRoomLimit: 500 }).subscribe({
      next: (d: any) => {
        this.baseRoomOptions.set((d.rooms.roomConnection.nodes ?? [])
          .filter((r: any) => !r.faculty || r.faculty.id === this.facultyId)
          .map((r: any) => ({ id: r.id, label: r.name ? `${r.number} — ${r.name}` : r.number })));

        this.baseRoomGroupOptions.set((d.roomGroups.roomGroupConnection.nodes ?? [])
          .filter((g: any) => (!g.faculty && !g.department)
            || g.faculty?.id === this.facultyId
            || g.department?.faculty?.id === this.facultyId)
          .map((g: any) => ({ id: g.id, label: g.name })));

        this.baseAbstractRoomOptions.set((d.abstractRooms.abstractRoomConnection.nodes ?? [])
          .filter((r: any) => !r.faculty || r.faculty.id === this.facultyId)
          .map((r: any) => ({ id: r.id, label: this.abstractRoomLabel(r) })));
      },
      error: () => {}
    });
  }

  /** «Спортивні зали (Головний корпус)» — the корпус is what tells two same-named places apart. */
  private abstractRoomLabel(r: { name: string; building?: { name?: string | null } | null }): string {
    return r.building?.name ? `${r.name} (${r.building.name})` : r.name;
  }

  /**
   * The base options plus anything already assigned but not offered — a room of another faculty, a
   * group scoped elsewhere. Without the second half a multi-select would render such a value as an
   * unchecked blank and the first save would silently drop it.
   *
   * A computed rather than an accumulating merge: recomputing from the base each time is what keeps
   * a foreign room, seen under one filter, from being offered to every card for the rest of the
   * session.
   */
  roomOptions = computed<Option[]>(() => {
    const byId = new Map(this.baseRoomOptions().map((o) => [o.id, o]));
    for (const w of this.allWorkloads()) {
      for (const r of w.rooms ?? []) {
        if (!byId.has(r.id)) byId.set(r.id, { id: r.id, label: r.name ? `${r.number} — ${r.name}` : r.number });
      }
    }
    return [...byId.values()].sort((a, b) => compareUk(a.label, b.label));
  });

  roomGroupOptions = computed<Option[]>(() => {
    const byId = new Map(this.baseRoomGroupOptions().map((o) => [o.id, o]));
    for (const w of this.allWorkloads()) {
      for (const g of w.roomGroups ?? []) {
        if (!byId.has(g.id)) byId.set(g.id, { id: g.id, label: g.name });
      }
    }
    return [...byId.values()].sort((a, b) => compareUk(a.label, b.label));
  });

  /** The same merge again: a place assigned by another faculty must still be nameable here. */
  abstractRoomOptions = computed<Option[]>(() => {
    const byId = new Map(this.baseAbstractRoomOptions().map((o) => [o.id, o]));
    for (const w of this.allWorkloads()) {
      for (const r of w.abstractRooms ?? []) {
        if (!byId.has(r.id)) byId.set(r.id, { id: r.id, label: r.name });
      }
    }
    return [...byId.values()].sort((a, b) => compareUk(a.label, b.label));
  });

  /**
   * The filter's options: the faculty's own degreePrograms, plus every degreeProgram actually appearing in
   * the loaded classes.
   *
   * The union matters because the two sets genuinely differ. A department of this faculty teaches
   * service disciplines to other faculties' degreePrograms — those classes are listed here (they are
   * this faculty's teaching load) but their degreeProgram is not this faculty's, so a list built from
   * `degreeProgramConnection` alone could never isolate them. The converse gap is real but belongs
   * elsewhere: a degreeProgram of this faculty whose discipline is delivered by another faculty's
   * department is that faculty's class to place, and is assigned on *its* page.
   */
  degreeProgramOptions = computed<Option[]>(() => {
    const byId = new Map<string, Option>(this.facultyDegreeProgramOptions().map((o) => [o.id, o]));
    const add = (sp?: { id: string; name: string } | null) => {
      if (sp && !byId.has(sp.id)) byId.set(sp.id, { id: sp.id, label: sp.name });
    };
    for (const i of this.wciItems()) add(i.curriculumItemHours.curriculumItem.degreeProgram);
    for (const c of this.combinedItems()) {
      for (const m of c.workingCurriculumItems ?? []) add(m.curriculumItemHours.curriculumItem.degreeProgram);
    }
    // Narrowing by кафедра can remove the rows a row-derived degreeProgram came from. Dropping it from
    // the list as well would leave the id still filtering while the control fell back to its
    // placeholder — three filters that look wide open above an empty list. Keep it visible.
    const selected = this.selectedDegreeProgramId();
    if (selected && !byId.has(selected)) {
      const known = this.knownDegreePrograms().get(selected);
      if (known) byId.set(selected, { id: selected, label: known });
    }
    return [...byId.values()].sort((a, b) => compareUk(a.label, b.label));
  });

  /** Every degreeProgram this page has seen, so a selection filtered out of the rows can still be named. */
  private knownDegreePrograms = signal<ReadonlyMap<string, string>>(new Map());

  private rememberDegreePrograms() {
    const next = new Map(this.knownDegreePrograms());
    const add = (sp?: { id: string; name: string } | null) => { if (sp) next.set(sp.id, sp.name); };
    for (const o of this.facultyDegreeProgramOptions()) next.set(o.id, o.label);
    for (const i of this.wciItems()) add(i.curriculumItemHours.curriculumItem.degreeProgram);
    for (const c of this.combinedItems()) {
      for (const m of c.workingCurriculumItems ?? []) add(m.curriculumItemHours.curriculumItem.degreeProgram);
    }
    const current = this.knownDegreePrograms();
    let changed = next.size !== current.size;
    if (!changed) {
      for (const [id, label] of next) {
        if (current.get(id) !== label) { changed = true; break; }
      }
    }
    if (changed) this.knownDegreePrograms.set(next);
  }

  private allWorkloads(): RawWorkload[] {
    return [
      ...this.wciItems().flatMap((i) => i.workloads ?? []),
      ...this.combinedItems().flatMap((c) => c.workloads ?? [])
    ];
  }

  /** Both halves must land before the list is honest — «занять немає» while one is still in
   *  flight would be a claim about data nobody has seen yet. */
  private workingLoaded = false;
  private combinedLoaded = false;

  private settleLoading() {
    if (this.workingLoaded && this.combinedLoaded) this.loading.set(false);
  }

  private loadAll() {
    if (!this.facultyId) return;
    const token = ++this.loadToken;
    this.workingLoaded = false;
    this.combinedLoaded = false;
    // Cleared here rather than in a loader's success path: the two run concurrently, so clearing on
    // success meant whichever landed second decided whether the other's failure was ever seen.
    this.error.set('');
    this.loading.set(true);
    this.loadWorkingItems(token);
    this.loadCombinedItems(token);
  }

  /** The workload's own fields plus its current eligibility — the whole point of this page. */
  private readonly WORKLOAD_SELECTION = `
    id
    durationHours
    lecturers { id firstName middleName lastName }
    academicGroups { id name }
    combinedGroups { id name academicGroups { id name } }
    rooms { id number name }
    roomGroups { id name }
    abstractRooms { id name capacity building { id } }
    onlineClass { platform meetingUrl note }
  `;

  /** The кафедра sub-filter, when one is chosen — absent from the document when it is not. */
  private departmentFilter(v: GqlVars): string {
    const filter = v.optionalArg('departmentId', 'ID', this.selectedDepartmentId());
    return filter ? `, ${filter}` : '';
  }

  private loadWorkingItems(token: number) {
    const v = new GqlVars();
    const scope = `${v.arg('limit', 'Int!', 5000)}, ${v.arg('offset', 'Int!', 0)}, `
      + `${v.arg('facultyId', 'ID', this.facultyId)}, `
      + `${v.arg('semesterParity', 'String', this.selectedSemesterParity())}${this.departmentFilter(v)}`;
    const q = `${v.declaration()}{ workingCurriculumItems { workingCurriculumItemConnection(${scope}) { nodes {
      id
      combinedWorkingCurriculumItems { id }
      department { id name }
      course { id name semester tags { tag } }
      curriculumItemHours {
        hourType hours
        curriculumItem { semester degreeProgram { id name } course { id name courseType semester tags { tag } } }
      }
      workloads { ${this.WORKLOAD_SELECTION} }
    } } } }`;
    this.gql.request(q, v.values).subscribe({
      next: (d: any) => {
        if (token !== this.loadToken) return;
        this.wciItems.set(d.workingCurriculumItems.workingCurriculumItemConnection.nodes ?? []);
        this.rememberDegreePrograms();
        this.workingLoaded = true;
        this.settleLoading();
      },
      error: (e) => {
        if (token !== this.loadToken) return;
        this.wciItems.set([]);
        this.error.set(e.message);
        this.workingLoaded = true;
        this.settleLoading();
      }
    });
  }

  private loadCombinedItems(token: number) {
    const dept = this.selectedDepartmentId();
    const v = new GqlVars();
    const deptFilter = dept ? `, ${v.arg('departmentIds', '[ID!]', [dept])}` : '';
    const scope = `${v.arg('limit', 'Int!', 2000)}, ${v.arg('offset', 'Int!', 0)}, `
      + `${v.arg('facultyId', 'ID', this.facultyId)}, `
      + `${v.arg('semesterParity', 'String', this.selectedSemesterParity())}${deptFilter}`;
    const q = `${v.declaration()}{ combinedWorkingCurriculumItems { combinedWorkingCurriculumItemConnection(${scope}) { nodes {
      id
      workingCurriculumItems {
        id
        department { id name }
        course { id name semester tags { tag } }
        curriculumItemHours {
          hourType hours
          curriculumItem { semester degreeProgram { id name } course { id name courseType semester tags { tag } } }
        }
      }
      workloads { ${this.WORKLOAD_SELECTION} }
    } } } }`;
    this.gql.request(q, v.values).subscribe({
      next: (d: any) => {
        if (token !== this.loadToken) return;
        this.combinedItems.set(d.combinedWorkingCurriculumItems.combinedWorkingCurriculumItemConnection.nodes ?? []);
        this.rememberDegreePrograms();
        this.combinedLoaded = true;
        this.settleLoading();
      },
      // Not swallowed: a failure here would otherwise leave the previous filter's combined cards on
      // screen beside the new filter's plain ones, with nothing to say the two disagree.
      error: (e) => {
        if (token !== this.loadToken) return;
        this.combinedItems.set([]);
        this.error.set(e.message);
        this.combinedLoaded = true;
        this.settleLoading();
      }
    });
  }

  // ── Cards ─────────────────────────────────────────────────────────────────

  /**
   * The discipline actually taught: normally the curriculum item's course, but when that is an
   * `ELECTIVE_GROUP` the class delivers the specific elective named on the working item.
   */
  private courseOf(item: { course?: { id: string; name: string; semester?: number | null; tags?: CourseTagRef[] | null } | null;
                           curriculumItemHours: RawCurriculumItemHours }): { id: string; name: string; label: string } {
    const ci = item.curriculumItemHours.curriculumItem;
    const c = ci.course.courseType === 'ELECTIVE_GROUP' && item.course ? item.course : ci.course;
    return { id: c.id, name: c.name, label: courseLabel(c.name, c.tags, c.semester) };
  }

  private lecturerName(l: LecturerRef): string {
    return [l.lastName, l.firstName, l.middleName].filter(Boolean).join(' ');
  }

  /** A workload's students: its own groups plus the members of every combined group on it. */
  private groupNamesOf(w: RawWorkload): string {
    const byId = new Map<string, GroupRef>();
    for (const g of w.academicGroups ?? []) byId.set(g.id, g);
    for (const cg of w.combinedGroups ?? []) {
      for (const g of cg.academicGroups ?? []) byId.set(g.id, g);
    }
    return [...byId.values()].map((g) => g.name).sort(compareUk).join(', ');
  }

  /** Every class of the faculty in the chosen half-year, after the client-side degreeProgram filter. */
  cards = computed<ClassCard[]>(() => {
    const out: ClassCard[] = [];

    for (const item of this.wciItems()) {
      // A merged item is delivered through its combined item's workloads instead; counting both
      // would show the same class twice.
      if ((item.combinedWorkingCurriculumItems ?? []).length > 0) continue;
      const ci = item.curriculumItemHours.curriculumItem;
      const course = this.courseOf(item);
      for (const w of item.workloads ?? []) {
        out.push(this.toCard(w, course, item.curriculumItemHours, {
          degreeProgramIds: ci.degreeProgram ? [ci.degreeProgram.id] : [],
          degreeProgramNames: ci.degreeProgram?.name ?? '—',
          departmentName: item.department?.name ?? '—',
          combined: false
        }));
      }
    }

    for (const c of this.combinedItems()) {
      const first = c.workingCurriculumItems?.[0];
      if (!first) continue;
      const course = this.courseOf(first);
      // A combined item is one class taught to the members of several degreePrograms at once, so it
      // matches the degreeProgram filter if *any* of them does.
      const degreePrograms = new Map<string, string>();
      const departments = new Set<string>();
      for (const m of c.workingCurriculumItems ?? []) {
        const sp = m.curriculumItemHours.curriculumItem.degreeProgram;
        if (sp) degreePrograms.set(sp.id, sp.name);
        if (m.department?.name) departments.add(m.department.name);
      }
      for (const w of c.workloads ?? []) {
        out.push(this.toCard(w, course, first.curriculumItemHours, {
          degreeProgramIds: [...degreePrograms.keys()],
          degreeProgramNames: [...degreePrograms.values()].sort(compareUk).join(', ') || '—',
          departmentName: [...departments].sort(compareUk).join(', ') || '—',
          combined: true
        }));
      }
    }

    const degreeProgramId = this.selectedDegreeProgramId();
    const filtered = degreeProgramId ? out.filter((c) => c.degreeProgramIds.includes(degreeProgramId)) : out;

    return filtered.sort((a, b) =>
      a.semester - b.semester
      || compareUk(a.courseName, b.courseName)
      || hourTypeRank(a.hourType) - hourTypeRank(b.hourType)
      || compareUk(a.groupNames, b.groupNames));
  });

  private toCard(w: RawWorkload, course: { id: string; name: string; label: string }, cih: RawCurriculumItemHours,
                 rest: { degreeProgramIds: string[]; degreeProgramNames: string; departmentName: string; combined: boolean }): ClassCard {
    return {
      workloadId: w.id,
      courseId: course.id,
      courseName: course.name,
      courseLabel: course.label,
      hourType: cih.hourType,
      hours: cih.hours ?? 0,
      durationHours: w.durationHours,
      semester: cih.curriculumItem.semester ?? 0,
      groupNames: this.groupNamesOf(w),
      lecturerNames: (w.lecturers ?? []).map((l) => this.lecturerName(l)).sort(compareUk).join(', '),
      roomIds: (w.rooms ?? []).map((r) => r.id),
      roomGroupIds: (w.roomGroups ?? []).map((g) => g.id),
      // At most one, whatever the list says — the join table's primary key is the workload.
      abstractRoomId: (w.abstractRooms ?? [])[0]?.id ?? '',
      online: !!w.onlineClass,
      onlinePlatform: w.onlineClass?.platform ?? '',
      onlineMeetingUrl: w.onlineClass?.meetingUrl ?? '',
      onlineNote: w.onlineClass?.note ?? '',
      // The three are alternatives, so the stored state is read as one of them, most specific
      // first: an online row means online whatever else was left behind beside it.
      mode: w.onlineClass ? 'ONLINE' : (w.abstractRooms ?? []).length > 0 ? 'ABSTRACT' : 'ROOMS',
      ...rest
    };
  }

  /** How many classes still have nowhere in particular to be — the number the red cards count. */
  unassignedCount = computed(() => this.cards().filter((c) => this.isUnassigned(c)).length);

  /**
   * None of the three ways of holding a class has been chosen: no room, no room group, no abstract
   * room, and not online. The solver may then use any room of the faculty — which schedules
   * perfectly well and is almost never what anybody decided.
   */
  isUnassigned(card: ClassCard): boolean {
    return card.roomIds.length === 0 && card.roomGroupIds.length === 0
      && card.abstractRoomId === '' && !card.online;
  }

  hourTypeLabel(v: string): string {
    return HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  // ── Editing ───────────────────────────────────────────────────────────────

  /**
   * The draft behind a card, created on first access and kept across reloads so that saving one
   * card does not discard the selections in progress on every other. The stamp is what the card
   * was last loaded with — now all three placements, not just the two room lists: when it changes
   * the draft is reseeded, so a card whose stored placement really did change picks the new value
   * up, including a switch of mode made on another screen.
   */
  form(card: ClassCard): CardForm {
    const stamp = [
      [...card.roomIds].sort().join(','),
      [...card.roomGroupIds].sort().join(','),
      card.abstractRoomId,
      card.online ? '1' : '0',
      card.onlinePlatform, card.onlineMeetingUrl, card.onlineNote
    ].join('|');
    const seed = (): CardForm => ({
      mode: card.mode,
      roomIds: [...card.roomIds],
      roomGroupIds: [...card.roomGroupIds],
      abstractRoomId: card.abstractRoomId,
      onlinePlatform: card.onlinePlatform,
      onlineMeetingUrl: card.onlineMeetingUrl,
      onlineNote: card.onlineNote,
      stamp
    });
    const existing = this.formState[card.workloadId];
    if (!existing) return (this.formState[card.workloadId] = seed());
    if (existing.stamp !== stamp) Object.assign(existing, seed());
    return existing;
  }

  /** The three-way choice itself. Nothing is cleared here — only a save clears, and only on the
   *  server; a trip through «Онлайн» and back must not lose the rooms that were already picked. */
  setMode(card: ClassCard, mode: PlaceMode) {
    this.form(card).mode = mode;
  }

  /**
   * Whether a card's draft differs from what is stored — what enables its «Зберегти».
   *
   * A different mode is a difference in itself; within one mode only that mode's own fields count,
   * because they are the only ones a save would send. Without that, a card that had been carried to
   * «Онлайн» and back would read as edited forever over a нотатка nobody is going to store.
   */
  isDirty(card: ClassCard): boolean {
    const f = this.form(card);
    if (f.mode !== card.mode) return true;
    const same = (a: string[], b: string[]) =>
      a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
    switch (f.mode) {
      case 'ROOMS':
        return !(same(f.roomIds, card.roomIds) && same(f.roomGroupIds, card.roomGroupIds));
      case 'ABSTRACT':
        return f.abstractRoomId !== card.abstractRoomId;
      default:
        return f.onlinePlatform !== card.onlinePlatform
          || f.onlineMeetingUrl.trim() !== card.onlineMeetingUrl
          || f.onlineNote.trim() !== card.onlineNote;
    }
  }

  /**
   * Whether «Зберегти» is offered. «Абстрактна аудиторія» with nothing chosen is the one draft that
   * is dirty and still not saveable: it would write the same emptiness as «В аудиторії» with nothing
   * chosen, so the mode a reader would then see on the card is not the mode they left it in. Saying
   * "no restriction" is what «В аудиторії» is for.
   */
  canSave(card: ClassCard): boolean {
    const f = this.form(card);
    if (f.mode === 'ABSTRACT' && !f.abstractRoomId) return false;
    return this.isDirty(card) && !this.saving().has(card.workloadId);
  }

  /** Restores a card's draft to what is stored, mode included. */
  revert(card: ClassCard) {
    const f = this.form(card);
    f.mode = card.mode;
    f.roomIds = [...card.roomIds];
    f.roomGroupIds = [...card.roomGroupIds];
    f.abstractRoomId = card.abstractRoomId;
    f.onlinePlatform = card.onlinePlatform;
    f.onlineMeetingUrl = card.onlineMeetingUrl;
    f.onlineNote = card.onlineNote;
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  /**
   * Writes one card's placement.
   *
   * The three placements are alternatives, so a save is as much about clearing the two not chosen
   * as about writing the one that was. All three id lists are always sent in full, including empty:
   * an empty array is the meaningful value here ("no restriction", or "not there any more"), and a
   * many-to-many field omitted from the input would leave the stored rows untouched instead.
   *
   * That makes a save up to **two** requests, and their order is deliberate: the workload first,
   * then the online row. Nothing makes the pair atomic — there is no transaction spanning two
   * mutations — so what matters is which half-done state is the less wrong one. Clearing the rooms
   * and failing to write the online row leaves a class with nowhere to be, which the board tints red
   * and somebody will fix; writing the online row and failing to clear the rooms leaves a class that
   * claims to be in two places at once, which nothing on this page would show. The card stays in
   * «Збереження…» until both have settled, and only then is the board reloaded.
   */
  save(card: ClassCard) {
    // The duration has to be echoed back (see the input below) and the column is
    // `CHECK (duration_hours BETWEEN 1 AND 4)`. If it somehow did not arrive, refusing is the only
    // honest option: substituting a number would write either a value the database rejects or, worse,
    // one it accepts and nobody chose.
    if (!Number.isFinite(card.durationHours)) {
      this.error.set('Не вдалося визначити тривалість заняття — оновіть сторінку.');
      return;
    }
    if (!this.canSave(card)) return;
    const f = this.form(card);
    const mode = f.mode;
    this.saving.update((ids) => new Set(ids).add(card.workloadId));
    // Deliberately not clearing `error` here: a load may be in flight and this would erase its
    // failure. A successful save reloads, and `loadAll` clears it there.
    const done = () => this.saving.update((ids) => {
      const next = new Set(ids);
      next.delete(card.workloadId);
      return next;
    });

    const q = `mutation($id: ID!, $input: LecturerWorkloadInputPayload!) {
      lecturerWorkloads { updateLecturerWorkload(id: $id, lecturerWorkload: $input) { isSuccess errorStatus } }
    }`;
    this.gql.request(q, {
      id: card.workloadId,
      input: {
        // `durationHours` is `Int!` on LecturerWorkloadInputPayload — non-null in the database and
        // therefore required by the generated input type, so the operation is rejected outright
        // without it. It is echoed back exactly as loaded; this page does not edit it.
        durationHours: card.durationHours,
        roomIds: mode === 'ROOMS' ? f.roomIds : [],
        roomGroupIds: mode === 'ROOMS' ? f.roomGroupIds : [],
        // A list of at most one: `lecturer_workload_abstract_rooms` is keyed on the workload alone.
        abstractRoomIds: mode === 'ABSTRACT' && f.abstractRoomId ? [f.abstractRoomId] : []
      }
    }).subscribe({
      next: (d: any) => {
        const res = d.lecturerWorkloads.updateLecturerWorkload;
        if (!res.isSuccess) { done(); this.error.set(res.errorStatus || 'Помилка операції'); return; }
        this.saveOnline(card, f, mode, done);
      },
      error: (e) => { done(); this.error.set(e.message); }
    });
  }

  /**
   * The second half of a save: the online row, whose *presence* is what marks the class online, so
   * the three cases are create, update and delete rather than three values of one field.
   *
   * The namespace is `lecturerWorkloadOnlineClasss` with three s's: the schema builder pluralises a
   * type name by appending `s` (`DynamicGraphQLSchemaBuilder#pluralize`), and this type's name
   * already ends in one. The `id` argument of update and delete is the **workload's** id — this
   * entity is keyed on `lecturer_workload_id`, projected as `id`.
   */
  private saveOnline(card: ClassCard, f: CardForm, mode: PlaceMode, done: () => void) {
    // A failure here has already had the workload half applied, so the board on screen is stale
    // whatever we say about it. `loadAll` clears `error` synchronously, hence the order: reload
    // first, then state what went wrong, and let a failing load overwrite the message with its own.
    const fail = (m: string) => { done(); this.loadAll(); this.error.set(m); };
    const finish = () => { done(); this.loadAll(); };

    // The mode as it was when the first request went out, not as the draft reads now: a reload
    // triggered by another card in the meantime may have reseeded this draft.
    const wantsOnline = mode === 'ONLINE';
    if (!wantsOnline && !card.online) { finish(); return; }

    if (!wantsOnline) {
      const q = `mutation($id: ID!) {
        lecturerWorkloadOnlineClasss { deleteLecturerWorkloadOnlineClass(id: $id) { isSuccess errorStatus } }
      }`;
      this.runOnline(q, { id: card.workloadId }, 'deleteLecturerWorkloadOnlineClass', finish, fail);
      return;
    }

    // Empty is stored as NULL rather than as an empty string: «платформу не вказано» is an absence,
    // and for `platform` an empty string is not even a value the enum has.
    const text = (v: string): string | null => (v.trim() === '' ? null : v.trim());
    const payload = {
      lecturerWorkloadId: card.workloadId,
      platform: text(f.onlinePlatform),
      meetingUrl: text(f.onlineMeetingUrl),
      note: text(f.onlineNote)
    };

    if (card.online) {
      const q = `mutation($id: ID!, $input: LecturerWorkloadOnlineClassInputPayload!) {
        lecturerWorkloadOnlineClasss { updateLecturerWorkloadOnlineClass(id: $id, lecturerWorkloadOnlineClass: $input) { isSuccess errorStatus } }
      }`;
      this.runOnline(q, { id: card.workloadId, input: payload }, 'updateLecturerWorkloadOnlineClass', finish, fail);
    } else {
      const q = `mutation($input: LecturerWorkloadOnlineClassInputPayload!) {
        lecturerWorkloadOnlineClasss { createLecturerWorkloadOnlineClass(lecturerWorkloadOnlineClass: $input) { isSuccess errorStatus } }
      }`;
      this.runOnline(q, { input: payload }, 'createLecturerWorkloadOnlineClass', finish, fail);
    }
  }

  /** One shape for the three online mutations: same namespace, same `{ isSuccess errorStatus }`. */
  private runOnline(q: string, vars: Record<string, unknown>, field: string,
                    ok: () => void, fail: (message: string) => void) {
    this.gql.request(q, vars).subscribe({
      next: (d: any) => {
        const res = d.lecturerWorkloadOnlineClasss?.[field];
        if (!res?.isSuccess) { fail(res?.errorStatus || 'Помилка операції'); return; }
        ok();
      },
      error: (e) => fail(e.message)
    });
  }
}
