import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { SearchSelect, Option } from './search-select';
import { SEMESTER_PARITY_OPTIONS } from './entities';
import { GlobalPropertiesService } from './global-properties.service';
import { compareUk } from './sort';
import { DepartmentList } from './department-list';
import { SpecialtyList } from './specialty-list';
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
  specialtyId: string;
  specialtyName: string;
}

export type FacultySection =
  | 'info'
  | 'departments' | 'specialties' | 'rooms' | 'roomGroups'
  | 'courses' | 'roomAssignment' | 'timetable' | 'facultyTimetable' | 'academicGroups' | 'combinedGroups'
  | 'groupConstraints' | 'roomConstraints';

interface SectionDef { key: FacultySection; label: string; group: string; }

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
  { key: 'specialties',            label: 'Спеціальності',        group: 'Структура' },
  { key: 'rooms',                  label: 'Аудиторії',            group: 'Структура' },
  { key: 'roomGroups',             label: 'Групи аудиторій',      group: 'Структура' },
  { key: 'academicGroups',         label: 'Академічні групи',     group: 'Люди та групи' },
  { key: 'combinedGroups',         label: "Об'єднані групи",      group: 'Люди та групи' },
  { key: 'courses',                label: 'Дисципліни',           group: 'Навчальні плани' },
  // "Розклад" runs in the order the work does: say where each class may be held and when its
  // groups and rooms are unavailable, then generate a timetable that obeys all three, then read it.
  { key: 'roomAssignment',         label: 'Призначення аудиторій', group: 'Розклад' },
  { key: 'groupConstraints',       label: 'Обмеження груп',       group: 'Розклад' },
  { key: 'roomConstraints',        label: 'Обмеження аудиторій',  group: 'Розклад' },
  { key: 'timetable',              label: 'Формування розкладу',  group: 'Розклад' },
  { key: 'facultyTimetable',       label: 'Розклад факультету',   group: 'Розклад' },
];

@Component({
  selector: 'app-faculty-page',
  templateUrl: './faculty-page.html',
  imports: [
    RouterLink, FormsModule, SearchSelect,
    DepartmentList, SpecialtyList, AcademicGroupList, RoomAssignmentList, FacultyTimetableList,
    TimetableConstraintList, TimetableView, RoomPage, RoomGroupPage, CoursePage, CombinedGroupPage
  ]
})
export class FacultyPage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private gql = inject(GraphqlService);
  auth = inject(AuthService);
  private settings = inject(GlobalPropertiesService);

  readonly facultyId: string = this.route.snapshot.paramMap.get('id')!;

  /** Whether the current user may edit/delete this Faculty (edit/delete buttons in the template
   *  are gated on this — see AuthService#canModifyIds). */
  canModifyFaculty = signal(false);

  faculty = signal<Faculty | null>(null);
  error = signal('');
  activeSection = signal<FacultySection>('info');

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

  /** The tab's filters. `''` means "all" in each. They combine: курс ∧ спеціальність ∧ група. */
  ttCourseYear = signal('');
  ttSpecialtyId = signal('');
  ttGroupId = signal('');

  /**
   * The groups the timetable is drawn for. `timetableEntryConnection` has no facultyId filter, so
   * the faculty timetable has always been "the timetable of these group ids" — which makes
   * narrowing the ids the whole of the filtering. An empty result loads nothing and shows an empty
   * grid, which is the honest answer to a combination no group matches.
   */
  groupIds = computed(() => {
    const year = this.ttCourseYear();
    const spec = this.ttSpecialtyId();
    const group = this.ttGroupId();
    return this.allGroups()
      .filter((g) => (!year || String(g.courseYear) === year)
                  && (!spec || g.specialtyId === spec)
                  && (!group || g.id === group))
      .map((g) => g.id);
  });

  /** Курси that actually have groups, ascending — «1 курс», «2 курс», … */
  ttCourseYearOptions = computed<Option[]>(() =>
    [...new Set(this.allGroups().map((g) => g.courseYear))]
      .sort((a, b) => a - b)
      .map((y) => ({ id: String(y), label: `${y} курс` })));

  /** Only specialties that have groups — an option that could only ever produce an empty grid is
   *  not a filter, it is a trap. */
  ttSpecialtyOptions = computed<Option[]>(() => {
    const byId = new Map<string, string>();
    for (const g of this.allGroups()) if (g.specialtyId) byId.set(g.specialtyId, g.specialtyName);
    return [...byId].map(([id, label]) => ({ id, label }))
      .sort((a, b) => compareUk(a.label, b.label));
  });

  /** Cascaded: the groups left once курс and спеціальність have been applied. */
  ttGroupOptions = computed<Option[]>(() => {
    const year = this.ttCourseYear();
    const spec = this.ttSpecialtyId();
    return this.allGroups()
      .filter((g) => (!year || String(g.courseYear) === year) && (!spec || g.specialtyId === spec))
      .map((g) => ({ id: g.id, label: g.name }))
      .sort((a, b) => compareUk(a.label, b.label));
  });

  /**
   * Changing курс or спеціальність drops a chosen група that no longer belongs to them. Leaving it
   * selected would filter the grid down to nothing while the група picker showed a name the курс
   * picker contradicts — two controls disagreeing about what is on screen.
   */
  /** True when the three filters between them name no group at all — as opposed to naming groups
   *  that happen to have no classes. The two look identical in an empty grid and are not the same. */
  ttNoGroupsMatch = computed(() => this.allGroups().length > 0 && this.groupIds().length === 0);

  /**
   * What the sheet is of, in words: the faculty, then whichever of курс / спеціальність / група has
   * been chosen. An exported subset that still called itself the faculty's timetable would be a
   * signed document making a claim about classes it does not contain.
   */
  ttReportSubject = computed(() => {
    const faculty = this.faculty()?.name ?? '';
    const parts = [faculty];
    const year = this.ttCourseYear();
    if (year) parts.push(`${year} курс`);
    const spec = this.ttSpecialtyOptions().find((o) => o.id === this.ttSpecialtyId());
    if (spec) parts.push(spec.label);
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

  specs = signal<Option[]>([]);
  selectedSpecId = '';
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
    this.loadSpecs();
    this.loadBuildings();
    this.loadGroupIds();
    if (this.auth.isAdmin()) {
      this.canModifyFaculty.set(true);
    } else {
      this.auth.canModifyIds('FACULTY', [this.facultyId]).subscribe((ids) => this.canModifyFaculty.set(ids.has(this.facultyId)));
    }
  }

  sectionsForGroup(group: string): SectionDef[] {
    return SECTIONS.filter((s) => s.group === group);
  }

  selectSection(key: FacultySection) {
    this.activeSection.set(key);
    this.selectedDeptId = '';
    this.selectedSpecId = '';
    this.courseSearch.set('');
    this.ttCourseYear.set('');
    this.ttSpecialtyId.set('');
    this.ttGroupId.set('');
    // The семестр is deliberately not reset: it is which half-year the reader is working in, not a
    // narrowing of one tab's list, and re-defaulting it on every tab change would fight them.
  }

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
  get specFilterValue(): string | null { return this.selectedSpecId || null; }
  get specPreset(): Record<string, string> {
    return this.selectedSpecId ? { specialtyId: this.selectedSpecId } : {};
  }

  private loadFaculty() {
    const q = `{ faculties { faculty(id: "${this.facultyId}") { id name abbreviation phone email website building { id name address } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.faculty.set(d.faculties.faculty),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadDepts() {
    const q = `{ departments { departmentConnection(limit: 200, facultyId: "${this.facultyId}") { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.departments.departmentConnection.nodes.map((dep: any) => ({ id: dep.id, label: dep.name }));
        this.depts.set(opts);
      }
    });
  }

  private loadSpecs() {
    const q = `{ specialties { specialtyConnection(limit: 200, facultyId: "${this.facultyId}") { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.specialties.specialtyConnection.nodes.map((sp: any) => ({ id: sp.id, label: sp.name }));
        this.specs.set(opts);
      }
    });
  }

  /**
   * A faculty timetable is the timetable of its academic groups: `timetableEntryConnection` has no
   * facultyId filter of its own, so the groups are resolved first and passed as `academicGroupIds`.
   */
  private loadGroupIds() {
    const q = `{ academicGroups { academicGroupConnection(limit: 500, offset: 0, facultyId: "${this.facultyId}") { nodes {
      id name courseYear specialty { id name }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.allGroups.set(
        (d.academicGroups.academicGroupConnection.nodes ?? []).map((g: any) => ({
          id: String(g.id),
          name: g.name,
          courseYear: g.courseYear,
          specialtyId: g.specialty?.id ? String(g.specialty.id) : '',
          specialtyName: g.specialty?.name ?? ''
        }))),
      error: () => this.allGroups.set([])
    });
  }

  private loadBuildings() {
    const q = `{ buildings { buildingConnection(limit: 100) { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
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
