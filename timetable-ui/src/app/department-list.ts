import { Component, Input, OnChanges, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';

interface Department {
  id: string;
  name: string;
  abbreviation?: string;
  email?: string;
  phone?: string;
  info?: string;
}

@Component({
  selector: 'app-department-list',
  templateUrl: './department-list.html',
  imports: [FormsModule, RouterLink]
})
export class DepartmentList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);

  @Input() facultyId!: string;

  departments = signal<Department[]>([]);
  error = signal('');

  showCreateForm = signal(false);
  createError = signal('');
  createForm: Record<string, any> = {};

  editingDept = signal<Department | null>(null);
  editError = signal('');
  editForm: Record<string, any> = {};

  ngOnInit() { this.load(); }
  ngOnChanges() { this.load(); }

  load() {
    if (!this.facultyId) return;
    const q = `{ departments { departmentConnection(limit: 200, facultyId: "${this.facultyId}") { nodes { id name abbreviation email phone info } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.departments.set(d.departments.departmentConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  // ── Create ────────────────────────────────────────────────────────────────

  openCreate() {
    this.createForm = {};
    this.createError.set('');
    this.showCreateForm.set(true);
  }

  closeCreate() {
    this.showCreateForm.set(false);
    this.createError.set('');
  }

  saveCreate() {
    const input: Record<string, any> = { facultyId: this.facultyId };
    for (const f of ['name', 'abbreviation', 'email', 'phone', 'info']) {
      if (this.createForm[f]) input[f] = this.createForm[f];
    }
    const q = `mutation($input: DepartmentInputPayload!) { departments { createDepartment(department: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { input }).subscribe({
      next: (d: any) => {
        const res = d.departments.createDepartment;
        if (res.isSuccess) { this.closeCreate(); this.load(); }
        else this.createError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.createError.set(e.message)
    });
  }

  // ── Edit ─────────────────────────────────────────────────────────────────

  openEdit(dept: Department) {
    this.editForm = {
      name:         dept.name         ?? '',
      abbreviation: dept.abbreviation ?? '',
      email:        dept.email        ?? '',
      phone:        dept.phone        ?? '',
      info:         dept.info         ?? '',
    };
    this.editError.set('');
    this.editingDept.set(dept);
  }

  closeEdit() {
    this.editingDept.set(null);
    this.editError.set('');
  }

  saveEdit() {
    const dept = this.editingDept();
    if (!dept) return;
    const input: Record<string, any> = { facultyId: this.facultyId };
    for (const f of ['name', 'abbreviation', 'email', 'phone', 'info']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    const q = `mutation($id: ID!, $input: DepartmentInputPayload!) { departments { updateDepartment(id: $id, department: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: dept.id, input }).subscribe({
      next: (d: any) => {
        const res = d.departments.updateDepartment;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }
}
