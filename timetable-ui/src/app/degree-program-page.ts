import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { CurriculumEditor } from './curriculum-editor';
import { DegreeProgramSemesterList } from './degree-program-semester-list';
import { CurriculumItemList } from './curriculum-item-list';
import { WorkingCurriculumList } from './working-curriculum-list';
import { WorkingCurriculumView } from './working-curriculum-view';
import { AcademicGroupList } from './academic-group-list';
import { SearchSelect } from './search-select';
import { toOptions } from './entities';
import { sectionNav } from './section-route';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { AccessNeed, anywhereNeed } from './access-need';
import { AccessGate } from './access-gate';

type SpecSection = 'info' | 'semesters' | 'curriculaEditor' | 'curricula'
                 | 'workingCurriculaEditor' | 'workingCurricula' | 'academicGroups';

interface DegreeProgram {
  id: string;
  code: string;
  name: string;
  degree: string;
  /** How long the programme runs, in semesters. Required by the database, so never null here. */
  durationSemesters: number;
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
 *
 * That split is exactly the permission split, so `writes` marks the same two tabs, naming what each
 * maintains: the plans are read by anybody who can open the освітня програма and written by whoever
 * could edit a позиція плану somewhere. The kind rather than the освітня програма, because a робочий
 * план position hangs off a кафедра as well — a завідувач who fills in their own кафедра's hours
 * holds no grant on the програма, and gating the tab on it would have shut them out of their own work.
 */
const SECTIONS: { key: SpecSection; label: string; writes?: string }[] = [
  { key: 'info',                   label: '&#x2139; Інформація' },
  { key: 'semesters',              label: '&#x23F1; Тривалість семестрів', writes: 'DEGREE_PROGRAM_SEMESTER' },
  { key: 'curriculaEditor',        label: '&#x270E; Редагування планів', writes: 'CURRICULUM_ITEM' },
  { key: 'curricula',              label: '&#x1F4CB; Навчальні плани' },
  { key: 'workingCurriculaEditor', label: '&#x270E; Редагування робочих планів', writes: 'WORKING_CURRICULUM_ITEM' },
  { key: 'workingCurricula',       label: '&#x1F5C2; Робочі навчальні плани' },
  { key: 'academicGroups',         label: '&#x1F393; Академічні групи' },
];

/**
 * Which slugs `/degree-program/:id/:section` recognises — see `section-route.ts`. Both editors stay
 * listed even when the reader is not offered them: `sectionNav` opens «Інформація» for a slug it
 * does not know, and a pasted link to an editor should say what access it needs rather than land
 * somewhere else without a word.
 */
const SECTION_KEYS: SpecSection[] = SECTIONS.map((s) => s.key);

@Component({
  selector: 'app-degree-program-page',
  templateUrl: './degree-program-page.html',
  imports: [RouterLink, FormsModule, CurriculumEditor, CurriculumItemList, WorkingCurriculumList,
            WorkingCurriculumView, AcademicGroupList, DegreeProgramSemesterList, SearchSelect, AccessGate]
})
export class DegreeProgramDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);
  private auth = inject(AuthService);

  readonly degreeProgramId: string = this.route.snapshot.paramMap.get('id')!;
  readonly degreeLabels = DEGREE_LABELS;

  /**
   * This account's level on the освітня програма. «Редагувати» and the two editing tabs used to be
   * drawn for everybody who could open the page and left to the service to refuse — which it did,
   * once a план had been filled in and submitted.
   */
  degreeProgramLevel = signal<AccessLevel | null>(null);
  canModifyDegreeProgram = computed(
    () => allows(maxLevel(this.auth.globalLevel(), this.degreeProgramLevel()), 'EDIT'));

  /** The tabs worth offering: an editor nobody may use is a promise the gate behind it breaks. */
  readonly sections = computed(() => SECTIONS.filter((s) => !s.writes || this.auth.canReachType(s.writes)));

  /**
   * The requirement behind one editing tab, as a value the gate resolves — a pasted link to one is
   * answered on the screen rather than by a tab strip that does not mention it.
   *
   * Cached per key, and it has to be: the gate re-asks whenever the need it is bound to changes
   * identity, so a getter building a fresh one on every change-detection pass would never stop.
   */
  private readonly sectionNeeds = new Map<string, AccessNeed>();

  sectionNeed(writes: string): AccessNeed {
    let need = this.sectionNeeds.get(writes);
    if (!need) {
      need = anywhereNeed(writes);
      this.sectionNeeds.set(writes, need);
    }
    return need;
  }

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

  ngOnInit() {
    this.load();
    this.auth.accessLevel('DEGREE_PROGRAM', this.degreeProgramId)
      .subscribe((level) => this.degreeProgramLevel.set(level));
  }

  private load() {
    const q = `query($id: ID!) { degreePrograms { degreeProgram(id: $id) { id code name degree durationSemesters faculty { id name } } } }`;
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
      durationSemesters: s.durationSemesters ?? '',
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
    // Required by the input payload, because the column is NOT NULL: a programme has a length, and
    // there is no value the system could pick for it. Refused here rather than sent as a null the
    // service would reject with a status naming a foreign key.
    const duration = Number(this.editForm['durationSemesters']);
    if (!Number.isInteger(duration) || duration <= 0) {
      this.editError.set('«Тривалість навчання»: ціле число семестрів, більше за нуль.');
      return;
    }
    input['durationSemesters'] = duration;
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
