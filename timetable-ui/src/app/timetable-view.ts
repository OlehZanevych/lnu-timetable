import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { GlobalPropertiesService } from './global-properties.service';
import { Option, SearchSelect } from './search-select';
import { WEEK_PARITY_OPTIONS } from './entities';
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
 * Mounted five ways. The faculty page passes its academic groups and gets the розклад it publishes;
 * the department page passes its lecturers and gets the викладацький розклад a кафедра works from;
 * the lecturer and room pages pass one id each and get a single column. All of them share the query,
 * the grid, the semester filter and the export, because a timetable rendered four different ways is
 * four chances to disagree.
 *
 * **The semester filter is on by default and matters.** `timetable_entries` has no semester of its
 * own — it lives two joins away on the curriculum item — so an unfiltered grid shows autumn and
 * spring at once and rooms appear double-booked when they are not. The backend's `semesterParity`
 * relation filter is what this passes, defaulting to the `current_semester_parity` setting.
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
   * picker it has always had, seeded from `current_semester_parity`. Set to `''`/`'ODD'`/`'EVEN'`,
   * the picker is hidden and the value is followed, which is what «Мій кабінет» needs: one
   * half-year control in its header governing the timetable *and* the curriculum beside it, rather
   * than two that can disagree about which semester the page is showing.
   */
  @Input() externalSemesterParity: string | null = null;

  readonly dayNames = DAY_NAMES;
  readonly parityOptions: Option[] = [
    { id: '', label: 'Весь навчальний рік' },
    { id: 'ODD', label: 'Перший (непарний) семестр' },
    { id: 'EVEN', label: 'Другий (парний) семестр' }
  ];

  entries = signal<RawEntry[]>([]);
  loading = signal(false);
  error = signal('');
  exporting = signal(false);
  exportError = signal('');

  /** ODD / EVEN / '' — seeded from `current_semester_parity` on first load. */
  semesterParity = signal('');
  private parityTouched = false;

  private academicHourMinutes = computed(() =>
    this.settings.numberValue('academic_hour_duration_minutes') ?? 40);

  grid = computed(() => buildTimetableGrid(this.entries(), {
    columnMode: this.columnMode,
    academicHourMinutes: this.academicHourMinutes()
  }));

  /** Days with at least one class — an empty Saturday is not worth a column of dashes. */
  activeDays = computed(() => this.grid().days.filter((d) => !dayIsEmpty(this.grid(), d)));

  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    this.settings.ensureLoaded();
    // The current half-year is the useful default; a user who picks another keeps it.
    queueMicrotask(() => {
      if (!this.parityTouched) {
        const current = this.settings.value('current_semester_parity');
        if (current) this.semesterParity.set(current);
      }
      this.load();
    });
  }

  ngOnChanges() {
    // Runs before ngOnInit on the first pass, so marking the value as "touched" here is also what
    // stops the current_semester_parity default from overwriting the host's choice a tick later.
    if (this.externalSemesterParity !== null) {
      this.parityTouched = true;
      this.semesterParity.set(this.externalSemesterParity);
    }
    if (this.initialized) this.load();
  }

  onParityChange(value: string) {
    this.parityTouched = true;
    this.semesterParity.set(value);
    this.load();
  }

  private idListFilter(): string | null {
    const list = (name: string, ids: string[]) =>
      ids.length ? `${name}: [${ids.map((id) => `"${id}"`).join(', ')}]` : '';
    const parts = [
      list('academicGroupIds', this.academicGroupIds),
      list('lecturerIds', this.lecturerIds),
      list('roomIds', this.roomIds)
    ].filter(Boolean);
    // No scope at all would fetch the whole university; the host page has simply not loaded its
    // ids yet, so nothing is shown rather than everything.
    return parts.length ? parts.join(', ') : null;
  }

  load() {
    const scope = this.idListFilter();
    if (!scope) { this.entries.set([]); return; }

    const parity = this.semesterParity();
    const parityFilter = parity ? `, semesterParity: "${parity}"` : '';
    this.loading.set(true);

    const q = `{ timetableEntries { timetableEntryConnection(limit: 2000, offset: 0, ${scope}${parityFilter}) { nodes {
      id dayOfWeek weekParity
      classStartTime { id ordinal startTime }
      room { id number name }
      workload {
        id durationHours
        lecturers { id firstName lastName position }
        academicGroups { id name }
        combinedGroups { name academicGroups { id name } }
        workingCurriculumItem {
          course { id name }
          department { id name }
          curriculumItemHours { hourType curriculumItem { semester course { id name courseType } specialty { id name } } }
        }
        combinedWorkingCurriculumItem {
          workingCurriculumItems {
            course { id name }
            department { id name }
            curriculumItemHours { hourType curriculumItem { semester course { id name courseType } specialty { id name } } }
          }
        }
      }
    } } } }`;

    this.gql.request(q).subscribe({
      next: (d: any) => {
        this.entries.set(d.timetableEntries.timetableEntryConnection.nodes ?? []);
        this.error.set('');
        this.loading.set(false);
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
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
