import {
  Component, EventEmitter, Input, OnChanges, OnInit, Output, computed, inject, signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { GraphqlService } from './graphql.service';
import { HALF_YEAR_TITLES, halfYearOf } from './entities';
import { compareUk } from './sort';
import {
  LecturerStats, SPLIT_HOUR_TYPES, STAT_HOUR_TYPES, computeStats, totalsOf
} from './workload-stats';
import { loadDepartmentWorkloads } from './workload-tree';

/** Which column the table is ordered by. Everything except the name orders numerically. */
type SortKey = 'name' | 'total' | 'half1' | 'half2' | 'deviation';

/**
 * The department's whole workload on one sheet: one row per lecturer with the hours they actually
 * carry, their allowed band, and the breakdown by kind of work and by mandatory/elective discipline.
 *
 * The arithmetic lives in `workload-stats.ts` and the data in `workload-tree.ts`, so this table, the
 * summary embedded in "Обмеження навантаження" and the per-lecturer drill-down can never disagree
 * about what a lecturer carries — this component only filters, sorts and renders.
 *
 * Used in two places: as its own subpage (`embedded = false`, with the toolbar and links into the
 * per-lecturer assessment) and inside the constraints editor (`embedded = true`, table only), where
 * a limit is meant to be read beside the load it governs.
 */
@Component({
  selector: 'app-department-workload-summary',
  templateUrl: './department-workload-summary.html',
  imports: [FormsModule]
})
export class DepartmentWorkloadSummary implements OnInit, OnChanges {
  private gql = inject(GraphqlService);

  @Input() departmentId!: string;
  /** Table only — no page header and no toolbar, for hosting inside another page. */
  @Input() embedded = false;
  /** Turns lecturer names into buttons that emit {@link lecturerSelected}. */
  @Input() selectable = false;
  @Output() lecturerSelected = new EventEmitter<string>();

  readonly STAT_HOUR_TYPES = STAT_HOUR_TYPES;
  readonly SPLIT_HOUR_TYPES = SPLIT_HOUR_TYPES;
  readonly HALF_YEAR_TITLES = HALF_YEAR_TITLES;
  readonly HOUR_TYPE_LABELS: Record<string, string> = {
    LECTURE: 'Лекції', PRACTICAL: 'Практичні', LAB: 'Лабораторні',
    CONSULTATION: 'Консультації', ASSESSMENT: 'Контрольні заходи',
    INDEPENDENT_WORK: 'Самостійна робота'
  };

  stats = signal<LecturerStats[]>([]);
  error = signal('');
  loading = signal(false);
  defaultMaxHours = signal<number | null>(null);

  search = signal('');
  onlyDeviating = signal(false);
  sortKey = signal<SortKey>('name');
  sortAsc = signal(true);

  private initialized = false;

  ngOnInit() { this.initialized = true; if (this.departmentId) this.load(); }
  ngOnChanges() { if (this.initialized && this.departmentId) this.load(); }

  private load() {
    this.loading.set(true);
    const metaQuery = `{
      lecturers { lecturerConnection(limit: 500, offset: 0, departmentId: "${this.departmentId}") { nodes {
        id firstName middleName lastName workloadConstraints { constraintType value }
      } } }
      globalProperties { globalProperty(name: "default_max_hours_per_year") { value } }
    }`;

    forkJoin({
      meta: this.gql.request(metaQuery),
      workloads: loadDepartmentWorkloads(this.gql, this.departmentId)
    }).subscribe({
      next: ({ meta, workloads }: any) => {
        const raw = meta.globalProperties.globalProperty?.value;
        const parsed = raw != null ? Number(raw) : NaN;
        this.defaultMaxHours.set(Number.isFinite(parsed) ? parsed : null);

        const lecturers = meta.lecturers.lecturerConnection.nodes
          .map((n: any) => ({
            id: n.id,
            name: [n.lastName, n.firstName, n.middleName].filter(Boolean).join(' '),
            constraints: Object.fromEntries(
              (n.workloadConstraints ?? []).map((c: any) => [c.constraintType, c.value]))
          }))
          .sort((a: any, b: any) => compareUk(a.name, b.name));

        this.stats.set(computeStats({
          workloads, lecturers, defaultMaxHoursPerYear: this.defaultMaxHours()
        }));
        this.error.set('');
        this.loading.set(false);
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }

  // ── Derived views ────────────────────────────────────────────────────────

  /**
   * lecturerId → hours in each half-year. Built from the same per-item hours the totals use, so a
   * lecturer's two halves always add up to their annual total.
   */
  private halfHours = computed(() => {
    const map = new Map<string, Record<number, number>>();
    for (const r of this.stats()) {
      const acc: Record<number, number> = { 1: 0, 2: 0 };
      for (const i of r.items) acc[halfYearOf(i.semester)] += i.hours;
      map.set(r.lecturerId, acc);
    }
    return map;
  });

  halfHoursOf(row: LecturerStats, half: number): number {
    return this.halfHours().get(row.lecturerId)?.[half] ?? 0;
  }

  /** The rows actually shown: filtered by the toolbar, then ordered by the chosen column. */
  rows = computed<LecturerStats[]>(() => {
    const q = this.search().trim().toLowerCase();
    const only = this.onlyDeviating();
    const visible = this.stats().filter((r) =>
      (!q || r.name.toLowerCase().includes(q)) && (!only || r.deviation !== 0));

    const key = this.sortKey();
    const dir = this.sortAsc() ? 1 : -1;
    const num = (r: LecturerStats): number =>
      key === 'total' ? r.totalHours
      : key === 'deviation' ? r.deviation
      : key === 'half1' ? this.halfHoursOf(r, 1)
      : this.halfHoursOf(r, 2);

    return [...visible].sort((a, b) => key === 'name'
      ? dir * compareUk(a.name, b.name)
      : dir * (num(a) - num(b)) || compareUk(a.name, b.name));
  });

  /** Column totals over an arbitrary set of rows. */
  private sum(rows: LecturerStats[]) {
    let half1 = 0, half2 = 0;
    for (const r of rows) { half1 += this.halfHoursOf(r, 1); half2 += this.halfHoursOf(r, 2); }
    return { ...totalsOf(rows), half1, half2 };
  }

  /**
   * The department's totals — over *every* lecturer, never the filtered subset. Searching for one
   * surname must not make "разом" read as that lecturer's own hours: the whole point of the figure
   * is the department, and a number that silently changes meaning is worse than no number.
   */
  totals = computed(() => this.sum(this.stats()));

  /** Totals over what the table currently shows; only rendered while a filter is actually on. */
  visibleTotals = computed(() => this.sum(this.rows()));

  /** True when the toolbar is hiding at least one lecturer. */
  filtered = computed(() => this.rows().length !== this.stats().length);

  /** Lecturers carrying nothing at all — the first thing a head of department looks for. */
  idleCount = computed(() => this.stats().filter((r) => r.totalHours === 0).length);

  // ── Interaction ──────────────────────────────────────────────────────────

  sortBy(key: SortKey) {
    if (this.sortKey() === key) { this.sortAsc.set(!this.sortAsc()); return; }
    this.sortKey.set(key);
    // Names read best A→Я; hours read best largest-first, which is where the outliers are.
    this.sortAsc.set(key === 'name');
  }

  sortMark(key: SortKey): string {
    return this.sortKey() !== key ? '' : this.sortAsc() ? '▲' : '▼';
  }

  select(row: LecturerStats) {
    if (this.selectable) this.lecturerSelected.emit(row.lecturerId);
  }

  // ── Formatting ───────────────────────────────────────────────────────────

  hourTypeLabel(t: string): string { return this.HOUR_TYPE_LABELS[t] ?? t; }

  /** "+6" / "-6" — the sign carries the meaning, so it is rendered explicitly. */
  deviationLabel(d: number): string { return !d ? '' : d > 0 ? `+${d}` : String(d); }

  /** Blank rather than 0, so the eye finds the real numbers. */
  cellHours(v: number): string { return v ? String(v) : ''; }

  splitHours(row: LecturerStats, scope: 'mandatory' | 'elective', hourType: string): string {
    const v = scope === 'mandatory'
      ? row.mandatoryByHourType[hourType]
      : row.electiveByHourType[hourType];
    return this.cellHours(v);
  }
}
