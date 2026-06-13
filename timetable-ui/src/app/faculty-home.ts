import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { SearchSelect, Option } from './search-select';

interface Faculty {
  id: string;
  name: string;
  abbreviation: string;
  building?: { id?: string; address?: string };
  phone: string;
  email: string;
  website: string;
}

@Component({
  selector: 'app-faculty-home',
  templateUrl: './faculty-home.html',
  imports: [RouterLink, FormsModule, SearchSelect]
})
export class FacultyHome {
  private gql = inject(GraphqlService);
  faculties = signal<Faculty[]>([]);
  error = signal('');

  // Create form
  showForm = signal(false);
  formError = signal('');
  buildingOptions = signal<Option[]>([]);
  form: Record<string, any> = {};

  // Edit form
  editingFaculty = signal<Faculty | null>(null);
  editError = signal('');
  editForm: Record<string, any> = {};

  constructor() {
    this.loadFaculties();
    this.loadBuildings();
  }

  private loadFaculties() {
    const q = `{ faculties { facultyConnection(limit: 100) { nodes { id name abbreviation building { id address } phone email website } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.faculties.set(d.faculties.facultyConnection.nodes),
      error: (e) => this.error.set(e.message)
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

  // ── Create ────────────────────────────────────────────────────────────────

  openCreate() {
    this.form = {};
    this.formError.set('');
    this.showForm.set(true);
  }

  reset() {
    this.showForm.set(false);
    this.form = {};
    this.formError.set('');
  }

  save() {
    const input: Record<string, any> = {};
    for (const f of ['name', 'abbreviation', 'email', 'phone', 'website', 'buildingId']) {
      if (this.form[f]) input[f] = this.form[f];
    }
    const q = `mutation($input: FacultyInputPayload!) { faculties { createFaculty(faculty: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { input }).subscribe({
      next: (d: any) => {
        const res = d.faculties.createFaculty;
        if (res.isSuccess) { this.reset(); this.loadFaculties(); }
        else this.formError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.formError.set(e.message)
    });
  }

  // ── Edit ─────────────────────────────────────────────────────────────────

  openEdit(f: Faculty) {
    this.editForm = {
      name:         f.name           ?? '',
      abbreviation: f.abbreviation   ?? '',
      email:        f.email          ?? '',
      phone:        f.phone          ?? '',
      website:      f.website        ?? '',
      buildingId:   f.building?.id   ?? '',
    };
    this.editError.set('');
    this.editingFaculty.set(f);
  }

  closeEdit() {
    this.editingFaculty.set(null);
    this.editError.set('');
  }

  saveEdit() {
    const f = this.editingFaculty();
    if (!f) return;
    const input: Record<string, any> = {};
    for (const key of ['name', 'abbreviation', 'email', 'phone', 'website', 'buildingId']) {
      if (this.editForm[key] !== undefined && this.editForm[key] !== '') input[key] = this.editForm[key];
    }
    const q = `mutation($id: ID!, $input: FacultyInputPayload!) { faculties { updateFaculty(id: $id, faculty: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: f.id, input }).subscribe({
      next: (d: any) => {
        const res = d.faculties.updateFaculty;
        if (res.isSuccess) { this.closeEdit(); this.loadFaculties(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }
}
