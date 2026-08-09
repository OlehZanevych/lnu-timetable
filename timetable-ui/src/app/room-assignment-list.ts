import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GqlVars, GraphqlService } from './graphql.service';
import { Option, SearchSelect } from './search-select';
import { MultiSelect } from './multi-select';
import { HOUR_TYPE_OPTIONS, SEMESTER_PARITY_OPTIONS } from './entities';
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
}

interface RawCurriculumItemHours {
  hourType: string;
  hours: number;
  curriculumItem: {
    semester: number;
    specialty?: { id: string; name: string } | null;
    course: { id: string; name: string; courseType: string; tags?: CourseTagRef[] | null };
  };
}

interface RawWorkingItem {
  id: string;
  combinedWorkingCurriculumItems: { id: string }[];
  department?: { id: string; name: string } | null;
  course?: { id: string; name: string; tags?: CourseTagRef[] | null } | null;
  curriculumItemHours: RawCurriculumItemHours;
  workloads: RawWorkload[];
}

interface RawCombinedItem {
  id: string;
  workingCurriculumItems: {
    id: string;
    department?: { id: string; name: string } | null;
    course?: { id: string; name: string; tags?: CourseTagRef[] | null } | null;
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
  /** Every specialty this class serves — one for a plain item, possibly several for a combined one. */
  specialtyIds: string[];
  specialtyNames: string;
  departmentName: string;
  groupNames: string;
  lecturerNames: string;
  combined: boolean;
  /** Assigned as stored — what the card's colour and the counter read. */
  roomIds: string[];
  roomGroupIds: string[];
}

/** The editable draft behind one card. */
interface CardForm {
  roomIds: string[];
  roomGroupIds: string[];
  /** What the card looked like when this draft was seeded — see `form()`. */
  stamp: string;
}

/**
 * «Призначення аудиторій» — where each class of a faculty may be held.
 *
 * The eligible rooms of a class are the **union** of the rooms named directly and the rooms of the
 * room groups named (`schema.sql:487-499`); naming nothing means no restriction, and the timetable
 * solver may then put the class in any room of the faculty. That is exactly why a class with
 * nothing assigned is worth seeing at a glance rather than discovering when the generator produces
 * a schedule holding a lecture in a 12-seat lab — so those cards are tinted red.
 *
 * ## Why this is a faculty page and not part of «Навантаження викладачів»
 *
 * It used to be two multi-selects in the department's workload modal, beside the lecturers, the
 * groups and the duration. That put a faculty-wide resource inside a per-department form: a кафедра
 * editing its own teaching load was also, in the same dialog, laying claim to rooms shared with
 * every other department. Rooms belong to the faculty (`rooms.faculty_id`), the timetable that has
 * to fit in them is built at faculty level, and so is this.
 *
 * Nothing about the storage changed — this page writes the same two join tables through the same
 * `updateLecturerWorkload` mutation. The department modal simply stopped sending `roomIds` /
 * `roomGroupIds`, and a many-to-many field absent from a mutation input leaves its rows untouched,
 * so editing a workload there cannot clear what was assigned here.
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

  /** Which half-year to show. Server-side (`semesterParity` on both working-item connections). */
  selectedSemesterParity = signal('ODD');
  /** Server-side too: `departmentId` on the working items, `departmentIds` on the combined ones. */
  selectedDepartmentId = signal('');
  /**
   * Client-side, because neither working-item connection carries a `specialtyId` relation filter —
   * the specialty is two levels down, on the curriculum item. The rows are already narrowed to one
   * faculty and one half-year by then, so the list being filtered here is small.
   */
  selectedSpecialtyId = signal('');

  departmentOptions = signal<Option[]>([]);
  /** Specialties this faculty owns — the base of the filter list. */
  private facultySpecialtyOptions = signal<Option[]>([]);
  /** What this faculty may pick from — see `loadRoomOptions`. */
  private baseRoomOptions = signal<Option[]>([]);
  private baseRoomGroupOptions = signal<Option[]>([]);

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

  onSpecialtyChange(v: string) {
    this.selectedSpecialtyId.set(v);   // client-side: no reload
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
      specialties { specialtyConnection(limit: $limit, offset: $offset, facultyId: $facultyId) { nodes { id code name } } }
    }`;
    this.gql.request(q, { facultyId: this.facultyId, limit: 200, offset: 0 }).subscribe({
      next: (d: any) => {
        this.departmentOptions.set((d.departments.departmentConnection.nodes ?? [])
          .map((x: any) => ({ id: x.id, label: x.name }))
          .sort((a: Option, b: Option) => compareUk(a.label, b.label)));
        this.facultySpecialtyOptions.set((d.specialties.specialtyConnection.nodes ?? [])
          .map((x: any) => ({ id: x.id, label: x.code ? `${x.code} ${x.name}` : x.name })));
        this.rememberSpecialties();
      },
      error: () => {}
    });
  }

  /**
   * Rooms and room groups this faculty may assign.
   *
   * Rooms: this faculty's, plus those belonging to no faculty at all (shared sports halls and the
   * like). Groups: university-wide, this faculty's, and those of any of its departments. Both are
   * fetched unfiltered and narrowed here rather than through the `facultyId` filter, because an
   * equality filter would drop exactly the unscoped rows that are most often wanted.
   */
  private loadRoomOptions() {
    const q = `query($roomLimit: Int!, $offset: Int!, $roomGroupLimit: Int!) {
      rooms { roomConnection(limit: $roomLimit, offset: $offset) { nodes { id number name faculty { id } } } }
      roomGroups { roomGroupConnection(limit: $roomGroupLimit, offset: $offset) { nodes {
        id name faculty { id } department { id faculty { id } }
      } } }
    }`;
    this.gql.request(q, { roomLimit: 1000, offset: 0, roomGroupLimit: 500 }).subscribe({
      next: (d: any) => {
        this.baseRoomOptions.set((d.rooms.roomConnection.nodes ?? [])
          .filter((r: any) => !r.faculty || r.faculty.id === this.facultyId)
          .map((r: any) => ({ id: r.id, label: r.name ? `${r.number} — ${r.name}` : r.number })));

        this.baseRoomGroupOptions.set((d.roomGroups.roomGroupConnection.nodes ?? [])
          .filter((g: any) => (!g.faculty && !g.department)
            || g.faculty?.id === this.facultyId
            || g.department?.faculty?.id === this.facultyId)
          .map((g: any) => ({ id: g.id, label: g.name })));
      },
      error: () => {}
    });
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

  /**
   * The filter's options: the faculty's own specialties, plus every specialty actually appearing in
   * the loaded classes.
   *
   * The union matters because the two sets genuinely differ. A department of this faculty teaches
   * service disciplines to other faculties' specialties — those classes are listed here (they are
   * this faculty's teaching load) but their specialty is not this faculty's, so a list built from
   * `specialtyConnection` alone could never isolate them. The converse gap is real but belongs
   * elsewhere: a specialty of this faculty whose discipline is delivered by another faculty's
   * department is that faculty's class to place, and is assigned on *its* page.
   */
  specialtyOptions = computed<Option[]>(() => {
    const byId = new Map<string, Option>(this.facultySpecialtyOptions().map((o) => [o.id, o]));
    const add = (sp?: { id: string; name: string } | null) => {
      if (sp && !byId.has(sp.id)) byId.set(sp.id, { id: sp.id, label: sp.name });
    };
    for (const i of this.wciItems()) add(i.curriculumItemHours.curriculumItem.specialty);
    for (const c of this.combinedItems()) {
      for (const m of c.workingCurriculumItems ?? []) add(m.curriculumItemHours.curriculumItem.specialty);
    }
    // Narrowing by кафедра can remove the rows a row-derived specialty came from. Dropping it from
    // the list as well would leave the id still filtering while the control fell back to its
    // placeholder — three filters that look wide open above an empty list. Keep it visible.
    const selected = this.selectedSpecialtyId();
    if (selected && !byId.has(selected)) {
      const known = this.knownSpecialties().get(selected);
      if (known) byId.set(selected, { id: selected, label: known });
    }
    return [...byId.values()].sort((a, b) => compareUk(a.label, b.label));
  });

  /** Every specialty this page has seen, so a selection filtered out of the rows can still be named. */
  private knownSpecialties = signal<ReadonlyMap<string, string>>(new Map());

  private rememberSpecialties() {
    const next = new Map(this.knownSpecialties());
    const add = (sp?: { id: string; name: string } | null) => { if (sp) next.set(sp.id, sp.name); };
    for (const o of this.facultySpecialtyOptions()) next.set(o.id, o.label);
    for (const i of this.wciItems()) add(i.curriculumItemHours.curriculumItem.specialty);
    for (const c of this.combinedItems()) {
      for (const m of c.workingCurriculumItems ?? []) add(m.curriculumItemHours.curriculumItem.specialty);
    }
    const current = this.knownSpecialties();
    let changed = next.size !== current.size;
    if (!changed) {
      for (const [id, label] of next) {
        if (current.get(id) !== label) { changed = true; break; }
      }
    }
    if (changed) this.knownSpecialties.set(next);
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
      course { id name tags { tag } }
      curriculumItemHours {
        hourType hours
        curriculumItem { semester specialty { id name } course { id name courseType tags { tag } } }
      }
      workloads { ${this.WORKLOAD_SELECTION} }
    } } } }`;
    this.gql.request(q, v.values).subscribe({
      next: (d: any) => {
        if (token !== this.loadToken) return;
        this.wciItems.set(d.workingCurriculumItems.workingCurriculumItemConnection.nodes ?? []);
        this.rememberSpecialties();
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
        course { id name tags { tag } }
        curriculumItemHours {
          hourType hours
          curriculumItem { semester specialty { id name } course { id name courseType tags { tag } } }
        }
      }
      workloads { ${this.WORKLOAD_SELECTION} }
    } } } }`;
    this.gql.request(q, v.values).subscribe({
      next: (d: any) => {
        if (token !== this.loadToken) return;
        this.combinedItems.set(d.combinedWorkingCurriculumItems.combinedWorkingCurriculumItemConnection.nodes ?? []);
        this.rememberSpecialties();
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
  private courseOf(item: { course?: { id: string; name: string; tags?: CourseTagRef[] | null } | null;
                           curriculumItemHours: RawCurriculumItemHours }): { id: string; name: string; label: string } {
    const ci = item.curriculumItemHours.curriculumItem;
    const c = ci.course.courseType === 'ELECTIVE_GROUP' && item.course ? item.course : ci.course;
    return { id: c.id, name: c.name, label: courseLabel(c.name, c.tags) };
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

  /** Every class of the faculty in the chosen half-year, after the client-side specialty filter. */
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
          specialtyIds: ci.specialty ? [ci.specialty.id] : [],
          specialtyNames: ci.specialty?.name ?? '—',
          departmentName: item.department?.name ?? '—',
          combined: false
        }));
      }
    }

    for (const c of this.combinedItems()) {
      const first = c.workingCurriculumItems?.[0];
      if (!first) continue;
      const course = this.courseOf(first);
      // A combined item is one class taught to the members of several specialties at once, so it
      // matches the specialty filter if *any* of them does.
      const specialties = new Map<string, string>();
      const departments = new Set<string>();
      for (const m of c.workingCurriculumItems ?? []) {
        const sp = m.curriculumItemHours.curriculumItem.specialty;
        if (sp) specialties.set(sp.id, sp.name);
        if (m.department?.name) departments.add(m.department.name);
      }
      for (const w of c.workloads ?? []) {
        out.push(this.toCard(w, course, first.curriculumItemHours, {
          specialtyIds: [...specialties.keys()],
          specialtyNames: [...specialties.values()].sort(compareUk).join(', ') || '—',
          departmentName: [...departments].sort(compareUk).join(', ') || '—',
          combined: true
        }));
      }
    }

    const specialtyId = this.selectedSpecialtyId();
    const filtered = specialtyId ? out.filter((c) => c.specialtyIds.includes(specialtyId)) : out;

    return filtered.sort((a, b) =>
      a.semester - b.semester
      || compareUk(a.courseName, b.courseName)
      || hourTypeRank(a.hourType) - hourTypeRank(b.hourType)
      || compareUk(a.groupNames, b.groupNames));
  });

  private toCard(w: RawWorkload, course: { id: string; name: string; label: string }, cih: RawCurriculumItemHours,
                 rest: { specialtyIds: string[]; specialtyNames: string; departmentName: string; combined: boolean }): ClassCard {
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
      ...rest
    };
  }

  /** How many classes still have nowhere in particular to be — the number the red cards count. */
  unassignedCount = computed(() => this.cards().filter((c) => this.isUnassigned(c)).length);

  /** Neither a room nor a room group named: the solver may use any room of the faculty. */
  isUnassigned(card: ClassCard): boolean {
    return card.roomIds.length === 0 && card.roomGroupIds.length === 0;
  }

  hourTypeLabel(v: string): string {
    return HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  // ── Editing ───────────────────────────────────────────────────────────────

  /**
   * The draft behind a card, created on first access and kept across reloads so that saving one
   * card does not discard the selections in progress on every other. The stamp is what the card
   * was last loaded with: when it changes the draft is reseeded, so a card whose stored assignment
   * really did change picks the new value up.
   */
  form(card: ClassCard): CardForm {
    const stamp = [...card.roomIds].sort().join(',') + '|' + [...card.roomGroupIds].sort().join(',');
    const seed = (): CardForm => ({
      roomIds: [...card.roomIds],
      roomGroupIds: [...card.roomGroupIds],
      stamp
    });
    const existing = this.formState[card.workloadId];
    if (!existing) return (this.formState[card.workloadId] = seed());
    if (existing.stamp !== stamp) Object.assign(existing, seed());
    return existing;
  }

  /** Whether a card's draft differs from what is stored — what enables its «Зберегти». */
  isDirty(card: ClassCard): boolean {
    const f = this.form(card);
    const same = (a: string[], b: string[]) =>
      a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
    return !(same(f.roomIds, card.roomIds) && same(f.roomGroupIds, card.roomGroupIds));
  }

  /** Restores a card's draft to what is stored. */
  revert(card: ClassCard) {
    const f = this.form(card);
    f.roomIds = [...card.roomIds];
    f.roomGroupIds = [...card.roomGroupIds];
  }

  /**
   * Writes one card's assignment. Both lists are always sent in full: an empty array is a
   * meaningful value here ("no restriction"), and a many-to-many field omitted from the input
   * would leave the stored rows untouched instead of clearing them.
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
    const f = this.form(card);
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
        roomIds: f.roomIds,
        roomGroupIds: f.roomGroupIds
      }
    }).subscribe({
      next: (d: any) => {
        done();
        const res = d.lecturerWorkloads.updateLecturerWorkload;
        if (!res.isSuccess) { this.error.set(res.errorStatus || 'Помилка операції'); return; }
        this.loadAll();
      },
      error: (e) => { done(); this.error.set(e.message); }
    });
  }
}
