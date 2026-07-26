import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { CurriculumEditor } from './curriculum-editor';
import { CurriculumItemList } from './curriculum-item-list';
import { WorkingCurriculumList } from './working-curriculum-list';
import { AcademicGroupList } from './academic-group-list';
import { SearchSelect } from './search-select';
import { toOptions } from './entities';

type SpecSection = 'info' | 'curriculaEditor' | 'curricula' | 'workingCurricula' | 'academicGroups';

interface Specialty {
  id: string;
  code: string;
  name: string;
  degree: string;
  faculty: { id: string; name: string };
}

const DEGREE_LABELS: Record<string, string> = {
  JUNIOR_BACHELOR:    'Молодший бакалавр',
  BACHELOR:           'Бакалавр',
  MASTER:             'Магістр',
  PHD:                'Доктор філософії',
  DOCTOR_OF_SCIENCE:  'Доктор наук',
};

const SECTIONS: { key: SpecSection; label: string }[] = [
  { key: 'info',            label: '&#x2139; Інформація' },
  { key: 'curriculaEditor', label: '&#x270E; Редагування планів' },
  { key: 'curricula',       label: '&#x1F4CB; Навчальні плани' },
  { key: 'workingCurricula', label: '&#x1F5C2; Робочі навчальні плани' },
  { key: 'academicGroups',  label: '&#x1F393; Академічні групи' },
];

@Component({
  selector: 'app-specialty-page',
  templateUrl: './specialty-page.html',
  imports: [RouterLink, FormsModule, CurriculumEditor, CurriculumItemList, WorkingCurriculumList, AcademicGroupList, SearchSelect]
})
export class SpecialtyDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);

  readonly specialtyId: string = this.route.snapshot.paramMap.get('id')!;
  readonly sections = SECTIONS;
  readonly degreeLabels = DEGREE_LABELS;

  specialty = signal<Specialty | null>(null);
  error = signal('');
  activeSection = signal<SpecSection>('info');

  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};

  readonly DEGREE_OPTIONS = [
    { value: 'JUNIOR_BACHELOR',   label: 'Молодший бакалавр' },
    { value: 'BACHELOR',          label: 'Бакалавр' },
    { value: 'MASTER',            label: 'Магістр' },
    { value: 'PHD',               label: 'Доктор філософії' },
    { value: 'DOCTOR_OF_SCIENCE', label: 'Доктор наук' },
  ];
  readonly DEGREE_SELECT_OPTIONS = toOptions(this.DEGREE_OPTIONS);

  ngOnInit() { this.load(); }

  private load() {
    const q = `{ specialties { specialty(id: "${this.specialtyId}") { id code name degree faculty { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.specialty.set(d.specialties.specialty),
      error: (e) => this.error.set(e.message)
    });
  }

  selectSection(key: SpecSection) { this.activeSection.set(key); }

  openEdit() {
    const s = this.specialty();
    if (!s) return;
    this.editForm = {
      code: s.code ?? '',
      name: s.name ?? '',
      degree: s.degree ?? '',
    };
    this.editError.set('');
    this.showEditForm.set(true);
  }

  closeEdit() { this.showEditForm.set(false); this.editError.set(''); }

  saveEdit() {
    const s = this.specialty();
    if (!s) return;
    const input: Record<string, any> = { facultyId: s.faculty.id };
    for (const f of ['code', 'name', 'degree']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    const q = `mutation($id: ID!, $input: SpecialtyInputPayload!) { specialties { updateSpecialty(id: $id, specialty: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.specialtyId, input }).subscribe({
      next: (d: any) => {
        const res = d.specialties.updateSpecialty;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }
}
