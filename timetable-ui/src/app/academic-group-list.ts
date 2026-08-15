import { Component, Input, OnChanges, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GqlVars, GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
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

  /** When provided, list is scoped to this degreeProgram and new groups are pre-assigned to it. */
  @Input() degreeProgramId: string | null = null;

  /**
   * When provided, list is scoped to the groups of this faculty's degreePrograms. Combines with
   * degreeProgramId: the faculty page passes both, so clearing its degreeProgram sub-filter narrows to
   * "every group of this faculty" rather than widening to every group in the university.
   */
  @Input() facultyId: string | null = null;

  groups = signal<AcademicGroup[]>([]);
  error = signal('');

  canCreate = signal(false);
  /** This user's access level per row; absent means they cannot touch that row at all. */
  accessById = signal<Map<string, AccessLevel>>(new Map());

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

  canEdit(g: AcademicGroup): boolean {
    return allows(maxLevel(this.auth.globalLevel(), this.accessById().get(String(g.id))), 'EDIT');
  }

  private loadPermissions() {
    if (this.auth.globalLevel() === 'MANAGE') {
      this.canCreate.set(true);
      return;
    }
    if (this.degreeProgramId) {
      // Creating a child needs EDIT on the parent it is attached to — the same rule the server applies.
      this.auth.accessLevel('DEGREE_PROGRAM', this.degreeProgramId!)
        .subscribe((level) => this.canCreate.set(allows(maxLevel(this.auth.globalLevel(), level), 'EDIT')));
    } else if (this.facultyId) {
      // No degreeProgram picked, so a new group has nothing to attach to — creating is only offered
      // once the sub-filter narrows to one degreeProgram (see the degreeProgramId branch above).
      this.canCreate.set(false);
    } else {
      this.canCreate.set((this.auth.currentUser()?.permissions?.length ?? 0) > 0);
    }
  }

  load() {
    const v = new GqlVars();
    const args = [
      v.arg('limit', 'Int!', 500),
      v.optionalArg('degreeProgramId', 'ID', this.degreeProgramId),
      v.optionalArg('facultyId', 'ID', this.facultyId)
    ].filter(Boolean).join(', ');
    const q = `${v.declaration()}{ academicGroups { academicGroupConnection(${args}) { nodes { id name courseYear studyForm studentsCount } } } }`;
    this.gql.request(q, v.values).subscribe({
      next: (d: any) => {
        const nodes = d.academicGroups.academicGroupConnection.nodes;
        this.groups.set(nodes);
        if (this.auth.globalLevel() !== 'MANAGE' && nodes.length) {
          this.auth.accessLevels('ACADEMIC_GROUP', nodes.map((n: AcademicGroup) => String(n.id)))
            .subscribe((levels) => this.accessById.set(levels));
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
    if (this.degreeProgramId) input['degreeProgramId'] = this.degreeProgramId;
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
    if (this.degreeProgramId) input['degreeProgramId'] = this.degreeProgramId;
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
