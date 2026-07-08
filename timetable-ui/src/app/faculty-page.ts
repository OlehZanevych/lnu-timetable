import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { SearchSelect, Option } from './search-select';
import { DepartmentList } from './department-list';
import { SpecialtyList } from './specialty-list';
import { AcademicGroupList } from './academic-group-list';
import {
  RoomPage,
  CoursePage, CurriculumItemPage, CurriculumItemHoursPage, WorkingCurriculumItemPage,
  LecturerWorkloadPage, StudentPage, CombinedGroupPage
} from './entity-pages';

export type FacultySection =
  | 'info'
  | 'departments' | 'specialties' | 'rooms'
  | 'courses' | 'curriculumItems' | 'curriculumItemHours' | 'workingCurriculumItems'
  | 'workloads' | 'students' | 'academicGroups' | 'combinedGroups';

interface SectionDef { key: FacultySection; label: string; group: string; }

interface RefOption { id: string; name: string; }

interface Faculty {
  id: string;
  name: string;
  abbreviation: string;
  phone: string;
  email: string;
  website: string;
  info: string;
  building?: { id: string; name: string; address?: string };
}

const SECTIONS: SectionDef[] = [
  { key: 'info',                   label: 'Інформація',           group: 'Факультет' },
  { key: 'departments',            label: 'Кафедри',              group: 'Структура' },
  { key: 'specialties',            label: 'Спеціальності',        group: 'Структура' },
  { key: 'rooms',                  label: 'Аудиторії',            group: 'Структура' },
  { key: 'students',               label: 'Студенти',             group: 'Люди та групи' },
  { key: 'academicGroups',         label: 'Академічні групи',     group: 'Люди та групи' },
  { key: 'combinedGroups',         label: "Об'єднані групи",      group: 'Люди та групи' },
  { key: 'courses',                label: 'Дисципліни',           group: 'Навчальні плани' },
  { key: 'curriculumItems',        label: 'Позиції навч. плану',  group: 'Навчальні плани' },
  { key: 'curriculumItemHours',    label: 'Год. позиції',         group: 'Навчальні плани' },
  { key: 'workingCurriculumItems', label: 'Позиції РНП',          group: 'Навчальні плани' },
  { key: 'workloads',              label: 'Навантаження',         group: 'Розклад' },
];

@Component({
  selector: 'app-faculty-page',
  templateUrl: './faculty-page.html',
  imports: [
    RouterLink, FormsModule, SearchSelect,
    DepartmentList, SpecialtyList, AcademicGroupList,
    RoomPage,
    CoursePage, CurriculumItemPage, CurriculumItemHoursPage, WorkingCurriculumItemPage,
    LecturerWorkloadPage, StudentPage, CombinedGroupPage
  ]
})
export class FacultyPage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private gql = inject(GraphqlService);

  readonly facultyId: string = this.route.snapshot.paramMap.get('id')!;

  faculty = signal<Faculty | null>(null);
  error = signal('');
  activeSection = signal<FacultySection>('info');

  specs = signal<RefOption[]>([]);
  selectedSpecId = '';
  depts = signal<RefOption[]>([]);
  selectedDeptId = '';

  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};
  buildingOptions = signal<Option[]>([]);

  showDeleteConfirm = signal(false);
  deleteError = signal('');

  readonly sections = SECTIONS;
  readonly sectionGroups: string[];

  constructor() {
    this.sectionGroups = [...new Set(SECTIONS.map((s) => s.group))];
  }

  ngOnInit() {
    this.loadFaculty();
    this.loadDepts();
    this.loadSpecs();
    this.loadBuildings();
  }

  sectionsForGroup(group: string): SectionDef[] {
    return SECTIONS.filter((s) => s.group === group);
  }

  selectSection(key: FacultySection) {
    this.activeSection.set(key);
    this.selectedDeptId = '';
    this.selectedSpecId = '';
  }

  get facultyPreset(): Record<string, string> { return { facultyId: this.facultyId }; }
  get deptFilterValue(): string | null { return this.selectedDeptId || null; }
  get deptPreset(): Record<string, string> {
    return this.selectedDeptId ? { departmentId: this.selectedDeptId } : {};
  }
  get specFilterValue(): string | null { return this.selectedSpecId || null; }
  get specPreset(): Record<string, string> {
    return this.selectedSpecId ? { specialtyId: this.selectedSpecId } : {};
  }

  private loadFaculty() {
    const q = `{ faculties { faculty(id: "${this.facultyId}") { id name abbreviation phone email website info building { id name address } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.faculty.set(d.faculties.faculty),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadDepts() {
    const q = `{ departments { departmentConnection(limit: 200, facultyId: "${this.facultyId}") { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.depts.set(d.departments.departmentConnection.nodes)
    });
  }

  private loadSpecs() {
    const q = `{ specialties { specialtyConnection(limit: 200, facultyId: "${this.facultyId}") { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.specs.set(d.specialties.specialtyConnection.nodes)
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
      website: f.website ?? '', info: f.info ?? '',
      buildingId: f.building?.id ?? '',
    };
    this.editError.set('');
    this.showEditForm.set(true);
  }

  closeEdit() { this.showEditForm.set(false); this.editError.set(''); }

  saveEdit() {
    const input: Record<string, any> = {};
    for (const f of ['name', 'abbreviation', 'email', 'phone', 'website', 'info', 'buildingId']) {
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
