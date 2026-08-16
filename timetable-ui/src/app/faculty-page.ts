import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { AccessNeed, anywhereNeed, rowNeed } from './access-need';
import { AccessGate } from './access-gate';
import { ResourceAccessPanel } from './resource-access';
import { SearchSelect, Option } from './search-select';
import { SEMESTER_PARITY_OPTIONS } from './entities';
import { GlobalPropertiesService } from './global-properties.service';
import { compareUk } from './sort';
import { sectionNav } from './section-route';
import { DepartmentList } from './department-list';
import { DegreeProgramList } from './degree-program-list';
import { AcademicGroupList } from './academic-group-list';
import { FacultyTimetableList } from './faculty-timetable-list';
import { RoomAssignmentList } from './room-assignment-list';
import { TimetableConstraintList } from './timetable-constraint-list';
import { RoomPage, RoomGroupPage, CoursePage, CombinedGroupPage } from './entity-pages';
import { TimetableView } from './timetable-view';

/** One academic group of the faculty, with what the timetable tab's three filters need. */
interface FacultyGroup {
  id: string;
  name: string;
  courseYear: number;
  degreeProgramId: string;
  degreeProgramName: string;
}

export type FacultySection =
  | 'info'
  | 'departments' | 'degreePrograms' | 'rooms' | 'roomGroups'
  | 'courses' | 'roomAssignment' | 'timetable' | 'facultyTimetable' | 'academicGroups' | 'combinedGroups'
  | 'groupConstraints' | 'roomConstraints'
  | 'access';

/**
 * One tab. `writes` names the kind of thing a tab exists to maintain, and is what decides whether the
 * tab is offered: the nav hides it and the body refuses with «Немає доступу» unless this account
 * could reach something of that kind — something to add, or something already theirs to edit.
 *
 * It is deliberately not «EDIT on this факультет». The rows behind these tabs belong further down:
 * «Формування розкладу» writes TimetableEntry, which hangs off a навантаження and therefore off a
 * кафедра, and a завідувач holding that кафедра has always been allowed to place their own classes.
 * Gating the tab on the факультет would have taken a screen away from the person whose work it is,
 * which is the opposite of the point. The type-level answer over-shows instead — a завідувач sees the
 * tab on a faculty where nothing is theirs — and everything inside it is still gated on the row.
 *
 * Declared here rather than as a list of keys next to the tab strip because the strip and the switch
 * in the template are two places that must agree about which tab is which; a table they both read
 * cannot drift apart when the next scheduling tab is added.
 */
interface SectionDef { key: FacultySection; label: string; group: string; writes?: string; }

interface Faculty {
  id: string;
  name: string;
  abbreviation: string;
  phone: string;
  email: string;
  website: string;
  building?: { id: string; name: string; address?: string };
}

const SECTIONS: SectionDef[] = [
  { key: 'info',                   label: 'Інформація',           group: 'Факультет' },
  { key: 'departments',            label: 'Кафедри',              group: 'Структура' },
  { key: 'degreePrograms',            label: 'Освітні програми',        group: 'Структура' },
  { key: 'rooms',                  label: 'Аудиторії',            group: 'Структура' },
  { key: 'roomGroups',             label: 'Групи аудиторій',      group: 'Структура' },
  { key: 'academicGroups',         label: 'Академічні групи',     group: 'Люди та групи' },
  { key: 'combinedGroups',         label: "Об'єднані групи",      group: 'Люди та групи' },
  { key: 'courses',                label: 'Дисципліни',           group: 'Навчальні плани' },
  // "Розклад" runs in the order the work does: say where each class may be held and when its
  // groups and rooms are unavailable, then generate a timetable that obeys all three, then read it.
  // The first four of them are that work, and belong to whoever does it; «Розклад факультету» is the
  // result everybody reads, so it is the one tab of the five that is not marked as writing data.
  { key: 'roomAssignment',         label: 'Призначення аудиторій', group: 'Розклад', writes: 'LECTURER_WORKLOAD' },
  { key: 'groupConstraints',       label: 'Обмеження груп',       group: 'Розклад', writes: 'ACADEMIC_GROUP' },
  { key: 'roomConstraints',        label: 'Обмеження аудиторій',  group: 'Розклад', writes: 'ROOM' },
  { key: 'timetable',              label: 'Формування розкладу',  group: 'Розклад', writes: 'TIMETABLE_ENTRY' },
  { key: 'facultyTimetable',       label: 'Розклад факультету',   group: 'Розклад' },
  // Only rendered for someone holding «Керування доступом» here — see canManageAccess below and
  // the panel's own guard. The деканат delegates their own faculty from this tab; there is no
  // reason for it to be an administrator's errand.
  { key: 'access',                 label: 'Доступ',               group: 'Факультет' },
];

/**
 * Which slugs `/faculty/:id/:section` recognises — see `section-route.ts`. Every tab, including the
 * ones a given reader is not offered: a slug missing from here is not a refused address but an
 * unknown one, and `sectionNav` answers those by silently opening «Інформація». Somebody handed
 * `/faculty/3/timetable` should land on the розклад tab and be told what access it needs, not be
 * quietly moved somewhere else and left to wonder whether the link was wrong.
 */
const SECTION_KEYS: FacultySection[] = SECTIONS.map((s) => s.key);

@Component({
  selector: 'app-faculty-page',
  templateUrl: './faculty-page.html',
  imports: [
    RouterLink, FormsModule, SearchSelect,
    DepartmentList, DegreeProgramList, AcademicGroupList, RoomAssignmentList, FacultyTimetableList,
    TimetableConstraintList, TimetableView, RoomPage, RoomGroupPage, CoursePage, CombinedGroupPage,
    ResourceAccessPanel, AccessGate
  ]
})
export class FacultyPage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private gql = inject(GraphqlService);
  auth = inject(AuthService);
  private settings = inject(GlobalPropertiesService);

  readonly facultyId: string = this.route.snapshot.paramMap.get('id')!;

  /**
   * This user's level on this Faculty. Two signals rather than one boolean, because the two buttons
   * they gate are no longer the same right: «Редагувати» needs EDIT, «Видалити» needs FULL.
   */
  facultyLevel = signal<AccessLevel | null>(null);
  canModifyFaculty = computed(() => allows(maxLevel(this.auth.globalLevel(), this.facultyLevel()), 'EDIT'));
  canDeleteFaculty = computed(() => allows(maxLevel(this.auth.globalLevel(), this.facultyLevel()), 'FULL'));

  /** Whether the «Доступ» tab is offered — MANAGE on this faculty, or university-wide. */
  canManageAccess = computed(() => allows(maxLevel(this.auth.globalLevel(), this.facultyLevel()), 'MANAGE'));

  /**
   * The requirement behind one tab, in the shape `AccessGate` resolves — what each writing tab's body
   * is wrapped in, so that a pasted link to one of them is answered on the screen instead of by a tab
   * strip that simply does not mention it.
   *
   * Cached per key, because the gate re-asks whenever the bound need changes identity and a freshly
   * built object on every change-detection pass would never stop re-asking.
   */
  private readonly sectionNeeds = new Map<string, AccessNeed>();

  sectionNeed(key: FacultySection): AccessNeed {
    let need = this.sectionNeeds.get(key);
    if (!need) {
      const writes = SECTIONS.find((s) => s.key === key)?.writes;
      need = writes ? anywhereNeed(writes) : rowNeed('FACULTY', this.facultyId);
      this.sectionNeeds.set(key, need);
    }
    return need;
  }

  faculty = signal<Faculty | null>(null);
  error = signal('');

  /**
   * The open tab, and the last segment of the URL — see `section-route.ts`. Read from the route
   * rather than written here, so «Кафедри», «Освітні програми» and «Аудиторії» are addresses of their
   * own that can be bookmarked and reloaded, and Back moves between them.
   */
  private nav = sectionNav<FacultySection>(
    () => ['/faculty', this.facultyId], () => SECTION_KEYS, () => 'info');
  readonly activeSection = this.nav.active;

  /**
   * Every academic group of the faculty — the columns of the published розклад, before the
   * «Розклад факультету» tab's own three filters narrow them.
   */
  private allGroups = signal<FacultyGroup[]>([]);

  readonly SEMESTER_PARITY_OPTIONS = SEMESTER_PARITY_OPTIONS;

  /**
   * The half-year the timetable shows. Owned here rather than by `TimetableView` — passed as its
   * `externalSemesterParity`, which hides its own picker — so that all four controls sit in one bar
   * in reading order, семестр first: the other three only mean anything once you know which
   * half-year you are looking at.
   *
   * Seeded from `current_semester_parity`, defaulting to ODD. Never empty; see
   * `SEMESTER_PARITY_OPTIONS` for why there is no "whole year".
   */
  ttSemesterParity = signal('ODD');

  /**
   * The «Дисципліни» tab's name search. Narrows the rows the generic table has already loaded —
   * see `BaseEntity.search` — and combines with the кафедра filter above it, which is server-side.
   */
  courseSearch = signal('');

  /** The tab's filters. `''` means "all" in each. They combine: курс ∧ освітня програма ∧ група. */
  ttCourseYear = signal('');
  ttDegreeProgramId = signal('');
  ttGroupId = signal('');

  /**
   * The groups the timetable is drawn for. `timetableEntryConnection` has no facultyId filter, so
   * the faculty timetable has always been "the timetable of these group ids" — which makes
   * narrowing the ids the whole of the filtering. An empty result loads nothing and shows an empty
   * grid, which is the honest answer to a combination no group matches.
   */
  groupIds = computed(() => {
    const year = this.ttCourseYear();
    const prog = this.ttDegreeProgramId();
    const group = this.ttGroupId();
    return this.allGroups()
      .filter((g) => (!year || String(g.courseYear) === year)
                  && (!prog || g.degreeProgramId === prog)
                  && (!group || g.id === group))
      .map((g) => g.id);
  });

  /** Курси that actually have groups, ascending — «1 курс», «2 курс», … */
  ttCourseYearOptions = computed<Option[]>(() =>
    [...new Set(this.allGroups().map((g) => g.courseYear))]
      .sort((a, b) => a - b)
      .map((y) => ({ id: String(y), label: `${y} курс` })));

  /** Only degreePrograms that have groups — an option that could only ever produce an empty grid is
   *  not a filter, it is a trap. */
  ttDegreeProgramOptions = computed<Option[]>(() => {
    const byId = new Map<string, string>();
    for (const g of this.allGroups()) if (g.degreeProgramId) byId.set(g.degreeProgramId, g.degreeProgramName);
    return [...byId].map(([id, label]) => ({ id, label }))
      .sort((a, b) => compareUk(a.label, b.label));
  });

  /** Cascaded: the groups left once курс and освітня програма have been applied. */
  ttGroupOptions = computed<Option[]>(() => {
    const year = this.ttCourseYear();
    const prog = this.ttDegreeProgramId();
    return this.allGroups()
      .filter((g) => (!year || String(g.courseYear) === year) && (!prog || g.degreeProgramId === prog))
      .map((g) => ({ id: g.id, label: g.name }))
      .sort((a, b) => compareUk(a.label, b.label));
  });

  /**
   * Changing курс or освітня програма drops a chosen група that no longer belongs to them. Leaving it
   * selected would filter the grid down to nothing while the група picker showed a name the курс
   * picker contradicts — two controls disagreeing about what is on screen.
   */
  /** True when the three filters between them name no group at all — as opposed to naming groups
   *  that happen to have no classes. The two look identical in an empty grid and are not the same. */
  ttNoGroupsMatch = computed(() => this.allGroups().length > 0 && this.groupIds().length === 0);

  /**
   * What the sheet is of, in words: the faculty, then whichever of курс / освітня програма / група has
   * been chosen. An exported subset that still called itself the faculty's timetable would be a
   * signed document making a claim about classes it does not contain.
   */
  ttReportSubject = computed(() => {
    const faculty = this.faculty()?.name ?? '';
    const parts = [faculty];
    const year = this.ttCourseYear();
    if (year) parts.push(`${year} курс`);
    const prog = this.ttDegreeProgramOptions().find((o) => o.id === this.ttDegreeProgramId());
    if (prog) parts.push(prog.label);
    const group = this.ttGroupOptions().find((o) => o.id === this.ttGroupId());
    if (group) parts.push(`група ${group.label}`);
    return parts.filter(Boolean).join(' · ');
  });

  /**
   * Narrowed to exactly one група, the sheet is that group's timetable, not the faculty's: one
   * column reads as a list rather than a grid, and the official гриф/підписи apparatus belongs on
   * the faculty-wide sheet a декан actually signs.
   */
  ttReportKind = computed<'FACULTY' | 'ACADEMIC_GROUP'>(() =>
    this.ttGroupId() ? 'ACADEMIC_GROUP' : 'FACULTY');

  onTtScopeChange() {
    const group = this.ttGroupId();
    if (group && !this.ttGroupOptions().some((o) => o.id === group)) this.ttGroupId.set('');
  }

  progs = signal<Option[]>([]);
  selectedProgId = '';
  depts = signal<Option[]>([]);
  selectedDeptId = '';

  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};
  buildingOptions = signal<Option[]>([]);

  showDeleteConfirm = signal(false);
  deleteError = signal('');

  readonly sections = SECTIONS;
  readonly sectionGroups: string[];

  /** Whether the stored half-year has been applied, or the reader has already chosen one. */
  private paritySeeded = false;

  constructor() {
    this.sectionGroups = [...new Set(SECTIONS.map((s) => s.group))];

    // Each tab's own filters start empty when it opens. Keyed on the section rather than on the
    // click that changed it, so that arriving by a pasted URL or by the Back button leaves exactly
    // the state pressing the tab leaves. The семестр is deliberately not reset: it is which
    // half-year the reader is working in, not a narrowing of one tab's list, and re-defaulting it
    // on every tab change would fight them.
    effect(() => {
      this.activeSection();
      this.selectedDeptId = '';
      this.selectedProgId = '';
      this.courseSearch.set('');
      this.ttCourseYear.set('');
      this.ttDegreeProgramId.set('');
      this.ttGroupId.set('');
    });

    // Seeds the семестр picker once the settings resolve — see `TimetableView`'s constructor for
    // why an effect and not a microtask.
    effect(() => {
      const settled = this.settings.loaded() || !!this.settings.error();
      if (!settled || this.paritySeeded) return;
      this.paritySeeded = true;
      const current = this.settings.value('current_semester_parity');
      if (current === 'ODD' || current === 'EVEN') this.ttSemesterParity.set(current);
    });
  }

  onTtParityChange(value: string) {
    this.paritySeeded = true;   // an explicit choice is not overwritten by a late settings response
    this.ttSemesterParity.set(value === 'EVEN' ? 'EVEN' : 'ODD');
  }

  ngOnInit() {
    this.settings.ensureLoaded();
    this.loadFaculty();
    this.loadDepts();
    this.loadProgs();
    this.loadBuildings();
    this.loadGroupIds();
    this.auth.accessLevel('FACULTY', this.facultyId).subscribe((level) => this.facultyLevel.set(level));
  }

  sectionsForGroup(group: string): SectionDef[] {
    return SECTIONS.filter((s) => s.group === group)
      .filter((s) => s.key !== 'access' || this.canManageAccess())
      // A tab that exists only to enter data has nothing to show a reader who may not enter any:
      // every control on it would be refused, so offering it is offering «Немає доступу» under a
      // name that promises розклад. The address still works — see SECTION_KEYS.
      .filter((s) => !s.writes || this.auth.canReachType(s.writes));
  }

  selectSection(key: FacultySection) { this.nav.select(key); }

  get facultyPreset(): Record<string, string> { return { facultyId: this.facultyId }; }
  get deptFilterValue(): string | null { return this.selectedDeptId || null; }
  get deptPreset(): Record<string, string> {
    return this.selectedDeptId ? { departmentId: this.selectedDeptId } : {};
  }
  /** Courses on this page always belong to the current faculty, so facultyId is preset (hidden
   *  column, hidden on create, still editable to reassign) alongside the optional department filter. */
  get coursePreset(): Record<string, string> {
    return { facultyId: this.facultyId, ...this.deptPreset };
  }
  get progFilterValue(): string | null { return this.selectedProgId || null; }
  get progPreset(): Record<string, string> {
    return this.selectedProgId ? { degreeProgramId: this.selectedProgId } : {};
  }

  private loadFaculty() {
    const q = `query($id: ID!) { faculties { faculty(id: $id) { id name abbreviation phone email website building { id name address } } } }`;
    this.gql.request(q, { id: this.facultyId }).subscribe({
      next: (d: any) => this.faculty.set(d.faculties.faculty),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadDepts() {
    const q = `query($facultyId: ID, $limit: Int!) { departments { departmentConnection(limit: $limit, facultyId: $facultyId) { nodes { id name } } } }`;
    this.gql.request(q, { facultyId: this.facultyId, limit: 200 }).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.departments.departmentConnection.nodes.map((dep: any) => ({ id: dep.id, label: dep.name }));
        this.depts.set(opts);
      }
    });
  }

  private loadProgs() {
    const q = `query($facultyId: ID, $limit: Int!) { degreePrograms { degreeProgramConnection(limit: $limit, facultyId: $facultyId) { nodes { id name } } } }`;
    this.gql.request(q, { facultyId: this.facultyId, limit: 200 }).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.degreePrograms.degreeProgramConnection.nodes.map((sp: any) => ({ id: sp.id, label: sp.name }));
        this.progs.set(opts);
      }
    });
  }

  /**
   * A faculty timetable is the timetable of its academic groups: `timetableEntryConnection` has no
   * facultyId filter of its own, so the groups are resolved first and passed as `academicGroupIds`.
   */
  private loadGroupIds() {
    const q = `query($facultyId: ID, $limit: Int!, $offset: Int!) { academicGroups { academicGroupConnection(limit: $limit, offset: $offset, facultyId: $facultyId) { nodes {
      id name courseYear degreeProgram { id name }
    } } } }`;
    this.gql.request(q, { facultyId: this.facultyId, limit: 500, offset: 0 }).subscribe({
      next: (d: any) => this.allGroups.set(
        (d.academicGroups.academicGroupConnection.nodes ?? []).map((g: any) => ({
          id: String(g.id),
          name: g.name,
          courseYear: g.courseYear,
          degreeProgramId: g.degreeProgram?.id ? String(g.degreeProgram.id) : '',
          degreeProgramName: g.degreeProgram?.name ?? ''
        }))),
      error: () => this.allGroups.set([])
    });
  }

  private loadBuildings() {
    const q = `query($limit: Int!) { buildings { buildingConnection(limit: $limit) { nodes { id name } } } }`;
    this.gql.request(q, { limit: 100 }).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.buildings.buildingConnection.nodes.map((b: any) => ({ id: b.id, label: b.name }));
        this.buildingOptions.set(opts);
      },
      error: () => {}
    });
  }

  openEdit() {
    const f = this.faculty();
    if (!f) return;
    this.editForm = {
      name: f.name ?? '', abbreviation: f.abbreviation ?? '',
      email: f.email ?? '', phone: f.phone ?? '',
      website: f.website ?? '',
      buildingId: f.building?.id ?? '',
    };
    this.editError.set('');
    this.showEditForm.set(true);
  }

  closeEdit() { this.showEditForm.set(false); this.editError.set(''); }

  saveEdit() {
    const input: Record<string, any> = {};
    for (const f of ['name', 'abbreviation', 'email', 'phone', 'website', 'buildingId']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    const q = `mutation($id: ID!, $input: FacultyInputPayload!) { faculties { updateFaculty(id: $id, faculty: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.facultyId, input }).subscribe({
      next: (d: any) => {
        const res = d.faculties.updateFaculty;
        if (res.isSuccess) { this.closeEdit(); this.loadFaculty(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }

  openDelete() { this.deleteError.set(''); this.showDeleteConfirm.set(true); }
  closeDelete() { this.showDeleteConfirm.set(false); this.deleteError.set(''); }

  confirmDelete() {
    const q = `mutation($id: ID!) { faculties { deleteFaculty(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.facultyId }).subscribe({
      next: (d: any) => {
        const res = d.faculties.deleteFaculty;
        if (res.isSuccess) this.router.navigate(['/']);
        else this.deleteError.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.deleteError.set(e.message)
    });
  }
}
