import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { HOUR_TYPE_OPTIONS, TEACHING_FORMAT_OPTIONS, positionLabel, termLabelShort } from './entities';
import { fmtNumber } from './curriculum-plan';
import { HOUR_TYPE_SHORT } from './timetable-grid';
import { TimetableView } from './timetable-view';
import { compareUk } from './sort';

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
  courseName: string;
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
 */
@Component({
  selector: 'app-lecturer-page',
  templateUrl: './lecturer-page.html',
  imports: [RouterLink, TimetableView]
})
export class LecturerDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);

  readonly lecturerId: string = this.route.snapshot.paramMap.get('id')!;
  readonly positionLabel = positionLabel;
  readonly termLabelShort = termLabelShort;
  readonly fmtNumber = fmtNumber;

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

  ngOnInit() { this.load(); }

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
          course { id name }
          department { id name }
          curriculumItemHours { hourType hours curriculumItem { semester course { id name courseType } specialty { id name } } }
        }
        combinedWorkingCurriculumItem {
          workingCurriculumItems {
            lecturerCount teachingFormat
            course { id name }
            department { id name }
            curriculumItemHours { hourType hours curriculumItem { semester course { id name courseType } specialty { id name } } }
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
}
