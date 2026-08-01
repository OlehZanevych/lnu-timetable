import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { LecturerPage } from './entity-pages';
import { DepartmentWorkloadSummary } from './department-workload-summary';
import { LecturerConstraintList } from './lecturer-constraint-list';
import { LecturerWorkloadDetail } from './lecturer-workload-detail';
import { LecturerWorkloadList } from './lecturer-workload-list';
import { CombinedWorkingCurriculumItemList } from './combined-working-curriculum-item-list';

type DeptSection = 'info' | 'lecturers' | 'combinedItems' | 'constraints' | 'workloads'
  | 'workloadSummary' | 'workloadDetail';

interface Department {
  id: string;
  name: string;
  abbreviation?: string;
  email?: string;
  phone?: string;
  faculty: { id: string; name: string };
}

@Component({
  selector: 'app-department-page',
  templateUrl: './department-page.html',
  imports: [RouterLink, FormsModule, LecturerPage, LecturerConstraintList, LecturerWorkloadList,
            DepartmentWorkloadSummary, LecturerWorkloadDetail, CombinedWorkingCurriculumItemList]
})
export class DepartmentDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);

  readonly departmentId: string = this.route.snapshot.paramMap.get('id')!;

  department = signal<Department | null>(null);
  error = signal('');
  activeSection = signal<DeptSection>('info');

  /** Set when a lecturer is picked in the summary, so the assessment opens on them. */
  focusLecturerId = signal('');

  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};

  ngOnInit() { this.load(); }

  private load() {
    const q = `{ departments { department(id: "${this.departmentId}") { id name abbreviation email phone faculty { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.department.set(d.departments.department),
      error: (e) => this.error.set(e.message)
    });
  }

  get deptPreset(): Record<string, string> { return { departmentId: this.departmentId }; }

  /** Summary row -> assessment: the natural next question after "who is overloaded?" is "why?". */
  openAssessment(lecturerId: string) {
    this.focusLecturerId.set(lecturerId);
    this.activeSection.set('workloadDetail');
  }

  openEdit() {
    const d = this.department();
    if (!d) return;
    this.editForm = {
      name:         d.name         ?? '',
      abbreviation: d.abbreviation ?? '',
      email:        d.email        ?? '',
      phone:        d.phone        ?? '',
    };
    this.editError.set('');
    this.showEditForm.set(true);
  }

  closeEdit() {
    this.showEditForm.set(false);
    this.editError.set('');
  }

  saveEdit() {
    const dept = this.department();
    if (!dept) return;
    // facultyId must be included in update payload (required field)
    const input: Record<string, any> = { facultyId: dept.faculty.id };
    for (const f of ['name', 'abbreviation', 'email', 'phone']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    const q = `mutation($id: ID!, $input: DepartmentInputPayload!) { departments { updateDepartment(id: $id, department: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.departmentId, input }).subscribe({
      next: (d: any) => {
        const res = d.departments.updateDepartment;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }
}
