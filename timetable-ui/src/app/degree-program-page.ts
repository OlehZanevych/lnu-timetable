import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { CurriculumEditor } from './curriculum-editor';
import { CurriculumItemList } from './curriculum-item-list';
import { WorkingCurriculumList } from './working-curriculum-list';
import { WorkingCurriculumView } from './working-curriculum-view';
import { AcademicGroupList } from './academic-group-list';
import { SearchSelect } from './search-select';
import { toOptions } from './entities';
import { sectionNav } from './section-route';

type SpecSection = 'info' | 'curriculaEditor' | 'curricula'
                 | 'workingCurriculaEditor' | 'workingCurricula' | 'academicGroups';

interface DegreeProgram {
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

/**
 * Both plans are edited on one tab and read on another: the editors are shaped for entering data
 * (course-first blocks; a кафедра per block of hours), the two plain-named tabs for reading the
 * document and printing it. Editing tabs therefore carry the «Редагування…» prefix and the
 * documents keep the names people use for them.
 */
const SECTIONS: { key: SpecSection; label: string }[] = [
  { key: 'info',                   label: '&#x2139; Інформація' },
  { key: 'curriculaEditor',        label: '&#x270E; Редагування планів' },
  { key: 'curricula',              label: '&#x1F4CB; Навчальні плани' },
  { key: 'workingCurriculaEditor', label: '&#x270E; Редагування робочих планів' },
  { key: 'workingCurricula',       label: '&#x1F5C2; Робочі навчальні плани' },
  { key: 'academicGroups',         label: '&#x1F393; Академічні групи' },
];

/** Which slugs `/degree-program/:id/:section` recognises — see `section-route.ts`. */
const SECTION_KEYS: SpecSection[] = SECTIONS.map((s) => s.key);

@Component({
  selector: 'app-degree-program-page',
  templateUrl: './degree-program-page.html',
  imports: [RouterLink, FormsModule, CurriculumEditor, CurriculumItemList, WorkingCurriculumList,
            WorkingCurriculumView, AcademicGroupList, SearchSelect]
})
export class DegreeProgramDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);

  readonly degreeProgramId: string = this.route.snapshot.paramMap.get('id')!;
  readonly sections = SECTIONS;
  readonly degreeLabels = DEGREE_LABELS;

  degreeProgram = signal<DegreeProgram | null>(null);
  error = signal('');

  /** The open tab, and the last segment of the URL — see `section-route.ts`. */
  private nav = sectionNav<SpecSection>(
    () => ['/degree-program', this.degreeProgramId], () => SECTION_KEYS, () => 'info');
  readonly activeSection = this.nav.active;

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
    const q = `query($id: ID!) { degreePrograms { degreeProgram(id: $id) { id code name degree faculty { id name } } } }`;
    this.gql.request(q, { id: this.degreeProgramId }).subscribe({
      next: (d: any) => this.degreeProgram.set(d.degreePrograms.degreeProgram),
      error: (e) => this.error.set(e.message)
    });
  }

  selectSection(key: SpecSection) { this.nav.select(key); }

  openEdit() {
    const s = this.degreeProgram();
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
    const s = this.degreeProgram();
    if (!s) return;
    const input: Record<string, any> = { facultyId: s.faculty.id };
    for (const f of ['code', 'name', 'degree']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    const q = `mutation($id: ID!, $input: DegreeProgramInputPayload!) { degreePrograms { updateDegreeProgram(id: $id, degreeProgram: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.degreeProgramId, input }).subscribe({
      next: (d: any) => {
        const res = d.degreePrograms.updateDegreeProgram;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }
}
