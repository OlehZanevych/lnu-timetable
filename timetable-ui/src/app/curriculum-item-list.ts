import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { SearchSelect, Option } from './search-select';
import { CONTROL_FORM_OPTIONS, HOUR_TYPE_OPTIONS } from './entities';

type DeptOption = Option & { facultyId: string };

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
    faculty?: { id: string };
    department?: { id: string; faculty?: { id: string } };
  };
  hours: CurriculumItemHours[];
}

/**
 * Shows the curriculum items (with their per-type hour breakdown) belonging directly
 * to a specialty, with create/edit/delete support for each item.
 */
@Component({
  selector: 'app-curriculum-item-list',
  templateUrl: './curriculum-item-list.html',
  imports: [FormsModule, SearchSelect]
})
export class CurriculumItemList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);

  @Input() specialtyId!: string;
  /** The specialty's own faculty; pre-selected as the faculty filter when opening the modal. */
  @Input() specialtyFacultyId: string | null = null;

  readonly CONTROL_FORM_OPTIONS = CONTROL_FORM_OPTIONS;
  readonly HOUR_TYPE_OPTIONS = HOUR_TYPE_OPTIONS;

  items = signal<CurriculumItem[]>([]);
  courseOptions = signal<Option[]>([]);
  error = signal('');

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

  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    this.loadFacultyOptions();
    this.loadDepartmentOptions();
    if (this.specialtyId) this.loadItems();
  }

  ngOnChanges() {
    if (this.initialized && this.specialtyId) this.loadItems();
  }

  private loadFacultyOptions() {
    const q = `{ faculties { facultyConnection(limit: 1000, offset: 0) { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.faculties.facultyConnection.nodes.map((f: any) => ({ id: f.id, label: f.name }));
        this.facultyOptions.set(opts);
      },
      error: () => {}
    });
  }

  private loadDepartmentOptions() {
    const q = `{ departments { departmentConnection(limit: 1000, offset: 0) { nodes { id name faculty { id } } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const opts: DeptOption[] = d.departments.departmentConnection.nodes.map((dept: any) => ({
          id: dept.id, label: dept.name, facultyId: dept.faculty?.id ?? ''
        }));
        this.departmentOptions.set(opts);
      },
      error: () => {}
    });
  }

  /** Reloads the course list, scoped to the current department/faculty filter (see the fields above). */
  private loadCourseOptions() {
    const deptId = this.courseDepartmentFilter();
    const facultyId = this.courseFacultyFilter();
    const filter = deptId ? `, departmentId: "${deptId}"` : facultyId ? `, facultyId: "${facultyId}"` : '';
    const q = `{ courses { courseConnection(limit: 1000, offset: 0${filter}) { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.courses.courseConnection.nodes.map((c: any) => ({ id: c.id, label: `${c.name} (#${c.id})` }));
        this.courseOptions.set(opts);
      },
      error: () => {}
    });
  }

  onCourseFacultyFilterChange(facultyId: string) {
    this.courseFacultyFilter.set(facultyId);
    this.courseDepartmentFilter.set('');
    this.form['courseId'] = '';
    this.loadCourseOptions();
  }

  onCourseDepartmentFilterChange(deptId: string) {
    this.courseDepartmentFilter.set(deptId);
    this.form['courseId'] = '';
    this.loadCourseOptions();
  }

  private loadItems() {
    if (!this.specialtyId) return;
    const q = `{ curriculumItems { curriculumItemConnection(limit: 500, offset: 0, specialtyId: "${this.specialtyId}") { nodes {
      id semester controlForm ectsCredits
      course { id name faculty { id } department { id faculty { id } } }
      hours { id hourType hours }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.items.set(d.curriculumItems.curriculumItemConnection.nodes),
      error: (e) => this.error.set(e.message)
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
    // Default to the specialty's own faculty, since courses for this curriculum most often
    // belong to it; the user can still clear/change it to browse other faculties.
    this.courseFacultyFilter.set(this.specialtyFacultyId ?? '');
    this.courseDepartmentFilter.set('');
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
    // Falls back to the specialty's own faculty if the course has neither.
    const deptId = item.course?.department?.id ?? '';
    const courseFacultyId = deptId ? (item.course?.department?.faculty?.id ?? '') : (item.course?.faculty?.id ?? '');
    this.courseFacultyFilter.set(courseFacultyId || (this.specialtyFacultyId ?? ''));
    this.courseDepartmentFilter.set(deptId);
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
    if (!this.specialtyId) return;
    const input: Record<string, any> = { specialtyId: this.specialtyId, hours: this.buildHoursInput() };
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
