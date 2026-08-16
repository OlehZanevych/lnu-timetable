import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { StudentPage } from './entity-pages';
import { SearchSelect } from './search-select';
import { STUDY_FORM_OPTIONS, toOptions } from './entities';
import { sectionNav } from './section-route';

type GroupSection = 'info' | 'students';

/** Which slugs `/academic-group/:id/:section` recognises — see `section-route.ts`. */
const SECTION_KEYS: GroupSection[] = ['info', 'students'];

interface AcademicGroup {
  id: string;
  name: string;
  courseYear: number;
  studyForm: string;
  studentsCount?: number;
  degreeProgram: { id: string; name: string; faculty: { id: string; name: string } };
}

@Component({
  selector: 'app-academic-group-page',
  templateUrl: './academic-group-page.html',
  imports: [RouterLink, FormsModule, StudentPage, SearchSelect]
})
export class AcademicGroupDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);
  auth = inject(AuthService);

  readonly groupId: string = this.route.snapshot.paramMap.get('id')!;
  readonly studyFormOptions = toOptions(STUDY_FORM_OPTIONS);

  group = signal<AcademicGroup | null>(null);
  error = signal('');

  /** The open tab, and the last segment of the URL — see `section-route.ts`. */
  private nav = sectionNav<GroupSection>(
    () => ['/academic-group', this.groupId], () => SECTION_KEYS, () => 'info');
  readonly activeSection = this.nav.active;

  /**
   * This user's level on this академічна група, which «Редагувати» is worth drawing only at EDIT and
   * above — the same expression `AcademicGroupList#canEdit` gates the very same `updateAcademicGroup`
   * with, so the row in the table and the page it opens never disagree. Deleting a group is not
   * offered here, so no FULL question arises. The «Студенти» tab asks its own, inside `<app-student>`.
   */
  groupLevel = signal<AccessLevel | null>(null);
  canModifyGroup = computed(() => allows(maxLevel(this.auth.globalLevel(), this.groupLevel()), 'EDIT'));

  selectSection(key: GroupSection) { this.nav.select(key); }

  /** Pre-fills academicGroupId when creating a student. */
  readonly groupPreset: Record<string, string>;

  /**
   * Scopes the academicGroup options when editing a student to only groups
   * within the same degreeProgram. Set once the group data loads.
   */
  studentRefFilters: Record<string, string> = {};

  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};

  constructor() {
    this.groupPreset = { academicGroupId: this.groupId };
  }

  ngOnInit() {
    this.load();
    this.auth.accessLevel('ACADEMIC_GROUP', this.groupId).subscribe((level) => this.groupLevel.set(level));
  }

  studyFormLabel(v: string): string {
    return STUDY_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  private load() {
    const q = `query($id: ID!) { academicGroups { academicGroup(id: $id) { id name courseYear studyForm studentsCount degreeProgram { id name faculty { id name } } } } }`;
    this.gql.request(q, { id: this.groupId }).subscribe({
      next: (d: any) => {
        const g = d.academicGroups.academicGroup;
        this.group.set(g);
        if (g?.degreeProgram?.id) {
          this.studentRefFilters = { academicGroupId: g.degreeProgram.id };
        }
      },
      error: (e) => this.error.set(e.message)
    });
  }

  openEdit() {
    const g = this.group();
    if (!g) return;
    this.editForm = {
      name:          g.name          ?? '',
      courseYear:    g.courseYear    ?? '',
      studyForm:     g.studyForm     ?? '',
      studentsCount: g.studentsCount ?? '',
    };
    this.editError.set('');
    this.showEditForm.set(true);
  }

  closeEdit() { this.showEditForm.set(false); this.editError.set(''); }

  saveEdit() {
    const g = this.group();
    if (!g) return;
    const input: Record<string, any> = { degreeProgramId: g.degreeProgram.id };
    for (const f of ['name', 'studyForm']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    for (const f of ['courseYear', 'studentsCount']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = Number(this.editForm[f]);
    }
    const q = `mutation($id: ID!, $input: AcademicGroupInputPayload!) { academicGroups { updateAcademicGroup(id: $id, academicGroup: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.groupId, input }).subscribe({
      next: (d: any) => {
        const res = d.academicGroups.updateAcademicGroup;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }
}
