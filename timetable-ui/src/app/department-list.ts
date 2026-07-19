import { Component, Input, OnChanges, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';

interface Department {
  id: string;
  name: string;
  abbreviation?: string;
  email?: string;
  phone?: string;
}

@Component({
  selector: 'app-department-list',
  templateUrl: './department-list.html',
  imports: [FormsModule, RouterLink]
})
export class DepartmentList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);
  private auth = inject(AuthService);

  @Input() facultyId!: string;

  departments = signal<Department[]>([]);
  error = signal('');

  /** Can the user create a Department under this Faculty? (creating a child requires modify
   *  permission on the parent — see PermissionService#canCreate on the backend.) */
  canCreate = signal(false);
  /** Departments (by id) the user may edit. */
  modifiableIds = signal<Set<string>>(new Set());

  showCreateForm = signal(false);
  createError = signal('');
  createForm: Record<string, any> = {};

  editingDept = signal<Department | null>(null);
  editError = signal('');
  editForm: Record<string, any> = {};

  ngOnInit() { this.load(); this.loadPermissions(); }
  ngOnChanges() { this.load(); this.loadPermissions(); }

  canModify(d: Department): boolean {
    return this.auth.isAdmin() || this.modifiableIds().has(String(d.id));
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
    const q = `{ departments { departmentConnection(limit: 200, facultyId: "${this.facultyId}") { nodes { id name abbreviation email phone } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const nodes = d.departments.departmentConnection.nodes;
        this.departments.set(nodes);
        if (!this.auth.isAdmin() && nodes.length) {
          this.auth.canModifyIds('DEPARTMENT', nodes.map((n: Department) => n.id)).subscribe((ids) => this.modifiableIds.set(ids));
        }
      },
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
    for (const f of ['name', 'abbreviation', 'email', 'phone']) {
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
    for (const f of ['name', 'abbreviation', 'email', 'phone']) {
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
