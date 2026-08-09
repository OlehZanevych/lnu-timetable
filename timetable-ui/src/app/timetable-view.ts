import { Component, Input, OnChanges, OnInit, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GqlVars, GraphqlService } from './graphql.service';
import { GlobalPropertiesService } from './global-properties.service';
import { SearchSelect } from './search-select';
import { SEMESTER_PARITY_OPTIONS, WEEK_PARITY_OPTIONS } from './entities';
import {
  ColumnMode, DAY_NAMES, GridEntry, RawEntry, buildTimetableGrid, dayIsEmpty, gridCell
} from './timetable-grid';
import type { TimetableReportKind } from './timetable-report';
// `timetable-report`, `pdf-fonts` and `workload-report` are imported dynamically in download():
// the PDF engine is kept out of the main bundle, as it is for the other three sheets.

/** What the sheet is a timetable of, and what it is named — everything the PDF needs. */
export interface TimetableReportContext {
  kind: TimetableReportKind;
  subjectName: string;
  facultyName: string;
}

/**
 * One read-only timetable, in the layout ЛНУ publishes: день and пара down the side, and whatever
 * the page is comparing — groups, lecturers, rooms — across the top.
 *
 * Five documents. The faculty page passes its academic groups and gets the розклад it publishes
 * (narrowed, on that tab, by семестр / курс / спеціальність / група — see `restrictColumnsToScope`);
 * the department page passes its lecturers and gets the викладацький розклад a кафедра works from;
 * the lecturer and room pages pass one id each and get a single column; «Мій кабінет» shows the
 * signed-in reader their own, mounting this twice — once for a lecturer, once for a student — for
 * the one document. All of them share the query, the grid, the semester filter and the export,
 * because a timetable rendered five different ways is five chances to disagree.
 *
 * **The semester filter is not optional, and it matters.** `timetable_entries` has no semester of
 * its own — it lives two joins away on the curriculum item — so an unfiltered grid shows autumn and
 * spring at once and rooms appear double-booked when they are not. The picker therefore offers one
 * half-year or the other and nothing else; the backend's `semesterParity` relation filter is always
 * passed, seeded from the `current_semester_parity` setting and falling back to `ODD`.
 */
@Component({
  selector: 'app-timetable-view',
  templateUrl: './timetable-view.html',
  imports: [FormsModule, RouterLink, SearchSelect]
})
export class TimetableView implements OnInit, OnChanges {
  private gql = inject(GraphqlService);
  private settings = inject(GlobalPropertiesService);

  /** Scope: exactly one of these is normally set. Empty arrays mean "no scope", which loads nothing. */
  @Input() academicGroupIds: string[] = [];
  /**
   * Restricts the grid's *columns* to `academicGroupIds`, for hosts that narrow the scope to a
   * chosen few groups. Off by default, and only meaningful when `columnMode` is `'group'`.
   *
   * The server filter matches an entry if *any* of its groups is in scope, and a cell names every
   * group taught together (see `toGridEntry`) — so a lecture shared with a group outside the scope
   * otherwise raises a column for that group too, and «розклад 1 курсу» sprouts a 2nd-year column.
   *
   * The filter is applied against the scope the entries on screen were *fetched* with, never against
   * the current input. Those differ for the length of a round trip, and filtering last request's
   * classes by this request's scope rejects every column at once — which `buildTimetableGrid` reads
   * as «N не розміщено» and the view reports in red, for the whole of every filter change.
   */
  @Input() restrictColumnsToScope = false;
  @Input() lecturerIds: string[] = [];
  @Input() roomIds: string[] = [];
  /** What runs across the top. */
  @Input() columnMode: ColumnMode = 'group';
  /** Names the sheet for the PDF; without it the export button is not shown. */
  @Input() report: TimetableReportContext | null = null;
  /** Heading above the grid; omitted when the host page has its own. */
  @Input() heading = '';
  /**
   * Lets the host own the semester filter instead of this component.
   *
   * Left `null` — every screen that mounted this before «Мій кабінет» did — the view keeps the
   * picker it has always had, seeded from `current_semester_parity`. Set to `'ODD'`/`'EVEN'`, the
   * picker is hidden and the value is followed, which is what «Мій кабінет» needs: one half-year
   * control in its header governing the timetable *and* the curriculum beside it, rather than two
   * that can disagree about which semester the page is showing. Any other non-null string is read
   * as `'ODD'` — the grid always shows one half-year, so there is no "unset" for it to mean.
   */
  @Input() externalSemesterParity: string | null = null;

  readonly dayNames = DAY_NAMES;
  /**
   * One half-year or the other — there is deliberately no "whole year". A grid holding both halves
   * at once overlays classes that never coexist and shows rooms and lecturers as double-booked when
   * they are not, which is not a view of anything anyone's week actually looks like.
   */
  readonly parityOptions = SEMESTER_PARITY_OPTIONS;

  entries = signal<RawEntry[]>([]);
  loading = signal(false);
  error = signal('');
  exporting = signal(false);
  exportError = signal('');

  /** ODD / EVEN — seeded from `current_semester_parity` on first load, and never empty: a grid is
   *  always showing exactly one half-year, so the picker always names the one on screen. */
  semesterParity = signal('ODD');
  private parityTouched = false;

  private academicHourMinutes = computed(() =>
    this.settings.numberValue('academic_hour_duration_minutes') ?? 40);

  /**
   * The scope `entries()` was fetched with — set together with them, never ahead of them. A signal
   * rather than a plain field read because `grid` is a computed, which would otherwise memoise the
   * first array it saw.
   */
  private entriesScope = signal<readonly string[]>([]);

  grid = computed(() => {
    const scope = this.restrictColumnsToScope && this.columnMode === 'group'
      ? new Set(this.entriesScope())
      : null;
    return buildTimetableGrid(this.entries(), {
      columnMode: this.columnMode,
      academicHourMinutes: this.academicHourMinutes(),
      columnFilter: scope ? (id) => scope.has(id) : undefined
    });
  });

  /** Days with at least one class — an empty Saturday is not worth a column of dashes. */
  activeDays = computed(() => this.grid().days.filter((d) => !dayIsEmpty(this.grid(), d)));

  private initialized = false;
  /** Discards all but the newest in-flight load — see `load()`. */
  private loadToken = 0;
  /** Whether the stored default has been applied (or given up on) and the first load issued. */
  private paritySeeded = false;

  /**
   * Seeds the picker from `current_semester_parity`, then issues the first load.
   *
   * An effect rather than a `queueMicrotask`, because `ensureLoaded()` is an HTTP round trip: a
   * microtask runs in the same task as the request that was just sent, so `value()` is reliably
   * `null` and the stored default was silently discarded on every direct page load. Waiting for the
   * settings to resolve *either way* also means the first query carries the right half-year instead
   * of fetching autumn and then refetching spring.
   */
  constructor() {
    effect(() => {
      const settled = this.settings.loaded() || !!this.settings.error();
      if (!settled || this.paritySeeded || !this.initialized) return;
      this.paritySeeded = true;
      if (!this.parityTouched) {
        const current = this.settings.value('current_semester_parity');
        if (current === 'ODD' || current === 'EVEN') this.semesterParity.set(current);
      }
      this.load();
    });
  }

  ngOnInit() {
    this.initialized = true;
    // The first load is issued by the constructor's effect, once the current half-year is known.
    this.settings.ensureLoaded();
  }

  ngOnChanges() {
    // Runs before ngOnInit on the first pass, so marking the value as "touched" here is also what
    // stops the current_semester_parity default from overwriting the host's choice a tick later.
    if (this.externalSemesterParity !== null) {
      this.parityTouched = true;
      // Coerced, not trusted: the host owns the value but the grid still has to name one half-year.
      this.semesterParity.set(this.externalSemesterParity === 'EVEN' ? 'EVEN' : 'ODD');
    }
    // Before seeding, the effect owns the first load; after it, input changes drive their own.
    if (this.initialized && this.paritySeeded) this.load();
  }

  onParityChange(value: string) {
    this.parityTouched = true;
    // Coerced for the same reason the host-owned value is: the grid always names one half-year.
    this.semesterParity.set(value === 'EVEN' ? 'EVEN' : 'ODD');
    this.load();
  }

  private idListFilter(v: GqlVars): string | null {
    const parts = [
      v.optionalArg('academicGroupIds', '[ID!]', this.academicGroupIds),
      v.optionalArg('lecturerIds', '[ID!]', this.lecturerIds),
      v.optionalArg('roomIds', '[ID!]', this.roomIds)
    ].filter(Boolean);
    // No scope at all would fetch the whole university; the host page has simply not loaded its
    // ids yet, so nothing is shown rather than everything.
    return parts.length ? parts.join(', ') : null;
  }

  load() {
    // Rapid filter changes on a host page mean several of these can be in flight at once, and they
    // do not come back in the order they were sent. The token discards all but the newest, so a
    // slow wide query cannot land after a fast narrow one and leave the grid describing neither.
    const token = ++this.loadToken;
    const groupScope = [...this.academicGroupIds];

    const v = new GqlVars();
    const scope = this.idListFilter(v);
    if (!scope) {
      this.entries.set([]);
      this.entriesScope.set(groupScope);
      this.loading.set(false);
      return;
    }

    // Always applied — see `parityOptions` for why there is no unfiltered case to fall back to.
    const parityFilter = `, ${v.arg('semesterParity', 'String', this.semesterParity())}`;
    const paging = `${v.arg('limit', 'Int!', 2000)}, ${v.arg('offset', 'Int!', 0)}`;
    this.loading.set(true);

    const q = `${v.declaration()}{ timetableEntries { timetableEntryConnection(${paging}, ${scope}${parityFilter}) { nodes {
      id dayOfWeek weekParity
      classStartTime { id ordinal startTime }
      room { id number name }
      workload {
        id durationHours
        lecturers { id firstName lastName position }
        academicGroups { id name }
        combinedGroups { name academicGroups { id name } }
        workingCurriculumItem {
          course { id name tags { tag } }
          department { id name }
          curriculumItemHours { hourType curriculumItem { semester course { id name courseType tags { tag } } specialty { id name } } }
        }
        combinedWorkingCurriculumItem {
          workingCurriculumItems {
            course { id name tags { tag } }
            department { id name }
            curriculumItemHours { hourType curriculumItem { semester course { id name courseType tags { tag } } specialty { id name } } }
          }
        }
      }
    } } } }`;

    this.gql.request(q, v.values).subscribe({
      next: (d: any) => {
        if (token !== this.loadToken) return;
        // Set together: `grid` filters columns by the scope these entries were fetched with.
        this.entries.set(d.timetableEntries.timetableEntryConnection.nodes ?? []);
        this.entriesScope.set(groupScope);
        this.error.set('');
        this.loading.set(false);
      },
      error: (e) => {
        if (token !== this.loadToken) return;
        this.error.set(e.message);
        this.loading.set(false);
      }
    });
  }

  // ── Rendering helpers ────────────────────────────────────────────────────

  cell(day: number, ordinal: number, columnId: string): GridEntry[] {
    return gridCell(this.grid(), day, ordinal, columnId);
  }

  parityLabel(v: string): string {
    return WEEK_PARITY_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  /** True for a class taught every other week — the cell marks those and only those. */
  isBiweekly(entry: GridEntry): boolean {
    return !!entry.weekParity && entry.weekParity !== 'WEEKLY';
  }

  // ── Export ───────────────────────────────────────────────────────────────

  async download() {
    const report = this.report;
    if (!report || this.exporting() || !this.grid().entries.length) return;

    this.exporting.set(true);
    this.exportError.set('');
    const generatedAt = new Date();
    const grid = this.grid();

    try {
      const [{ downloadPdf, loadReportFonts },
             { buildTimetableReport, timetableReportFileName },
             { academicYearLabel }] = await Promise.all([
        import('./pdf-fonts'), import('./timetable-report'), import('./workload-report')
      ]);
      const fonts = await loadReportFonts();
      const bytes = buildTimetableReport({
        kind: report.kind,
        grid,
        subjectName: report.subjectName,
        facultyName: report.facultyName,
        semesterParity: this.semesterParity(),
        generatedAt,
        fonts
      });
      downloadPdf(bytes, timetableReportFileName(
        report.kind, report.subjectName, academicYearLabel(generatedAt)));
    } catch (e: unknown) {
      this.exportError.set(e instanceof Error ? e.message : 'Не вдалося сформувати PDF');
    } finally {
      this.exporting.set(false);
    }
  }
}
