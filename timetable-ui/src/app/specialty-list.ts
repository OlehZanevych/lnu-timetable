import { Component, Input, OnChanges, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
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
  modifiableIds = signal<Set<string>>(new Set());

  showCreateForm = signal(false);
  createError = signal('');
  createForm: Record<string, any> = {};

  editingSpec = signal<Specialty | null>(null);
  editError = signal('');
  editForm: Record<string, any> = {};

  ngOnInit() { this.load(); this.loadPermissions(); }
  ngOnChanges() { this.load(); this.loadPermissions(); }

  canModify(s: Specialty): boolean {
    return this.auth.isAdmin() || this.modifiableIds().has(String(s.id));
  }

  private loadPermissions() {
    if (!this.facultyId) return;
    if (this.auth.isAdmin()) {
      this.canCreate.set(true);
      return;
    }
    this.auth.canModifyIds('FACULTY', [this.facultyId]).subscribe((ids) => this.canCreate.set(ids.has(this.facultyId)));
  }

  load() {
    if (!this.facultyId) return;
    const q = `{ specialties { specialtyConnection(limit: 200, facultyId: "${this.facultyId}") { nodes { id code name degree } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const nodes = d.specialties.specialtyConnection.nodes;
        this.specialties.set(nodes);
        if (!this.auth.isAdmin() && nodes.length) {
          this.auth.canModifyIds('SPECIALTY', nodes.map((n: Specialty) => n.id)).subscribe((ids) => this.modifiableIds.set(ids));
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
