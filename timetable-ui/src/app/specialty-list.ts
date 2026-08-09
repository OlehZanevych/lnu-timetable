import { Component, Input, OnChanges, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { SearchSelect } from './search-select';
import { DEGREE_OPTIONS, toOptions } from './entities';

interface Specialty {
  id: string;
  code: string;
  name: string;
  degree: string;
}

@Component({
  selector: 'app-specialty-list',
  templateUrl: './specialty-list.html',
  imports: [FormsModule, RouterLink, SearchSelect]
})
export class SpecialtyList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);
  private auth = inject(AuthService);

  @Input() facultyId!: string;

  readonly degreeOptions = toOptions(DEGREE_OPTIONS);

  specialties = signal<Specialty[]>([]);
  error = signal('');

  canCreate = signal(false);
  /** This user's access level per row; absent means they cannot touch that row at all. */
  accessById = signal<Map<string, AccessLevel>>(new Map());

  showCreateForm = signal(false);
  createError = signal('');
  createForm: Record<string, any> = {};

  editingSpec = signal<Specialty | null>(null);
  editError = signal('');
  editForm: Record<string, any> = {};

  ngOnInit() { this.load(); this.loadPermissions(); }
  ngOnChanges() { this.load(); this.loadPermissions(); }

  canEdit(s: Specialty): boolean {
    return allows(maxLevel(this.auth.globalLevel(), this.accessById().get(String(s.id))), 'EDIT');
  }

  private loadPermissions() {
    if (!this.facultyId) return;
    if (this.auth.globalLevel() === 'MANAGE') {
      this.canCreate.set(true);
      return;
    }
    // Creating a child needs EDIT on the parent it is attached to — the same rule the server applies.
    this.auth.accessLevel('FACULTY', this.facultyId)
      .subscribe((level) => this.canCreate.set(allows(maxLevel(this.auth.globalLevel(), level), 'EDIT')));
  }

  load() {
    if (!this.facultyId) return;
    const q = `query($facultyId: ID, $limit: Int!) { specialties { specialtyConnection(limit: $limit, facultyId: $facultyId) { nodes { id code name degree } } } }`;
    this.gql.request(q, { facultyId: this.facultyId, limit: 200 }).subscribe({
      next: (d: any) => {
        const nodes = d.specialties.specialtyConnection.nodes;
        this.specialties.set(nodes);
        if (this.auth.globalLevel() !== 'MANAGE' && nodes.length) {
          this.auth.accessLevels('SPECIALTY', nodes.map((n: Specialty) => String(n.id)))
            .subscribe((levels) => this.accessById.set(levels));
        }
      },
      error: (e) => this.error.set(e.message)
    });
  }

  degreeLabel(v: string): string {
    return this.degreeOptions.find((o) => o.id === v)?.label ?? v;
  }

  // ── Create ────────────────────────────────────────────────────────────────

  openCreate() { this.createForm = {}; this.createError.set(''); this.showCreateForm.set(true); }
  closeCreate() { this.showCreateForm.set(false); this.createError.set(''); }

  saveCreate() {
    const input: Record<string, any> = { facultyId: this.facultyId };
    for (const f of ['code', 'name', 'degree']) {
      if (this.createForm[f]) input[f] = this.createForm[f];
    }
    const q = `mutation($input: SpecialtyInputPayload!) { specialties { createSpecialty(specialty: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { input }).subscribe({
      next: (d: any) => {
        const res = d.specialties.createSpecialty;
        if (res.isSuccess) { this.closeCreate(); this.load(); }
        else this.createError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.createError.set(e.message)
    });
  }

  // ── Edit ─────────────────────────────────────────────────────────────────

  openEdit(spec: Specialty) {
    this.editForm = {
      code: spec.code ?? '',
      name: spec.name ?? '',
      degree: spec.degree ?? '',
    };
    this.editError.set('');
    this.editingSpec.set(spec);
  }

  closeEdit() { this.editingSpec.set(null); this.editError.set(''); }

  saveEdit() {
    const spec = this.editingSpec();
    if (!spec) return;
    const input: Record<string, any> = { facultyId: this.facultyId };
    for (const f of ['code', 'name', 'degree']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    const q = `mutation($id: ID!, $input: SpecialtyInputPayload!) { specialties { updateSpecialty(id: $id, specialty: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: spec.id, input }).subscribe({
      next: (d: any) => {
        const res = d.specialties.updateSpecialty;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }
}
