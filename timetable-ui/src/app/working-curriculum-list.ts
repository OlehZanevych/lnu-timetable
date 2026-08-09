import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { GlobalPropertiesService } from './global-properties.service';
import { SearchSelect, Option } from './search-select';
import { MultiSelect } from './multi-select';
import { CONTROL_FORM_OPTIONS, HOUR_TYPE_OPTIONS, TEACHING_FORMAT_OPTIONS, toOptions } from './entities';
import { WorkingCurriculumSummary } from './working-curriculum-summary';
import { WorkingPlanItemInput, buildWorkingCurriculumPlan } from './working-curriculum-plan';
import { CourseTagRef, courseLabel, courseTagNames } from './course-label';

type DeptOption = Option & { facultyId: string };
type GroupOption = Option & { courseYear: number };

interface ChildCourse {
  id: string;
  name: string;
  courseType: string;
  tags?: CourseTagRef[] | null;
}

interface ItemCourse {
  id: string;
  name: string;
  courseType: string;
  tags?: CourseTagRef[] | null;
  childCourses?: ChildCourse[];
}

interface AcademicGroupRef {
  id: string;
  name: string;
  /** Only read by the summary above the page: individual work is charged per student. */
  studentsCount?: number | null;
}

interface WorkingItem {
  id: string;
  lecturerCount: number;
  teachingFormat: string;
  department?: { id: string; name: string; faculty?: { id: string } };
  course?: { id: string; name: string; tags?: CourseTagRef[] | null } | null;
  academicGroups: AcademicGroupRef[];
}

interface HoursBlock {
  id: string;
  hourType: string;
  hours: number;
  workingCurriculumItems: WorkingItem[];
}

interface CurriculumItemNode {
  id: string;
  semester: number;
  controlForm: string;
  ectsCredits?: number;
  course?: ItemCourse;
  hours: HoursBlock[];
}

/**
 * Flattens the editor's tree into the shape `working-curriculum-plan.ts` computes on, so the strip
 * above the page is the very object the reading tab and the printed sheet are built from.
 */
const toWorkingPlanItem = (item: CurriculumItemNode): WorkingPlanItemInput => ({
  id: item.id,
  semester: item.semester,
  controlForm: item.controlForm,
  ectsCredits: item.ectsCredits ?? 0,
  course: item.course
    ? { id: item.course.id, name: item.course.name, courseType: item.course.courseType ?? 'MANDATORY',
        tags: courseTagNames(item.course.tags) }
    : null,
  hours: (item.hours ?? []).map((h) => ({
    id: h.id,
    hourType: h.hourType,
    hours: h.hours ?? 0,
    positions: (h.workingCurriculumItems ?? []).map((w) => ({
      id: w.id,
      departmentId: w.department?.id ?? '',
      departmentName: w.department?.name ?? '—',
      lecturerCount: w.lecturerCount ?? 1,
      teachingFormat: w.teachingFormat ?? '',
      electiveCourseName: w.course?.name ?? null,
      groups: (w.academicGroups ?? []).map((g) => ({
        id: g.id, name: g.name, studentsCount: g.studentsCount ?? null
      }))
    }))
  }))
});

/**
 * Shows, for a specialty, every curriculum item block (semester / discipline / control form / ECTS),
 * each containing its curriculum_item_hours sub-blocks, and under each hours sub-block the working
 * curriculum items (робочий навчальний план) assigned to it, with create/edit/delete support.
 */
@Component({
  selector: 'app-working-curriculum-list',
  templateUrl: './working-curriculum-list.html',
  imports: [FormsModule, RouterLink, SearchSelect, MultiSelect, WorkingCurriculumSummary]
})
export class WorkingCurriculumList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);
  private settings = inject(GlobalPropertiesService);

  @Input() specialtyId!: string;
  /** The specialty's own faculty; pre-selected as the department faculty filter when opening the modal. */
  @Input() specialtyFacultyId: string | null = null;

  readonly CONTROL_FORM_OPTIONS = CONTROL_FORM_OPTIONS;
  readonly HOUR_TYPE_OPTIONS = HOUR_TYPE_OPTIONS;
  readonly TEACHING_FORMAT_OPTIONS = TEACHING_FORMAT_OPTIONS;
  readonly TEACHING_FORMAT_SELECT_OPTIONS = toOptions(TEACHING_FORMAT_OPTIONS);

  /**
   * Робочі навчальні плани only make sense for hour types a lecturer actually delivers.
   * Consultations and assessment work qualify (INDIVIDUALLY exists precisely for the former);
   * INDEPENDENT_WORK is the student's own time and has no lecturer assigned to it.
   */
  private readonly ADDABLE_HOUR_TYPES = new Set(['LECTURE', 'PRACTICAL', 'LAB', 'CONSULTATION', 'ASSESSMENT']);

  items = signal<CurriculumItemNode[]>([]);
  error = signal('');

  /**
   * The same plan the reading tab and the printed «Робочий навчальний план» are built from, over
   * every курс of the specialty. Shown above the editor so the coverage figure moves as кафедри are
   * assigned: it is otherwise impossible to tell, from a page of nested blocks, whether the last
   * block of hours has found an owner.
   */
  plan = computed(() =>
    buildWorkingCurriculumPlan(this.items().map(toWorkingPlanItem), null, this.settings.limits()));

  facultyOptions = signal<Option[]>([]);
  departmentOptions = signal<DeptOption[]>([]);
  groupOptions = signal<GroupOption[]>([]);

  /** Optional faculty filter that narrows the "Кафедра" select in the modal. */
  departmentFacultyFilter = signal('');

  filteredDepartmentOptions = computed(() => {
    const facultyId = this.departmentFacultyFilter();
    return facultyId ? this.departmentOptions().filter((d) => d.facultyId === facultyId) : this.departmentOptions();
  });

  /** The semester of the curriculum item the modal was opened from; drives the course-year filter below. */
  activeSemester = signal<number | null>(null);

  /** Groups only make sense to assign if their course year matches the item's semester (semesters 1-2 → year 1, 3-4 → year 2, etc.). */
  filteredGroupOptions = computed(() => {
    const semester = this.activeSemester();
    if (semester == null) return this.groupOptions();
    const year = Math.ceil(semester / 2);
    return this.groupOptions().filter((g) => g.courseYear === year);
  });

  showForm = signal(false);
  editingId = signal<string | null>(null);
  formError = signal('');
  form: Record<string, any> = {};
  formGroupIds: string[] = [];

  /** True when the curriculum item the modal was opened from has an ELECTIVE_GROUP course, so an elective must be chosen. */
  isElectiveContext = signal(false);
  electiveOptions = signal<Option[]>([]);

  private activeHoursId: string | null = null;
  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    this.settings.ensureLoaded();
    this.loadFacultyOptions();
    this.loadDepartmentOptions();
    this.loadGroupOptions();
    if (this.specialtyId) this.loadItems();
  }

  ngOnChanges() {
    if (this.initialized && this.specialtyId) {
      this.loadItems();
      this.loadGroupOptions();
    }
  }

  private loadItems() {
    if (!this.specialtyId) return;
    const q = `query($specialtyId: ID, $limit: Int!, $offset: Int!) { curriculumItems { curriculumItemConnection(limit: $limit, offset: $offset, specialtyId: $specialtyId) { nodes {
      id semester controlForm ectsCredits
      course { id name courseType tags { tag } childCourses { id name courseType tags { tag } } }
      hours { id hourType hours
        workingCurriculumItems {
          id lecturerCount teachingFormat
          department { id name faculty { id } }
          course { id name tags { tag } }
          academicGroups { id name studentsCount }
        }
      }
    } } } }`;
    this.gql.request(q, { specialtyId: this.specialtyId, limit: 500, offset: 0 }).subscribe({
      next: (d: any) => this.items.set(d.curriculumItems.curriculumItemConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
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
        const opts: DeptOption[] = d.departments.departmentConnection.nodes.map((dep: any) => ({
          id: dep.id, label: dep.name, facultyId: dep.faculty?.id ?? ''
        }));
        this.departmentOptions.set(opts);
      },
      error: () => {}
    });
  }

  onDepartmentFacultyFilterChange(facultyId: string) {
    this.departmentFacultyFilter.set(facultyId);
    this.form['departmentId'] = '';
  }

  private loadGroupOptions() {
    if (!this.specialtyId) return;
    const q = `query($specialtyId: ID, $limit: Int!, $offset: Int!) { academicGroups { academicGroupConnection(limit: $limit, offset: $offset, specialtyId: $specialtyId) { nodes { id name courseYear } } } }`;
    this.gql.request(q, { specialtyId: this.specialtyId, limit: 500, offset: 0 }).subscribe({
      next: (d: any) => {
        const opts: GroupOption[] = d.academicGroups.academicGroupConnection.nodes.map((g: any) => ({ id: g.id, label: g.name, courseYear: g.courseYear }));
        this.groupOptions.set(opts);
      },
      error: () => {}
    });
  }

  controlFormLabel(v: string): string {
    return this.CONTROL_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  hourTypeLabel(v: string): string {
    return this.HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  canAddWorkingItem(hourType: string): boolean {
    return this.ADDABLE_HOUR_TYPES.has(hourType);
  }

  teachingFormatLabel(v: string): string {
    return this.TEACHING_FORMAT_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  groupNames(wci: WorkingItem): string {
    return (wci.academicGroups ?? []).map((g) => g.name).join(', ') || '—';
  }

  /** The "Вибіркова дисципліна" column/field only applies to items whose course is a group of electives. */
  isElectiveGroupCourse(item: CurriculumItemNode): boolean {
    return item.course?.courseType === 'ELECTIVE_GROUP';
  }

  /** Exposed for the template — the shared rule, see `course-label.ts`. */
  courseLabel = courseLabel;

  private setElectiveContext(item: CurriculumItemNode) {
    const isElectiveGroup = this.isElectiveGroupCourse(item);
    this.isElectiveContext.set(isElectiveGroup);
    if (!isElectiveGroup) {
      this.electiveOptions.set([]);
      return;
    }
    const children = item.course?.childCourses ?? [];
    const electives = children.filter((c) => c.courseType === 'ELECTIVE');
    const source = electives.length ? electives : children;
    this.electiveOptions.set(source.map((c) => ({ id: c.id, label: courseLabel(c.name, c.tags) })));
  }

  // ── Create / Edit ────────────────────────────────────────────────────────

  openCreate(hours: HoursBlock, item: CurriculumItemNode) {
    if (!this.canAddWorkingItem(hours.hourType)) return;
    this.editingId.set(null);
    this.activeHoursId = hours.id;
    this.activeSemester.set(item.semester);
    this.form = { departmentId: '', lecturerCount: '1', teachingFormat: 'TOGETHER', courseId: '' };
    this.formGroupIds = [];
    // Default to the specialty's own faculty, since departments delivering this item most often
    // belong to it; the user can still clear/change it to browse other faculties.
    this.departmentFacultyFilter.set(this.specialtyFacultyId ?? '');
    this.setElectiveContext(item);
    this.formError.set('');
    this.showForm.set(true);
  }

  openEdit(hours: HoursBlock, item: CurriculumItemNode, wci: WorkingItem) {
    this.editingId.set(wci.id);
    this.activeHoursId = hours.id;
    this.activeSemester.set(item.semester);
    this.form = {
      departmentId: wci.department?.id ?? '',
      lecturerCount: wci.lecturerCount ?? '',
      teachingFormat: wci.teachingFormat ?? '',
      courseId: wci.course?.id ?? '',
    };
    this.formGroupIds = (wci.academicGroups ?? []).map((g) => g.id);
    // Pre-fill the faculty filter from the item's current department, so its own faculty is
    // already visible/selected rather than starting blank. Falls back to the specialty's faculty.
    this.departmentFacultyFilter.set(wci.department?.faculty?.id || (this.specialtyFacultyId ?? ''));
    this.setElectiveContext(item);
    this.formError.set('');
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.formError.set('');
  }

  save() {
    if (!this.activeHoursId) return;
    const input: Record<string, any> = {
      curriculumItemHoursId: this.activeHoursId,
      academicGroupIds: this.formGroupIds,
    };
    if (this.form['departmentId']) input['departmentId'] = this.form['departmentId'];
    if (this.form['teachingFormat']) input['teachingFormat'] = this.form['teachingFormat'];
    if (this.form['lecturerCount'] !== undefined && this.form['lecturerCount'] !== '') {
      input['lecturerCount'] = Number(this.form['lecturerCount']);
    }
    if (this.isElectiveContext() && this.form['courseId']) input['courseId'] = this.form['courseId'];

    const id = this.editingId();
    const op = id ? 'updateWorkingCurriculumItem' : 'createWorkingCurriculumItem';
    const q = id
      ? `mutation($id: ID!, $input: WorkingCurriculumItemInputPayload!) { workingCurriculumItems { ${op}(id: $id, workingCurriculumItem: $input) { isSuccess errorStatus } } }`
      : `mutation($input: WorkingCurriculumItemInputPayload!) { workingCurriculumItems { ${op}(workingCurriculumItem: $input) { isSuccess errorStatus } } }`;

    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = d.workingCurriculumItems[op];
        if (res.isSuccess) { this.closeForm(); this.loadItems(); }
        else this.formError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.formError.set(e.message)
    });
  }

  remove(wci: WorkingItem) {
    const q = `mutation($id: ID!) { workingCurriculumItems { deleteWorkingCurriculumItem(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: wci.id }).subscribe({
      next: (d: any) => {
        const res = d.workingCurriculumItems.deleteWorkingCurriculumItem;
        if (res.isSuccess) this.loadItems();
        else this.error.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.error.set(e.message)
    });
  }
}
