import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { GlobalPropertiesService } from './global-properties.service';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';

/** One line of the table: a semester the plan uses, and the length entered for it (or not). */
interface SemesterRow {
  semester: number;
  /** The id of the stored override row, when there is one. Absent means «no override yet». */
  id: string | null;
  /** What the input holds. Empty means «the usual length» — saving that deletes the stored row. */
  weeks: string;
  /** What was loaded, so the Save button can tell whether anything actually changed. */
  original: string;
}

/**
 * «Тривалість семестрів» — how many teaching weeks each semester of one освітня програма runs for.
 *
 * The розклад divides a plan position's hours by (weeks × class length) to decide how many classes a
 * week it has to place, and until now the weeks in that division were one number for the whole
 * university (`semester_duration_weeks`). That is right for most of a degree and wrong at the end of
 * one: the last semester of a master's programme is largely taken up by the final attestation and a work placement, so its teaching runs for fewer
 * weeks, and planning it as sixteen puts fewer classes a week on the timetable than the plan's hours
 * require.
 *
 * **An empty cell is a value, not a gap.** It means «the usual length», which is exactly what the
 * global property is for; the placeholder shows what that number currently is, so nobody has to
 * remember it, and clearing a cell deletes the row rather than storing a duplicate of the default.
 * That is also why this screen does not offer to fill every semester in: several hundred copies of
 * one number cannot be corrected in one place, and the whole point of the property is that it can.
 *
 * The semesters listed are the ones the programme's own curriculum uses, not 1…n. A master's
 * programme in this database may number its semesters 9, 10, 11 — carrying on from the bachelor's
 * degree it follows — and a table offering 1, 2, 3 would collect numbers that join to nothing. When
 * the plan is still empty there is nothing to read, so the list falls back to 1…`durationSemesters`,
 * which is at least the right *count*.
 */
@Component({
  selector: 'app-degree-program-semester-list',
  templateUrl: './degree-program-semester-list.html',
  imports: [FormsModule]
})
export class DegreeProgramSemesterList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);
  private settings = inject(GlobalPropertiesService);
  private auth = inject(AuthService);

  @Input({ required: true }) degreeProgramId!: string;

  rows = signal<SemesterRow[]>([]);
  loading = signal(false);
  saving = signal(false);
  error = signal('');
  saveError = signal('');
  saved = signal(false);

  /** The programme itself, because saving the semesters means updating the programme they hang off. */
  private program = signal<{ code: string; name: string; degree: string;
                             durationSemesters: number; facultyId: string | null } | null>(null);

  /** The university-wide length, shown as every empty cell's placeholder. */
  readonly defaultWeeks = computed(() => this.settings.numberValue('semester_duration_weeks'));

  private level = signal<AccessLevel | null>(null);
  readonly canEdit = computed(() => allows(maxLevel(this.auth.globalLevel(), this.level()), 'EDIT'));

  readonly changedCount = computed(() =>
    this.rows().filter((r) => r.weeks.trim() !== r.original).length);

  /** How the plan's semesters are numbered, for the sentence above the table. */
  readonly numbering = computed(() => {
    const rows = this.rows();
    if (!rows.length) return '';
    return rows.length === 1 ? `${rows[0].semester}` : `${rows[0].semester}–${rows[rows.length - 1].semester}`;
  });

  ngOnInit() {
    this.settings.ensureLoaded();
    this.load();
    this.loadPermissions();
  }

  ngOnChanges() {
    this.load();
    this.loadPermissions();
  }

  private loadPermissions() {
    if (!this.degreeProgramId) return;
    const asked = this.degreeProgramId;
    this.level.set(null);
    this.auth.accessLevel('DEGREE_PROGRAM', this.degreeProgramId).subscribe((level) => {
      if (this.degreeProgramId === asked) this.level.set(level);
    });
  }

  /**
   * Two reads in one document: the programme (with the overrides already stored on it) and the
   * semesters its curriculum actually uses. The second is what decides which lines exist — see the
   * class comment on why that is not simply 1…n.
   */
  load() {
    if (!this.degreeProgramId) return;
    this.loading.set(true);
    this.saved.set(false);
    // Fixed text with fixed variables — nothing about this document is decided at runtime, so it is
    // written out rather than assembled through GqlVars, like every other query of that kind here.
    // `$id` does double duty: the programme to read, and the programme whose plan says which
    // semesters exist.
    const q = `query($id: ID!, $limit: Int!) {
      degreePrograms { degreeProgram(id: $id) {
        id code name degree durationSemesters
        faculty { id }
        semesters { id semester durationWeeks }
      } }
      curriculumItems { curriculumItemConnection(limit: $limit, degreeProgramId: $id) {
        nodes { semester }
      } }
    }`;
    this.gql.request(q, { id: this.degreeProgramId, limit: 1000 }).subscribe({
      next: (d: any) => {
        const program = d.degreePrograms.degreeProgram;
        this.loading.set(false);
        if (!program) { this.error.set('Освітню програму не знайдено.'); return; }
        this.program.set({
          code: program.code, name: program.name, degree: program.degree,
          durationSemesters: program.durationSemesters, facultyId: program.faculty?.id ?? null
        });
        const stored = new Map<number, { id: string; durationWeeks: number }>(
          (program.semesters ?? []).map((s: any) => [Number(s.semester), { id: String(s.id), durationWeeks: s.durationWeeks }]));
        this.rows.set(this.buildRows(
          (d.curriculumItems.curriculumItemConnection.nodes ?? []).map((n: any) => Number(n.semester)),
          stored, program.durationSemesters));
      },
      error: (e) => { this.loading.set(false); this.error.set(e.message); }
    });
  }

  /**
   * The semester numbers worth a line: every one the curriculum uses, every one already overridden,
   * and — only when both are empty — 1…duration, so a programme whose plan has not been entered yet
   * still has something to fill in.
   *
   * A stored override for a semester the plan no longer has is kept rather than dropped: it would
   * otherwise be deleted by the next save without anybody being shown that it existed.
   */
  private buildRows(planSemesters: number[], stored: Map<number, { id: string; durationWeeks: number }>,
                    duration: number): SemesterRow[] {
    const numbers = new Set<number>();
    for (const s of planSemesters) if (Number.isFinite(s) && s > 0) numbers.add(s);
    for (const s of stored.keys()) numbers.add(s);
    if (numbers.size === 0) {
      for (let i = 1; i <= (duration || 0); i++) numbers.add(i);
    }
    return [...numbers].sort((a, b) => a - b).map((semester) => {
      const row = stored.get(semester);
      const weeks = row ? String(row.durationWeeks) : '';
      return { semester, id: row?.id ?? null, weeks, original: weeks };
    });
  }

  onWeeksInput(row: SemesterRow, value: string) {
    this.rows.update((rows) => rows.map((r) => (r === row ? { ...r, weeks: value } : r)));
    this.saved.set(false);
    this.saveError.set('');
  }

  revert() {
    this.rows.update((rows) => rows.map((r) => ({ ...r, weeks: r.original })));
    this.saveError.set('');
    this.saved.set(false);
  }

  /**
   * One mutation for the whole table. `updateDegreeProgram` carries the semesters as a nested list,
   * so a row with an id is updated, one without is inserted, and a row the list no longer mentions
   * is deleted — which is what an emptied cell becomes. Saving them one by one would leave a
   * half-applied table behind whenever one of the calls failed.
   *
   * The programme's own fields travel with it because the input payload requires them: they are sent
   * back exactly as they were read, so this screen cannot quietly rename a programme.
   */
  save() {
    const program = this.program();
    if (!program || !this.canEdit()) return;

    const semesters: { id?: string; semester: number; durationWeeks: number }[] = [];
    for (const row of this.rows()) {
      const raw = row.weeks.trim();
      if (raw === '') continue;                       // «the usual length» — no row, or delete the one there
      const weeks = Number(raw);
      if (!Number.isInteger(weeks) || weeks <= 0) {
        this.saveError.set(`Семестр ${row.semester}: тривалість має бути цілим числом тижнів, більшим за нуль.`);
        return;
      }
      semesters.push(row.id ? { id: row.id, semester: row.semester, durationWeeks: weeks }
                            : { semester: row.semester, durationWeeks: weeks });
    }

    this.saving.set(true);
    this.saveError.set('');
    const input = {
      code: program.code, name: program.name, degree: program.degree,
      durationSemesters: program.durationSemesters, facultyId: program.facultyId,
      semesters
    };
    const q = `mutation($id: ID!, $input: DegreeProgramInputPayload!) {
      degreePrograms { updateDegreeProgram(id: $id, degreeProgram: $input) { isSuccess errorStatus } }
    }`;
    this.gql.request(q, { id: this.degreeProgramId, input }).subscribe({
      next: (d: any) => {
        const res = d.degreePrograms.updateDegreeProgram;
        this.saving.set(false);
        if (res.isSuccess) { this.saved.set(true); this.load(); }
        else this.saveError.set(res.errorStatus || 'Помилка збереження');
      },
      error: (e) => { this.saving.set(false); this.saveError.set(e.message); }
    });
  }
}
