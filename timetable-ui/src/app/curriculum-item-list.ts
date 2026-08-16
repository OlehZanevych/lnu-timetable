import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GqlVars, GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { GlobalPropertiesService } from './global-properties.service';
import { SearchSelect, Option } from './search-select';
import { CONTROL_FORM_OPTIONS, HOUR_TYPE_OPTIONS, toOptions } from './entities';
import { CurriculumSummary } from './curriculum-summary';
import { PlanHourType, PlanItemInput, buildCurriculumPlan } from './curriculum-plan';
import { CourseTagRef, courseLabel } from './course-label';
// `curriculum-report`, `pdf-fonts` and `workload-report` are imported dynamically in
// downloadPlan(): see the comment there for why the PDF engine is kept out of the main bundle.

type DeptOption = Option & { facultyId: string };

/** The degreeProgram this curriculum belongs to — everything the printed plan names it by. */
export interface CurriculumDegreeProgram {
  id: string;
  code: string;
  name: string;
  degree: string;
  faculty: { id: string; name: string };
}

interface CurriculumItemHours {
  id: string;
  hourType: string;
  hours: number;
}

interface CurriculumItem {
  id: string;
  semester: number;
  controlForm: string;
  ectsCredits?: number;
  course?: {
    id: string;
    name: string;
    courseType?: string;
    /** `courses.semester` — the one semester this discipline may be planned for, or null for any. */
    semester?: number | null;
    tags?: CourseTagRef[];
    faculty?: { id: string };
    department?: { id: string; faculty?: { id: string } };
  };
  hours: CurriculumItemHours[];
}

/**
 * Flattens a loaded row into the shape `curriculum-plan.ts` computes on: the nested `hours` list
 * becomes a map, which is how every consumer of it wants to read it.
 */
const toPlanItem = (item: CurriculumItem): PlanItemInput => {
  const hours: Partial<Record<PlanHourType, number>> = {};
  for (const h of item.hours ?? []) hours[h.hourType as PlanHourType] = h.hours;
  return {
    id: item.id,
    semester: item.semester,
    controlForm: item.controlForm,
    ectsCredits: item.ectsCredits ?? 0,
    course: item.course
      ? {
          id: item.course.id,
          name: item.course.name,
          courseType: item.course.courseType ?? 'MANDATORY',
          tags: (item.course.tags ?? []).map((t) => t.tag).filter(Boolean),
          semester: item.course.semester ?? null
        }
      : null,
    hours
  };
};

/**
 * Shows the curriculum items (with their per-type hour breakdown) belonging directly
 * to a degreeProgram, with create/edit/delete support for each item, the headline figures of the
 * resulting освітня програма, and the printable «Навчальний план» those figures are signed off on.
 */
@Component({
  selector: 'app-curriculum-item-list',
  templateUrl: './curriculum-item-list.html',
  imports: [FormsModule, RouterLink, SearchSelect, CurriculumSummary]
})
export class CurriculumItemList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);
  private auth = inject(AuthService);
  private settings = inject(GlobalPropertiesService);

  @Input() degreeProgramId!: string;
  /** The degreeProgram's own faculty; pre-selected as the faculty filter when opening the modal. */
  @Input() degreeProgramFacultyId: string | null = null;
  /**
   * The degreeProgram itself, passed down from the page that already loaded it. A signal, not a plain
   * field, because {@link plan} reads it inside a `computed()` — see the zoneless note in the README.
   */
  @Input() set degreeProgram(value: CurriculumDegreeProgram | null) { this.degreeProgramSignal.set(value); }

  readonly CONTROL_FORM_OPTIONS = CONTROL_FORM_OPTIONS;
  readonly HOUR_TYPE_OPTIONS = HOUR_TYPE_OPTIONS;
  readonly CONTROL_FORM_SELECT_OPTIONS = toOptions(CONTROL_FORM_OPTIONS);

  items = signal<CurriculumItem[]>([]);
  courseOptions = signal<Option[]>([]);
  error = signal('');

  /**
   * `courses.semester` of the discipline currently picked in the modal, or null when it has none —
   * which is every course until somebody sets the column.
   *
   * When it has one, the discipline may be planned for that semester and no other: the «Семестр»
   * field is filled in with it and closed, and {@link save} re-checks. A signal rather than a field
   * on `form` because the template reads it to decide whether the field is editable, and this page
   * is zoneless.
   */
  fixedSemester = signal<number | null>(null);

  /** `courses.id` → `courses.semester`, for the options currently offered. Filled by
   *  {@link loadCourseOptions}; {@link openEdit} seeds the edited course itself, which the
   *  faculty/department sub-filter may well be excluding. */
  private courseSemesters = new Map<string, number>();

  private degreeProgramSignal = signal<CurriculumDegreeProgram | null>(null);
  /** Raw `academic_groups.study_form` values among the degreeProgram's groups; names the форма навчання. */
  private studyForms = signal<string[]>([]);

  /** True while the PDF is being produced — the fonts are fetched on the first export. */
  exporting = signal(false);
  exportError = signal('');

  /**
   * The plan the printed sheet is built from — sections, totals and the compliance checks. The tab
   * shows its headline figures above the table so the screen and the PDF cannot disagree: both read
   * this one object.
   */
  plan = computed(() => buildCurriculumPlan(
    this.items().map(toPlanItem), this.degreeProgramSignal()?.degree ?? '', this.settings.limits()));

  showForm = signal(false);
  editingId = signal<string | null>(null);
  formError = signal('');
  form: Record<string, any> = {};

  /** Hour values being edited in the modal, keyed by hour type (e.g. 'LECTURE' -> '32'). */
  formHours: Record<string, string> = {};
  /** Existing curriculum_item_hours row id for each hour type present on the item being edited. */
  private existingHourIds: Record<string, string> = {};

  /**
   * Optional faculty/department filters that narrow the "Дисципліна" course list in the modal:
   * a department picks courses assigned directly to it; a faculty (with no department picked)
   * picks courses that faculty is directly responsible for (course.facultyId). Neither set shows
   * every course, unfiltered. Choosing a faculty narrows the department list to that faculty's
   * departments (or all departments when no faculty is chosen), but doesn't force a department.
   */
  facultyOptions = signal<Option[]>([]);
  departmentOptions = signal<DeptOption[]>([]);
  courseFacultyFilter = signal('');
  courseDepartmentFilter = signal('');

  filteredDepartmentOptions = computed(() => {
    const facultyId = this.courseFacultyFilter();
    return facultyId ? this.departmentOptions().filter((d) => d.facultyId === facultyId) : this.departmentOptions();
  });

  // ── Access ───────────────────────────────────────────────────────────────

  /**
   * This account's level on the освітня програма this table belongs to.
   *
   * Every row here is a позиція of that one план, and every mutation the table sends names its id,
   * so the освітня програма is the edge the server authorises all three of them through — the same
   * one `levelForNew` walks for a row that does not exist yet. One question answers the whole page.
   */
  private degreeProgramLevel = signal<AccessLevel | null>(null);

  /** The level in force: the освітня програма's own, or a stronger university-wide grant. */
  private effectiveLevel = computed(() => maxLevel(this.auth.globalLevel(), this.degreeProgramLevel()));

  /** «+ Додати» and «Редагувати» both write a позиція, so both need «Редагування». */
  canModify = computed(() => allows(this.effectiveLevel(), 'EDIT'));

  /** «Видалити» drops a позиція of the план outright, which needs «Повний доступ». */
  canDelete = computed(() => allows(this.effectiveLevel(), 'FULL'));

  private loadPermissions() {
    // Answering with the previous освітня програма's level while the new answer is in flight would
    // offer its controls over somebody else's план for a moment, so the old one is dropped first.
    this.degreeProgramLevel.set(null);
    if (!this.degreeProgramId) return;
    this.auth.accessLevel('DEGREE_PROGRAM', this.degreeProgramId)
      .subscribe((level) => this.degreeProgramLevel.set(level));
  }

  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    this.settings.ensureLoaded();
    this.loadFacultyOptions();
    this.loadDepartmentOptions();
    if (this.degreeProgramId) { this.loadItems(); this.loadStudyForms(); this.loadPermissions(); }
  }

  ngOnChanges() {
    if (this.initialized && this.degreeProgramId) { this.loadItems(); this.loadStudyForms(); this.loadPermissions(); }
  }

  private loadFacultyOptions() {
    const q = `query($limit: Int!, $offset: Int!) { faculties { facultyConnection(limit: $limit, offset: $offset) { nodes { id name } } } }`;
    this.gql.request(q, { limit: 1000, offset: 0 }).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.faculties.facultyConnection.nodes.map((f: any) => ({ id: f.id, label: f.name }));
        this.facultyOptions.set(opts);
      },
      error: () => {}
    });
  }

  private loadDepartmentOptions() {
    const q = `query($limit: Int!, $offset: Int!) { departments { departmentConnection(limit: $limit, offset: $offset) { nodes { id name faculty { id } } } } }`;
    this.gql.request(q, { limit: 1000, offset: 0 }).subscribe({
      next: (d: any) => {
        const opts: DeptOption[] = d.departments.departmentConnection.nodes.map((dept: any) => ({
          id: dept.id, label: dept.name, facultyId: dept.faculty?.id ?? ''
        }));
        this.departmentOptions.set(opts);
      },
      error: () => {}
    });
  }

  /**
   * Reloads the course list, always scoped to the current degreeProgram (via the courseConnection
   * degreeProgramId filter, backed by the course_degreePrograms table) — so only courses actually
   * allowed for this degreeProgram are ever offered, regardless of whether the optional
   * faculty/department sub-filter below is also set. Each option's label includes the course's
   * tags in parentheses (see courseLabel).
   */
  private loadCourseOptions() {
    if (!this.degreeProgramId) return;
    const deptId = this.courseDepartmentFilter();
    const facultyId = this.courseFacultyFilter();
    const v = new GqlVars();
    const args = [
      v.arg('limit', 'Int!', 1000),
      v.arg('offset', 'Int!', 0),
      v.arg('degreeProgramId', 'ID', this.degreeProgramId),
      deptId ? v.arg('departmentId', 'ID', deptId) : v.optionalArg('facultyId', 'ID', facultyId)
    ].filter(Boolean).join(', ');
    const q = `${v.declaration()}{ courses { courseConnection(${args}) { nodes { id name courseType semester tags { tag } } } } }`;
    this.gql.request(q, v.values).subscribe({
      next: (d: any) => {
        // An `ELECTIVE` is a choice inside a `ELECTIVE_GROUP`, and it is the group that a plan
        // reserves a position for — so the picker offers groups and never their children. The one
        // exception is the course this form is already editing: an edit form must never silently
        // drop a value the database holds, so a position that names an elective keeps naming it
        // until someone changes it on purpose.
        const editing = String(this.form['courseId'] ?? '');
        const offered = d.courses.courseConnection.nodes
          .filter((c: any) => c.courseType !== 'ELECTIVE' || String(c.id) === editing);
        for (const c of offered) {
          const n = Number(c.semester);
          if (Number.isInteger(n) && n > 0) this.courseSemesters.set(String(c.id), n);
          else this.courseSemesters.delete(String(c.id));
        }
        const opts: Option[] = offered.map((c: any) => ({ id: c.id, label: courseLabel(c.name, c.tags, c.semester) }));
        this.courseOptions.set(opts);
        // The list arrives after the modal opens, so the restriction is re-read once it is here.
        this.fixedSemester.set(editing ? (this.courseSemesters.get(editing) ?? null) : null);
      },
      error: () => {}
    });
  }

  /** Exposed for the template — the shared rule, see `course-label.ts`. */
  courseLabel = courseLabel;

  /**
   * A stored position sitting in a semester its course is not allowed in. Unreachable through this
   * page now — the modal offers nothing else — but a course can be restricted *after* its positions
   * were written, and a plan that silently disagrees with its own disciplines is worse than one
   * that says so. Flagged in the table, and refused by {@link save} when the row is next edited.
   */
  rowOffSemester(item: CurriculumItem): boolean {
    const fixed = Number(item.course?.semester);
    return Number.isInteger(fixed) && fixed > 0 && item.semester !== fixed;
  }

  /**
   * Picking a discipline restricted to one semester fills the «Семестр» field in with it and closes
   * the field: the position belongs there and nowhere else, so the wrong value is unreachable
   * rather than caught on save. Picking an unrestricted one re-opens the field and leaves whatever
   * was typed — clearing it would throw away a value the user chose deliberately.
   */
  onCourseChange(courseId: string) {
    this.form['courseId'] = courseId ?? '';
    const fixed = courseId ? (this.courseSemesters.get(String(courseId)) ?? null) : null;
    this.fixedSemester.set(fixed);
    if (fixed !== null) this.form['semester'] = fixed;
  }

  /** A position stored in a semester its course is no longer allowed in — see {@link save}. */
  isOffSemester(): boolean {
    const fixed = this.fixedSemester();
    const current = this.form['semester'];
    return fixed !== null && current !== '' && current !== undefined && current !== null
      && Number(current) !== fixed;
  }

  onCourseFacultyFilterChange(facultyId: string) {
    this.courseFacultyFilter.set(facultyId);
    this.courseDepartmentFilter.set('');
    this.form['courseId'] = '';
    this.fixedSemester.set(null);
    this.loadCourseOptions();
  }

  onCourseDepartmentFilterChange(deptId: string) {
    this.courseDepartmentFilter.set(deptId);
    this.form['courseId'] = '';
    this.fixedSemester.set(null);
    this.loadCourseOptions();
  }

  private loadItems() {
    if (!this.degreeProgramId) return;
    // courseType is selected for the printed plan: it is what sorts an item into «Обов'язкові» /
    // «Вибіркові компоненти», «Практична підготовка» or «Атестація», and the 25 % share of
    // ст. 62 ч. 1 п. 15 cannot be computed without it.
    const q = `query($degreeProgramId: ID, $limit: Int!, $offset: Int!) { curriculumItems { curriculumItemConnection(limit: $limit, offset: $offset, degreeProgramId: $degreeProgramId) { nodes {
      id semester controlForm ectsCredits
      course { id name courseType semester tags { tag } faculty { id } department { id faculty { id } } }
      hours { id hourType hours }
    } } } }`;
    this.gql.request(q, { degreeProgramId: this.degreeProgramId, limit: 500, offset: 0 }).subscribe({
      next: (d: any) => this.items.set(d.curriculumItems.curriculumItemConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  /**
   * The форма здобуття освіти named on the printed plan. The model records it per academic group
   * (`academic_groups.study_form`), not per degreeProgram, so it is read off the groups; a degreeProgram
   * with no groups yet simply leaves that line of the form blank.
   */
  private loadStudyForms() {
    if (!this.degreeProgramId) return;
    const q = `query($degreeProgramId: ID, $limit: Int!, $offset: Int!) { academicGroups { academicGroupConnection(limit: $limit, offset: $offset, degreeProgramId: $degreeProgramId) { nodes { id studyForm } } } }`;
    this.gql.request(q, { degreeProgramId: this.degreeProgramId, limit: 500, offset: 0 }).subscribe({
      next: (d: any) => this.studyForms.set(
        d.academicGroups.academicGroupConnection.nodes.map((g: any) => g.studyForm).filter(Boolean)),
      error: () => this.studyForms.set([])
    });
  }

  controlFormLabel(v: string): string {
    return this.CONTROL_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  hourTypeLabel(v: string): string {
    return this.HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  // ── Create / Edit ────────────────────────────────────────────────────────

  openCreate() {
    this.editingId.set(null);
    this.form = { semester: '', controlForm: '', ectsCredits: '', courseId: '' };
    this.formHours = {};
    this.existingHourIds = {};
    // Default to the degreeProgram's own faculty, since courses for this curriculum most often
    // belong to it; the user can still clear/change it to browse other faculties.
    this.courseFacultyFilter.set(this.degreeProgramFacultyId ?? '');
    this.courseDepartmentFilter.set('');
    this.fixedSemester.set(null);
    this.loadCourseOptions();
    this.formError.set('');
    this.showForm.set(true);
  }

  openEdit(item: CurriculumItem) {
    this.editingId.set(item.id);
    this.form = {
      semester: item.semester ?? '',
      controlForm: item.controlForm ?? '',
      ectsCredits: item.ectsCredits ?? '',
      courseId: item.course?.id ?? '',
    };
    this.formHours = {};
    this.existingHourIds = {};
    for (const h of item.hours ?? []) {
      this.formHours[h.hourType] = h.hours != null ? String(h.hours) : '';
      this.existingHourIds[h.hourType] = h.id;
    }

    // Pre-fill the faculty/department filters from the item's current course, so its own
    // department (or direct faculty) is already visible/selected rather than starting blank.
    // Falls back to the degreeProgram's own faculty if the course has neither.
    const deptId = item.course?.department?.id ?? '';
    const courseFacultyId = deptId ? (item.course?.department?.faculty?.id ?? '') : (item.course?.faculty?.id ?? '');
    this.courseFacultyFilter.set(courseFacultyId || (this.degreeProgramFacultyId ?? ''));
    this.courseDepartmentFilter.set(deptId);
    // Seeded from the row itself rather than waiting for the options: the faculty/department
    // sub-filter above may not offer this course at all, and the stored semester still has to be
    // measured against its course's restriction.
    const own = Number(item.course?.semester);
    if (item.course?.id && Number.isInteger(own) && own > 0) {
      this.courseSemesters.set(String(item.course.id), own);
      this.fixedSemester.set(own);
    } else {
      if (item.course?.id) this.courseSemesters.delete(String(item.course.id));
      this.fixedSemester.set(null);
    }
    this.loadCourseOptions();

    this.formError.set('');
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.formError.set('');
  }

  /**
   * A single createCurriculumItem/updateCurriculumItem call now also creates/updates/deletes
   * the item's curriculum_item_hours rows via the nested `hours` list on the input payload
   * (see CurriculumSchemaConfig's `.nestedList("hours", ...)`), so no separate hours mutations
   * are needed here anymore.
   */
  save() {
    if (!this.degreeProgramId) return;
    // The field is closed whenever a restriction applies, so this only fires on a position stored
    // before its course was restricted — which is exactly the one that must not be re-saved as it
    // stands.
    if (this.isOffSemester()) {
      this.formError.set(`Цю дисципліну можна планувати лише на семестр ${this.fixedSemester()}.`);
      return;
    }
    const input: Record<string, any> = { degreeProgramId: this.degreeProgramId, hours: this.buildHoursInput() };
    if (this.form['courseId']) input['courseId'] = this.form['courseId'];
    if (this.form['controlForm']) input['controlForm'] = this.form['controlForm'];
    if (this.form['semester'] !== undefined && this.form['semester'] !== '') input['semester'] = Number(this.form['semester']);
    if (this.form['ectsCredits'] !== undefined && this.form['ectsCredits'] !== '') input['ectsCredits'] = Number(this.form['ectsCredits']);

    const id = this.editingId();
    const op = id ? 'updateCurriculumItem' : 'createCurriculumItem';
    const q = id
      ? `mutation($id: ID!, $input: CurriculumItemInputPayload!) { curriculumItems { ${op}(id: $id, curriculumItem: $input) { isSuccess errorStatus } } }`
      : `mutation($input: CurriculumItemInputPayload!) { curriculumItems { ${op}(curriculumItem: $input) { isSuccess errorStatus } } }`;

    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = d.curriculumItems[op];
        if (res.isSuccess) { this.closeForm(); this.loadItems(); }
        else this.formError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.formError.set(e.message)
    });
  }

  /**
   * Builds the nested `hours` input list from the modal's per-hour-type fields: an `id` is
   * included when editing an existing hour row (so the backend matches and updates it instead
   * of inserting a new one); hour types left blank are simply omitted, which the backend's
   * reconciliation treats as "removed".
   */
  private buildHoursInput(): Record<string, any>[] {
    const items: Record<string, any>[] = [];
    for (const opt of this.HOUR_TYPE_OPTIONS) {
      const raw = this.formHours[opt.value];
      if (raw === undefined || raw === null || raw === '') continue;
      const item: Record<string, any> = { hourType: opt.value, hours: Number(raw) };
      const existingId = this.existingHourIds[opt.value];
      if (existingId) item['id'] = existingId;
      items.push(item);
    }
    return items;
  }

  // ── Printable plan ───────────────────────────────────────────────────────

  /**
   * Builds the printable «Навчальний план» for this degreeProgram and hands it to the browser as a
   * download.
   *
   * Everything happens on the client: the document is assembled from the plan already in memory by
   * `curriculum-report.ts` and written out by the project's own PDF writer, so no round trip and no
   * server-side rendering is involved. The only fetch is for the embedded font, and only on the
   * first export of a session.
   *
   * The document modules are **imported dynamically**, so the PDF engine, the report and the font
   * loader are a lazy chunk rather than part of the main bundle — the same bargain the font subsets
   * already make: a user who never exports pays nothing for the ability to.
   */
  async downloadPlan() {
    const degreeProgram = this.degreeProgramSignal();
    if (!degreeProgram || this.exporting() || !this.items().length) return;

    this.exporting.set(true);
    this.exportError.set('');
    const generatedAt = new Date();
    const plan = this.plan();

    try {
      const [{ downloadPdf, loadReportFonts }, { buildCurriculumReport, curriculumReportFileName },
             { academicYearLabel }] = await Promise.all([
        import('./pdf-fonts'), import('./curriculum-report'), import('./workload-report')
      ]);
      const fonts = await loadReportFonts();
      const bytes = buildCurriculumReport({
        plan,
        degreeProgramCode: degreeProgram.code ?? '',
        degreeProgramName: degreeProgram.name ?? '',
        degree: degreeProgram.degree ?? '',
        facultyName: degreeProgram.faculty?.name ?? '',
        studyForms: this.studyForms(),
        generatedAt,
        fonts
      });
      downloadPdf(bytes, curriculumReportFileName(
        degreeProgram.code ?? '', degreeProgram.degree ?? '', academicYearLabel(generatedAt)));
    } catch (e: unknown) {
      this.exportError.set(e instanceof Error ? e.message : 'Не вдалося сформувати PDF');
    } finally {
      this.exporting.set(false);
    }
  }

  remove(item: CurriculumItem) {
    const q = `mutation($id: ID!) { curriculumItems { deleteCurriculumItem(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: item.id }).subscribe({
      next: (d: any) => {
        const res = d.curriculumItems.deleteCurriculumItem;
        if (res.isSuccess) this.loadItems();
        else this.error.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.error.set(e.message)
    });
  }
}
