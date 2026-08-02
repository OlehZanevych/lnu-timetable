import {
  Component, Input, OnChanges, OnInit, SimpleChanges, computed, inject, signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { GraphqlService } from './graphql.service';
import { Option, SearchSelect } from './search-select';
import {
  CONTROL_FORM_OPTIONS, HALF_YEARS, HALF_YEAR_TITLES, HOUR_TYPE_OPTIONS, TEACHING_FORMAT_OPTIONS,
  courseTypeLabel, courseYearOf, halfYearOf, termLabel
} from './entities';
import { downloadPdf, loadReportFonts } from './pdf-fonts';
import { compareUk } from './sort';
import {
  LecturerStats, SPLIT_HOUR_TYPES, STAT_HOUR_TYPES, StatWorkload, computeStats, deviationOf
} from './workload-stats';
import {
  academicYearLabel, buildLecturerWorkloadReport, workloadReportFileName
} from './workload-report';
import { loadDepartmentWorkloads } from './workload-tree';

/** Every constraint type, grouped the way the assessment panel reads them. */
const HOURS_KEYS = ['MIN_HOURS_PER_YEAR', 'MAX_HOURS_PER_YEAR'] as const;
const COURSE_SCOPES = ['ALL', 'MANDATORY', 'ELECTIVE'] as const;
type CourseScope = (typeof COURSE_SCOPES)[number];

const courseKey = (bound: 'MIN' | 'MAX', scope: CourseScope, hourType: string): string =>
  scope === 'ALL' ? `${bound}_${hourType}_COURSES` : `${bound}_${scope}_${hourType}_COURSES`;

/** One line of the constraint-compliance panel: what is allowed, what is actual, and the verdict. */
interface Compliance {
  label: string;
  min: number | null;
  max: number | null;
  actual: number;
  deviation: number;
  /** True when neither bound is set — the row is shown greyed rather than hidden, so the full
   *  picture of what *could* be constrained stays visible. */
  unset: boolean;
}

/**
 * Per-lecturer workload assessment for a department: pick one lecturer and see everything that
 * makes up their load — the totals by kind of work and by mandatory/elective, every individual
 * position they deliver, and each constraint set for them measured against what they actually carry.
 *
 * Reads the same flattened tree and the same arithmetic as the department summary on
 * "Обмеження навантаження" (see `workload-stats.ts`), so the two views cannot disagree.
 */
@Component({
  selector: 'app-lecturer-workload-detail',
  templateUrl: './lecturer-workload-detail.html',
  imports: [FormsModule, SearchSelect]
})
export class LecturerWorkloadDetail implements OnInit, OnChanges {
  private gql = inject(GraphqlService);

  @Input() departmentId!: string;
  /** Optional preselection, so the department summary can open straight on a lecturer. */
  @Input() lecturerId = '';

  readonly STAT_HOUR_TYPES = STAT_HOUR_TYPES;
  readonly SPLIT_HOUR_TYPES = SPLIT_HOUR_TYPES;
  readonly HOUR_TYPE_LABELS: Record<string, string> = {
    LECTURE: 'Лекції', PRACTICAL: 'Практичні', LAB: 'Лабораторні',
    CONSULTATION: 'Консультації', ASSESSMENT: 'Контрольні заходи',
    INDEPENDENT_WORK: 'Самостійна робота'
  };

  lecturerOptions = signal<Option[]>([]);
  /** A signal, not a plain field: `selected` below is a computed() and only tracks signals. */
  selectedLecturerId = signal('');
  error = signal('');
  loading = signal(false);

  /** True while the PDF is being produced — the fonts are fetched on the first export. */
  exporting = signal(false);
  exportError = signal('');

  private allStats = signal<LecturerStats[]>([]);
  private workloads = signal<StatWorkload[]>([]);
  private constraintsById = signal<Record<string, Record<string, number>>>({});
  /** Position and academic degree, needed by the printable form but not by the on-screen tables. */
  private profileById = signal<Record<string, { position: string; academicDegree: string }>>({});
  private department = signal<{ name: string; facultyName: string } | null>(null);
  defaultMaxHours = signal<number | null>(null);

  /** The chosen lecturer's row, or null until one is picked. */
  selected = computed(() =>
    this.allStats().find((s) => s.lecturerId === this.selectedLecturerId()) ?? null);

  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    if (this.lecturerId) this.selectedLecturerId.set(this.lecturerId);
    if (this.departmentId) this.load();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (!this.initialized) return;
    if (changes['lecturerId'] && this.lecturerId) this.selectedLecturerId.set(this.lecturerId);
    if (changes['departmentId'] && this.departmentId) this.load();
  }

  private load() {
    this.loading.set(true);
    const lecturersQuery = `{
      lecturers { lecturerConnection(limit: 500, offset: 0, departmentId: "${this.departmentId}") { nodes {
        id firstName middleName lastName position
        academicDegree { name }
        workloadConstraints { constraintType value }
      } } }
      departments { department(id: "${this.departmentId}") { name faculty { name } } }
      globalProperties { globalProperty(name: "default_max_hours_per_year") { value } }
    }`;

    forkJoin({
      meta: this.gql.request(lecturersQuery),
      workloads: loadDepartmentWorkloads(this.gql, this.departmentId)
    }).subscribe({
      next: ({ meta, workloads }: any) => {
        const raw = meta.globalProperties.globalProperty?.value;
        const parsed = raw != null ? Number(raw) : NaN;
        this.defaultMaxHours.set(Number.isFinite(parsed) ? parsed : null);

        const dept = meta.departments?.department;
        this.department.set(dept ? { name: dept.name, facultyName: dept.faculty?.name ?? '' } : null);

        const nodes = meta.lecturers.lecturerConnection.nodes;
        const lecturers = nodes
          .map((n: any) => ({
            id: n.id,
            name: [n.lastName, n.firstName, n.middleName].filter(Boolean).join(' '),
            position: n.position ?? '',
            academicDegree: n.academicDegree?.name ?? '',
            constraints: Object.fromEntries(
              (n.workloadConstraints ?? []).map((c: any) => [c.constraintType, c.value]))
          }))
          .sort((a: any, b: any) => compareUk(a.name, b.name));

        this.lecturerOptions.set(lecturers.map((l: any) => ({ id: l.id, label: l.name })));
        this.constraintsById.set(Object.fromEntries(lecturers.map((l: any) => [l.id, l.constraints])));
        this.profileById.set(Object.fromEntries(lecturers.map(
          (l: any) => [l.id, { position: l.position, academicDegree: l.academicDegree }])));
        this.workloads.set(workloads);
        this.allStats.set(computeStats({
          workloads, lecturers, defaultMaxHoursPerYear: this.defaultMaxHours()
        }));

        // Keep the current choice across reloads; otherwise start on the first lecturer.
        if (!lecturers.some((l: any) => l.id === this.selectedLecturerId())) {
          this.selectedLecturerId.set(lecturers[0]?.id ?? '');
        }
        this.error.set('');
        this.loading.set(false);
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }

  hourTypeLabel(t: string): string { return this.HOUR_TYPE_LABELS[t] ?? t; }

  controlFormLabel(v: string): string {
    return CONTROL_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  teachingFormatLabel(v: string): string {
    return TEACHING_FORMAT_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  /** Delegates to the shared map so every course type is covered, not just the common three. */
  courseTypeLabel(v: string): string { return courseTypeLabel(v); }

  /** "3 курс — друге півріччя" for a programme-wide semester number. */
  termLabel(semester: number): string { return termLabel(semester); }

  courseYear(semester: number): number { return courseYearOf(semester); }

  /** Hours the selected lecturer carries in one half of the academic year. */
  halfYearHours(half: 1 | 2): number {
    const s = this.selected();
    if (!s) return 0;
    return s.items
      .filter((i) => halfYearOf(i.semester) === half)
      .reduce((sum, i) => sum + i.hours, 0);
  }

  deviationLabel(d: number): string {
    return !d ? '' : d > 0 ? `+${d}` : String(d);
  }

  /** Distinct disciplines the lecturer teaches, by hour type — what the course constraints bound. */
  private distinctCourses(scope: CourseScope, hourType: string): number {
    const id = this.selectedLecturerId();
    const seen = new Set<string>();
    for (const w of this.workloads()) {
      if (!w.lecturerIds.includes(id) || w.hourType !== hourType) continue;
      if (scope === 'MANDATORY' && w.courseType !== 'MANDATORY') continue;
      if (scope === 'ELECTIVE' && w.courseType !== 'ELECTIVE' && w.courseType !== 'ELECTIVE_GROUP') continue;
      seen.add(w.courseId);
    }
    return seen.size;
  }

  private allDistinctCourses(): number {
    const id = this.selectedLecturerId();
    const seen = new Set<string>();
    for (const w of this.workloads()) {
      if (w.lecturerIds.includes(id) && (SPLIT_HOUR_TYPES as readonly string[]).includes(w.hourType)) {
        seen.add(w.courseId);
      }
    }
    return seen.size;
  }

  /**
   * Every constraint that could apply, with the actual value beside it. Rows with no limit set are
   * kept and greyed rather than dropped — seeing that a bound is *absent* is part of assessing a
   * workload, and hiding them would make the panel's length depend on the data.
   */
  compliance(): Compliance[] {
    const s = this.selected();
    if (!s) return [];
    const c = this.constraintsById()[s.lecturerId] ?? {};
    const lim = (k: string): number | null => {
      const v = c[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const row = (label: string, min: number | null, max: number | null, actual: number): Compliance => ({
      label, min, max, actual,
      deviation: deviationOf(actual, min, max),
      unset: min === null && max === null
    });

    const out: Compliance[] = [
      // The hours row uses the *effective* ceiling so the default is reflected in the verdict.
      row('Години на рік', lim(HOURS_KEYS[0]), s.effectiveMaxHours, s.totalHours),
      row('Дисциплін усього', null, lim('MAX_COURSES'), this.allDistinctCourses())
    ];
    for (const scope of COURSE_SCOPES) {
      for (const t of SPLIT_HOUR_TYPES) {
        const label = scope === 'ALL'
          ? `${this.hourTypeLabel(t)} — дисциплін`
          : `${this.hourTypeLabel(t)} — ${scope === 'MANDATORY' ? "обов'язкових" : 'вибіркових'}`;
        out.push(row(label, lim(courseKey('MIN', scope, t)), lim(courseKey('MAX', scope, t)),
                     this.distinctCourses(scope, t)));
      }
    }
    return out;
  }

  /**
   * The workload split into the two halves of the academic year, first half first, each with its
   * own hour total. Rows inside a half are ordered by course year (the stored semester number,
   * which is what sorts correctly) and then by discipline.
   *
   * Both halves are always returned, even when empty: seeing that a lecturer carries nothing in
   * the second half is exactly the kind of imbalance this page exists to surface, and dropping the
   * group would silently hide it.
   */
  itemsByHalfYear() {
    const s = this.selected();
    if (!s) return [];
    return HALF_YEARS.map((half) => {
      const items = s.items
        .filter((i) => halfYearOf(i.semester) === half)
        .sort((a, b) => a.semester - b.semester
          || compareUk(a.courseName, b.courseName)
          || a.hourType.localeCompare(b.hourType));
      return {
        half,
        title: HALF_YEAR_TITLES[half],
        items,
        hours: items.reduce((sum, i) => sum + i.hours, 0)
      };
    });
  }

  cellHours(v: number): string { return v ? String(v) : ''; }

  /**
   * Builds the printable «Розрахунок навчального навантаження» for the selected lecturer and hands
   * it to the browser as a download.
   *
   * Everything happens on the client: the document is assembled from the statistics already in
   * memory by `workload-report.ts`, and written out by the project's own PDF writer, so no round
   * trip and no server-side rendering is involved. The only fetch is for the embedded font, and
   * only on the first export of a session.
   */
  downloadReport() {
    const s = this.selected();
    const dept = this.department();
    if (!s || this.exporting()) return;

    this.exporting.set(true);
    this.exportError.set('');
    const profile = this.profileById()[s.lecturerId] ?? { position: '', academicDegree: '' };
    const generatedAt = new Date();

    loadReportFonts()
      .then((fonts) => {
        const bytes = buildLecturerWorkloadReport({
          stats: s,
          facultyName: dept?.facultyName ?? '',
          departmentName: dept?.name ?? '',
          position: profile.position,
          academicDegree: profile.academicDegree,
          defaultMaxHours: this.defaultMaxHours(),
          generatedAt,
          fonts
        });
        downloadPdf(bytes, workloadReportFileName(s.name, academicYearLabel(generatedAt)));
        this.exporting.set(false);
      })
      .catch((e: unknown) => {
        this.exportError.set(e instanceof Error ? e.message : 'Не вдалося сформувати PDF');
        this.exporting.set(false);
      });
  }
}
