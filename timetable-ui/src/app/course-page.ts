import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { GlobalPropertiesService } from './global-properties.service';
import { courseTypeLabel, CONTROL_FORM_OPTIONS, HOUR_TYPE_OPTIONS, TEACHING_FORMAT_OPTIONS,
         termLabelShort } from './entities';
import { fmtNumber, fmtOrDash } from './curriculum-plan';
import { HOUR_TYPE_SHORT, POSITION_SHORT } from './timetable-grid';
import { compareUk } from './sort';

type CourseSection = 'info' | 'curricula' | 'working' | 'workloads';

interface CourseInfo {
  id: string;
  name: string;
  courseType: string;
  faculty?: { id: string; name: string } | null;
  department?: { id: string; name: string; faculty?: { id: string; name: string } | null } | null;
  parentCourse?: { id: string; name: string } | null;
  childCourses?: { id: string; name: string; courseType: string }[];
  specialties?: { id: string; name: string; code?: string }[];
  tags?: { tag: string }[];
}

/** One curriculum_items row this course appears in, with everything hanging off it. */
interface CurriculumRow {
  id: string;
  semester: number;
  controlForm: string;
  ectsCredits?: number;
  specialty?: { id: string; name: string; code?: string; degree?: string } | null;
  hours: {
    id: string;
    hourType: string;
    hours: number;
    workingCurriculumItems: {
      id: string;
      lecturerCount: number;
      teachingFormat: string;
      department?: { id: string; name: string } | null;
      academicGroups?: { id: string; name: string }[];
      workloads?: WorkloadRow[];
    }[];
  }[];
}

interface WorkloadRow {
  id: string;
  durationHours?: number;
  lecturers?: { id: string; firstName?: string; lastName?: string; position?: string }[];
  academicGroups?: { id: string; name: string }[];
  timetableEntries?: { id: string }[];
}

/** A flattened delivery position, which is how the working-curriculum and workload tabs read. */
interface DeliveryRow {
  id: string;
  specialtyName: string;
  semester: number;
  hourType: string;
  hours: number;
  departmentId: string;
  departmentName: string;
  lecturerCount: number;
  teachingFormat: string;
  groupNames: string;
  lecturerNames: string;
  workloadCount: number;
  scheduledClasses: number;
}

/**
 * Everything the system knows about one discipline, in one place.
 *
 * A `Course` is referenced from four directions — it sits in curricula, those curricula's hour
 * blocks are handed to departments as working curriculum items, those become lecturer workloads,
 * and those become classes in the timetable — and until now the only way to see any of it was to
 * walk the specialty and department pages one at a time. This page walks the chain once, in a
 * single query, and shows what it adds up to: which curricula the discipline appears in, which
 * кафедри deliver it to which groups, and which lecturers actually carry it.
 */
@Component({
  selector: 'app-course-page',
  templateUrl: './course-page.html',
  imports: [RouterLink]
})
export class CourseDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);
  private settings = inject(GlobalPropertiesService);

  readonly courseId: string = this.route.snapshot.paramMap.get('id')!;
  readonly courseTypeLabel = courseTypeLabel;
  readonly termLabelShort = termLabelShort;
  readonly fmtNumber = fmtNumber;
  readonly fmtOrDash = fmtOrDash;

  readonly sections: { key: CourseSection; label: string }[] = [
    { key: 'info',      label: '&#x2139; Інформація' },
    { key: 'curricula', label: '&#x1F4CB; Навчальні плани' },
    { key: 'working',   label: '&#x1F5C2; Робочі навчальні плани' },
    { key: 'workloads', label: '&#x1F464; Навантаження викладачів' }
  ];

  course = signal<CourseInfo | null>(null);
  curricula = signal<CurriculumRow[]>([]);
  error = signal('');
  loading = signal(false);
  activeSection = signal<CourseSection>('info');

  /** Every delivery position of this course, flattened out of the curriculum tree. */
  deliveries = computed<DeliveryRow[]>(() => {
    const rows: DeliveryRow[] = [];
    for (const item of this.curricula()) {
      for (const block of item.hours ?? []) {
        for (const wci of block.workingCurriculumItems ?? []) {
          const lecturers = new Map<string, string>();
          let scheduled = 0;
          for (const w of wci.workloads ?? []) {
            scheduled += (w.timetableEntries ?? []).length;
            for (const l of w.lecturers ?? []) {
              const post = POSITION_SHORT[l.position ?? ''] ?? '';
              const name = `${(l.lastName ?? '').trim()} ${(l.firstName ?? '').trim().charAt(0)}.`.trim();
              lecturers.set(l.id, post ? `${post} ${name}` : name);
            }
          }
          rows.push({
            id: wci.id,
            specialtyName: item.specialty?.name ?? '—',
            semester: item.semester,
            hourType: block.hourType,
            hours: block.hours,
            departmentId: wci.department?.id ?? '',
            departmentName: wci.department?.name ?? '—',
            lecturerCount: wci.lecturerCount,
            teachingFormat: wci.teachingFormat,
            groupNames: (wci.academicGroups ?? []).map((g) => g.name).sort(compareUk).join(', '),
            lecturerNames: [...lecturers.values()].sort(compareUk).join(', '),
            workloadCount: (wci.workloads ?? []).length,
            scheduledClasses: scheduled
          });
        }
      }
    }
    return rows.sort((a, b) => a.semester - b.semester
      || compareUk(a.specialtyName, b.specialtyName)
      || compareUk(a.departmentName, b.departmentName));
  });

  /** The headline the info tab opens with: where this discipline is taught, and how much of it. */
  summary = computed(() => {
    const items = this.curricula();
    const perCredit = this.settings.numberValue('hours_per_ects_credit') ?? 30;
    const specialties = new Set<string>();
    const departments = new Set<string>();
    const groups = new Set<string>();
    const lecturers = new Set<string>();
    let credits = 0;
    let contactHours = 0;
    let scheduled = 0;

    for (const item of items) {
      if (item.specialty) specialties.add(item.specialty.id);
      credits += item.ectsCredits ?? 0;
      for (const block of item.hours ?? []) {
        if (block.hourType !== 'INDEPENDENT_WORK') contactHours += block.hours ?? 0;
        for (const wci of block.workingCurriculumItems ?? []) {
          if (wci.department) departments.add(wci.department.id);
          for (const g of wci.academicGroups ?? []) groups.add(g.id);
          for (const w of wci.workloads ?? []) {
            scheduled += (w.timetableEntries ?? []).length;
            for (const l of w.lecturers ?? []) lecturers.add(l.id);
          }
        }
      }
    }
    return {
      curriculumItems: items.length,
      specialties: specialties.size,
      departments: departments.size,
      groups: groups.size,
      lecturers: lecturers.size,
      credits,
      contactHours,
      normativeHours: credits * perCredit,
      positions: this.deliveries().length,
      scheduledClasses: scheduled
    };
  });

  ngOnInit() {
    this.settings.ensureLoaded();
    this.load();
  }

  selectSection(key: CourseSection) { this.activeSection.set(key); }

  controlFormLabel(v: string): string {
    return CONTROL_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  hourTypeLabel(v: string): string {
    return HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  hourTypeShort(v: string): string { return HOUR_TYPE_SHORT[v] ?? this.hourTypeLabel(v); }

  teachingFormatLabel(v: string): string {
    return TEACHING_FORMAT_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  tagList(): string {
    return (this.course()?.tags ?? []).map((t) => t.tag).filter(Boolean).join(', ');
  }

  /**
   * One query for the whole chain: curriculum item → hours → working item → workload → timetable
   * entries. The backend batches each relation level, so this is four round-trip-free joins rather
   * than an N+1 walk — see the service README's *Relation batching*.
   */
  private load() {
    this.loading.set(true);
    const courseQuery = `{ courses { course(id: "${this.courseId}") {
      id name courseType
      faculty { id name }
      department { id name faculty { id name } }
      parentCourse { id name }
      childCourses { id name courseType }
      specialties { id name code }
      tags { tag }
    } } }`;

    // `curriculumItemConnection` gained a `courseId` filter for this page — the connection is the
    // only way in, since Course carries no `curriculumItems` relation of its own.
    const itemsQuery = `{ curriculumItems { curriculumItemConnection(limit: 500, offset: 0, courseId: "${this.courseId}") { nodes {
      id semester controlForm ectsCredits
      specialty { id name code degree }
      hours {
        id hourType hours
        workingCurriculumItems {
          id lecturerCount teachingFormat
          department { id name }
          academicGroups { id name }
          workloads {
            id durationHours
            lecturers { id firstName lastName position }
            academicGroups { id name }
            timetableEntries { id }
          }
        }
      }
    } } } }`;

    this.gql.request(courseQuery).subscribe({
      next: (d: any) => this.course.set(d.courses.course),
      error: (e) => this.error.set(e.message)
    });

    this.gql.request(itemsQuery).subscribe({
      next: (d: any) => {
        this.curricula.set(
          (d.curriculumItems.curriculumItemConnection.nodes ?? []) as CurriculumRow[]);
        this.loading.set(false);
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }
}
