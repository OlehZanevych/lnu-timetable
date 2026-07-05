import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { StudentPage } from './entity-pages';

type GroupSection = 'info' | 'students';

interface AcademicGroup {
  id: string;
  name: string;
  courseYear: number;
  studyForm: string;
  studentsCount?: number;
  specialty: { id: string; name: string; faculty: { id: string; name: string } };
}

@Component({
  selector: 'app-academic-group-page',
  templateUrl: './academic-group-page.html',
  imports: [RouterLink, FormsModule, StudentPage]
})
export class AcademicGroupDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);

  readonly groupId: string = this.route.snapshot.paramMap.get('id')!;

  group = signal<AcademicGroup | null>(null);
  error = signal('');
  activeSection = signal<GroupSection>('info');

  /** Pre-fills academicGroupId when creating a student. */
  readonly groupPreset: Record<string, string>;

  /**
   * Scopes the academicGroup options when editing a student to only groups
   * within the same specialty. Set once the group data loads.
   */
  studentRefFilters: Record<string, string> = {};

  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};

  constructor() {
    this.groupPreset = { academicGroupId: this.groupId };
  }

  ngOnInit() { this.load(); }

  private load() {
    const q = `{ academicGroups { academicGroup(id: "${this.groupId}") { id name courseYear studyForm studentsCount specialty { id name faculty { id name } } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const g = d.academicGroups.academicGroup;
        this.group.set(g);
        if (g?.specialty?.id) {
          this.studentRefFilters = { academicGroupId: g.specialty.id };
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
    const input: Record<string, any> = { specialtyId: g.specialty.id };
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
