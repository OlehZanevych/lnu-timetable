import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { HOUR_TYPE_OPTIONS, POSITION_OPTIONS, TEACHING_FORMAT_OPTIONS, positionLabel,
         termLabelShort, toOptions } from './entities';
import { fmtNumber } from './curriculum-plan';
import { HOUR_TYPE_SHORT } from './timetable-grid';
import { TimetableView } from './timetable-view';
import { SearchSelect, Option } from './search-select';
import { DeptFacultySelect, DeptOption } from './dept-faculty-select';
import { compareUk } from './sort';
import { courseLabel } from './course-label';

type LecturerSection = 'info' | 'classes' | 'timetable';

interface LecturerInfo {
  id: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  email?: string;
  position?: string;
  academicDegree?: { id: string; name: string } | null;
  department?: { id: string; name: string; faculty?: { id: string; name: string } | null } | null;
}

/** One `lecturer_workloads` row this lecturer carries, flattened for the table. */
interface ClassRow {
  id: string;
  /** Bare `courses.name` — what the «Дисциплін» tally counts distinct values of, and sorts by. */
  courseName: string;
  /** `courses.id` behind {@link ClassRow.courseLabel} — what the table links each line to. */
  courseId: string;
  /** {@link ClassRow.courseName} with the course's tags in parentheses — what the table prints. */
  courseLabel: string;
  hourType: string;
  hours: number;
  semester: number;
  specialtyName: string;
  departmentName: string;
  teachingFormat: string;
  lecturerCount: number;
  groupNames: string;
  durationHours: number;
  scheduledClasses: number;
  /** True when the workload hangs off a combined item — one workload covering several plans. */
  combined: boolean;
}

/**
 * One lecturer: who they are, what they teach, and when.
 *
 * The department pages already answer «how loaded is everyone?» and «who should take this?»; this
 * page answers the question a lecturer themselves asks — what am I carrying, and where do I have to
 * be. The «Заняття» tab lists the workloads they hold, and «Розклад» renders the same grid the
 * faculty publishes, scoped to them.
 *
 * The info tab also edits and deletes the lecturer, exactly as `FacultyPage` does for a faculty: a
 * modal over the entity's own fields and a confirmation before `deleteLecturer`, both hidden unless
 * `canModifyIds('LECTURER', …)` says this account may — see the README's *Hiding UI the user can't
 * use*.
 */
@Component({
  selector: 'app-lecturer-page',
  templateUrl: './lecturer-page.html',
  imports: [RouterLink, FormsModule, SearchSelect, DeptFacultySelect, TimetableView]
})
export class LecturerDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private gql = inject(GraphqlService);
  auth = inject(AuthService);

  readonly lecturerId: string = this.route.snapshot.paramMap.get('id')!;
  readonly positionLabel = positionLabel;
  readonly termLabelShort = termLabelShort;
  readonly fmtNumber = fmtNumber;
  readonly positionOptions = toOptions(POSITION_OPTIONS);

  readonly sections: { key: LecturerSection; label: string }[] = [
    { key: 'info',      label: '&#x2139; Інформація' },
    { key: 'classes',   label: '&#x1F4DA; Дисципліни та заняття' },
    { key: 'timetable', label: '&#x1F4C5; Розклад' }
  ];

  lecturer = signal<LecturerInfo | null>(null);
  classes = signal<ClassRow[]>([]);
  error = signal('');
  loading = signal(false);
  activeSection = signal<LecturerSection>('info');

  /** Whether the current user may edit/delete this Lecturer — see AuthService#canModifyIds. */
  canModifyLecturer = signal(false);

  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};

  showDeleteConfirm = signal(false);
  deleteError = signal('');

  degreeOptions = signal<Option[]>([]);
  departmentOptions = signal<DeptOption[]>([]);
  facultyOptions = signal<Option[]>([]);

  /** Ids for the timetable view; an array so the shared component's filter shape fits. */
  readonly lecturerIds = computed(() => [this.lecturerId]);

  fullName = computed(() => {
    const l = this.lecturer();
    if (!l) return '';
    return [l.lastName, l.firstName, l.middleName].map((p) => (p ?? '').trim()).filter(Boolean).join(' ');
  });

  summary = computed(() => {
    const rows = this.classes();
    const courses = new Set(rows.map((r) => r.courseName).filter(Boolean));
    const groups = new Set(rows.flatMap((r) => r.groupNames.split(', ').filter(Boolean)));
    return {
      workloads: rows.length,
      // Counted the way the constraints count them: teaching work makes a discipline "taught".
      courses: new Set(rows.filter((r) => ['LECTURE', 'PRACTICAL', 'LAB'].includes(r.hourType))
        .map((r) => r.courseName)).size,
      allCourses: courses.size,
      groups: groups.size,
      hours: rows.reduce((sum, r) => sum + r.hours, 0),
      scheduled: rows.reduce((sum, r) => sum + r.scheduledClasses, 0)
    };
  });

  ngOnInit() {
    this.load();
    this.loadDegrees();
    this.loadDepartments();
    this.loadFaculties();
    if (this.auth.isAdmin()) {
      this.canModifyLecturer.set(true);
    } else {
      this.auth.canModifyIds('LECTURER', [this.lecturerId])
        .subscribe((ids) => this.canModifyLecturer.set(ids.has(this.lecturerId)));
    }
  }

  selectSection(key: LecturerSection) { this.activeSection.set(key); }

  hourTypeLabel(v: string): string {
    return HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  hourTypeShort(v: string): string { return HOUR_TYPE_SHORT[v] ?? this.hourTypeLabel(v); }

  teachingFormatLabel(v: string): string {
    return TEACHING_FORMAT_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  private load() {
    this.loading.set(true);
    const q = `{ lecturers { lecturer(id: "${this.lecturerId}") {
      id firstName middleName lastName email position
      academicDegree { id name }
      department { id name faculty { id name } }
      workloads {
        id durationHours
        academicGroups { id name }
        combinedGroups { name academicGroups { id name } }
        timetableEntries { id }
        workingCurriculumItem {
          lecturerCount teachingFormat
          course { id name tags { tag } }
          department { id name }
          curriculumItemHours { hourType hours curriculumItem { semester course { id name courseType tags { tag } } specialty { id name } } }
        }
        combinedWorkingCurriculumItem {
          workingCurriculumItems {
            lecturerCount teachingFormat
            course { id name tags { tag } }
            department { id name }
            curriculumItemHours { hourType hours curriculumItem { semester course { id name courseType tags { tag } } specialty { id name } } }
          }
        }
      }
    } } }`;

    this.gql.request(q).subscribe({
      next: (d: any) => {
        const l = d.lecturers.lecturer;
        this.lecturer.set(l);
        this.classes.set(this.toClassRows(l?.workloads ?? []));
        this.loading.set(false);
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }

  /**
   * A workload points either at one working curriculum item or at a combined one bundling several.
   * The row names the discipline behind it — the elective actually taught when the curriculum item's
   * course is only an umbrella `ELECTIVE_GROUP`.
   */
  private toClassRows(workloads: any[]): ClassRow[] {
    const rows: ClassRow[] = [];
    for (const w of workloads) {
      const combined = !!w.combinedWorkingCurriculumItem;
      const ref = w.workingCurriculumItem
        ?? w.combinedWorkingCurriculumItem?.workingCurriculumItems?.[0]
        ?? null;
      const ci = ref?.curriculumItemHours?.curriculumItem;
      const umbrella = ci?.course;
      const groups = new Map<string, string>();
      for (const g of w.academicGroups ?? []) groups.set(g.id, g.name);
      for (const cg of w.combinedGroups ?? []) {
        for (const g of cg.academicGroups ?? []) groups.set(g.id, g.name);
      }
      rows.push({
        id: w.id,
        courseName: umbrella?.courseType === 'ELECTIVE_GROUP' && ref?.course
          ? ref.course.name
          : (umbrella?.name ?? '—'),
        courseLabel: umbrella?.courseType === 'ELECTIVE_GROUP' && ref?.course
          ? courseLabel(ref.course.name, ref.course.tags)
          : courseLabel(umbrella?.name, umbrella?.tags),
        // The same elective-vs-umbrella choice as the label: the row links to the discipline it
        // names, not to the block it was chosen out of.
        courseId: umbrella?.courseType === 'ELECTIVE_GROUP' && ref?.course
          ? String(ref.course.id)
          : String(umbrella?.id ?? ''),
        hourType: ref?.curriculumItemHours?.hourType ?? '',
        hours: ref?.curriculumItemHours?.hours ?? 0,
        semester: ci?.semester ?? 0,
        specialtyName: ci?.specialty?.name ?? '',
        departmentName: ref?.department?.name ?? '',
        teachingFormat: ref?.teachingFormat ?? '',
        lecturerCount: ref?.lecturerCount ?? 1,
        groupNames: [...groups.values()].sort(compareUk).join(', '),
        durationHours: w.durationHours ?? 0,
        scheduledClasses: (w.timetableEntries ?? []).length,
        combined
      });
    }
    return rows.sort((a, b) => a.semester - b.semester
      || compareUk(a.courseName, b.courseName)
      || compareUk(a.hourType, b.hourType));
  }

  // ── Option lists for the edit form ────────────────────────────────────────

  private loadDegrees() {
    const q = `{ academicDegrees { academicDegreeConnection(limit: 200) { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.degreeOptions.set(
        d.academicDegrees.academicDegreeConnection.nodes.map((x: any) => ({ id: x.id, label: x.name }))),
      error: () => {}
    });
  }

  /** Departments carry their faculty so `DeptFacultySelect` can narrow them — see that component. */
  private loadDepartments() {
    const q = `{ departments { departmentConnection(limit: 1000) { nodes { id name faculty { id name } } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.departmentOptions.set(
        d.departments.departmentConnection.nodes.map((x: any) => ({
          id: x.id, label: x.name, facultyId: x.faculty?.id ?? ''
        }))),
      error: () => {}
    });
  }

  private loadFaculties() {
    const q = `{ faculties { facultyConnection(limit: 200) { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.facultyOptions.set(
        d.faculties.facultyConnection.nodes.map((f: any) => ({ id: f.id, label: f.name }))),
      error: () => {}
    });
  }

  // ── Edit ──────────────────────────────────────────────────────────────────

  openEdit() {
    const l = this.lecturer();
    if (!l) return;
    this.editForm = {
      lastName: l.lastName ?? '',
      firstName: l.firstName ?? '',
      middleName: l.middleName ?? '',
      email: l.email ?? '',
      position: l.position ?? '',
      academicDegreeId: l.academicDegree?.id ?? '',
      departmentId: l.department?.id ?? '',
    };
    this.editError.set('');
    this.showEditForm.set(true);
  }

  closeEdit() { this.showEditForm.set(false); this.editError.set(''); }

  /**
   * Sends an explicit `null` for a cleared optional field, as `BaseEntity#buildInput` does, so
   * emptying a box actually clears the column. The two required fields and the department are
   * simply omitted when empty rather than nulled, since the column will not take a null.
   *
   * Neither `workloadConstraints` nor `timetableConstraints` is in the payload, deliberately: a
   * nested list absent from an update leaves its rows untouched (see `reconcileNestedLists` on the
   * service), so this form cannot wipe the ceilings «Обмеження навантаження» and the rules
   * «Обмеження розкладу» own.
   */
  saveEdit() {
    const required = new Set(['firstName', 'lastName', 'departmentId']);
    const input: Record<string, any> = {};
    for (const f of ['firstName', 'middleName', 'lastName', 'email', 'position', 'academicDegreeId', 'departmentId']) {
      const v = this.editForm[f];
      if (v === undefined || v === null || v === '') {
        if (!required.has(f)) input[f] = null;
        continue;
      }
      input[f] = v;
    }
    const q = `mutation($id: ID!, $input: LecturerInputPayload!) { lecturers { updateLecturer(id: $id, lecturer: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.lecturerId, input }).subscribe({
      next: (d: any) => {
        const res = d.lecturers.updateLecturer;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  openDelete() { this.deleteError.set(''); this.showDeleteConfirm.set(true); }
  closeDelete() { this.showDeleteConfirm.set(false); this.deleteError.set(''); }

  confirmDelete() {
    const dept = this.lecturer()?.department;
    const back = dept ? ['/department', dept.id] : ['/e/lecturer'];
    const q = `mutation($id: ID!) { lecturers { deleteLecturer(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.lecturerId }).subscribe({
      next: (d: any) => {
        const res = d.lecturers.deleteLecturer;
        if (res.isSuccess) this.router.navigate(back);
        else this.deleteError.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.deleteError.set(e.message)
    });
  }
}
