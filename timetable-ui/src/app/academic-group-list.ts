import { Component, Input, OnChanges, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { SearchSelect } from './search-select';
import { STUDY_FORM_OPTIONS, toOptions } from './entities';

interface AcademicGroup {
  id: string;
  name: string;
  courseYear: number;
  studyForm: string;
  studentsCount?: number;
}

@Component({
  selector: 'app-academic-group-list',
  templateUrl: './academic-group-list.html',
  imports: [FormsModule, RouterLink, SearchSelect]
})
export class AcademicGroupList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);
  private auth = inject(AuthService);

  readonly studyFormOptions = toOptions(STUDY_FORM_OPTIONS);

  /** When provided, list is scoped to this specialty and new groups are pre-assigned to it. */
  @Input() specialtyId: string | null = null;

  groups = signal<AcademicGroup[]>([]);
  error = signal('');

  canCreate = signal(false);
  modifiableIds = signal<Set<string>>(new Set());

  showCreateForm = signal(false);
  createError = signal('');
  createForm: Record<string, any> = {};

  editingGroup = signal<AcademicGroup | null>(null);
  editError = signal('');
  editForm: Record<string, any> = {};

  ngOnInit() { this.load(); this.loadPermissions(); }
  ngOnChanges() { this.load(); this.loadPermissions(); }

  studyFormLabel(v: string): string {
    return STUDY_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  canModify(g: AcademicGroup): boolean {
    return this.auth.isAdmin() || this.modifiableIds().has(String(g.id));
  }

  private loadPermissions() {
    if (this.auth.isAdmin()) {
      this.canCreate.set(true);
      return;
    }
    if (this.specialtyId) {
      this.auth.canModifyIds('SPECIALTY', [this.specialtyId]).subscribe((ids) => this.canCreate.set(ids.has(this.specialtyId!)));
    } else {
      this.canCreate.set((this.auth.currentUser()?.permissions?.length ?? 0) > 0);
    }
  }

  load() {
    const filter = this.specialtyId ? `, specialtyId: "${this.specialtyId}"` : '';
    const q = `{ academicGroups { academicGroupConnection(limit: 500${filter}) { nodes { id name courseYear studyForm studentsCount } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const nodes = d.academicGroups.academicGroupConnection.nodes;
        this.groups.set(nodes);
        if (!this.auth.isAdmin() && nodes.length) {
          this.auth.canModifyIds('ACADEMIC_GROUP', nodes.map((n: AcademicGroup) => n.id)).subscribe((ids) => this.modifiableIds.set(ids));
        }
      },
      error: (e) => this.error.set(e.message)
    });
  }

  // ── Create ────────────────────────────────────────────────────────────────

  openCreate() { this.createForm = {}; this.createError.set(''); this.showCreateForm.set(true); }
  closeCreate() { this.showCreateForm.set(false); this.createError.set(''); }

  saveCreate() {
    const input: Record<string, any> = {};
    if (this.specialtyId) input['specialtyId'] = this.specialtyId;
    for (const f of ['name', 'studyForm']) {
      if (this.createForm[f]) input[f] = this.createForm[f];
    }
    for (const f of ['courseYear', 'studentsCount']) {
      if (this.createForm[f]) input[f] = Number(this.createForm[f]);
    }
    const q = `mutation($input: AcademicGroupInputPayload!) { academicGroups { createAcademicGroup(academicGroup: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { input }).subscribe({
      next: (d: any) => {
        const res = d.academicGroups.createAcademicGroup;
        if (res.isSuccess) { this.closeCreate(); this.load(); }
        else this.createError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.createError.set(e.message)
    });
  }

  // ── Edit ─────────────────────────────────────────────────────────────────

  openEdit(g: AcademicGroup) {
    this.editForm = {
      name:          g.name          ?? '',
      courseYear:    g.courseYear    ?? '',
      studyForm:     g.studyForm     ?? '',
      studentsCount: g.studentsCount ?? '',
    };
    this.editError.set('');
    this.editingGroup.set(g);
  }

  closeEdit() { this.editingGroup.set(null); this.editError.set(''); }

  saveEdit() {
    const g = this.editingGroup();
    if (!g) return;
    const input: Record<string, any> = {};
    if (this.specialtyId) input['specialtyId'] = this.specialtyId;
    for (const f of ['name', 'studyForm']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    for (const f of ['courseYear', 'studentsCount']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = Number(this.editForm[f]);
    }
    const q = `mutation($id: ID!, $input: AcademicGroupInputPayload!) { academicGroups { updateAcademicGroup(id: $id, academicGroup: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: g.id, input }).subscribe({
      next: (d: any) => {
        const res = d.academicGroups.updateAcademicGroup;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }
}
