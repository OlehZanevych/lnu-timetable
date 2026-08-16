import { Component, Input, OnChanges, OnInit, WritableSignal, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { compareUk } from './sort';
import { DepartmentWorkloadSummary } from './department-workload-summary';

/** The taught hour types a course-count constraint can be scoped to. */
const HOUR_TYPES = ['LECTURE', 'PRACTICAL', 'LAB'] as const;
type HourType = (typeof HOUR_TYPES)[number];

/** MANDATORY and ELECTIVE are disjoint subsets of ALL — which is what makes their minimums add up. */
const SCOPES = ['ALL', 'MANDATORY', 'ELECTIVE'] as const;
type Scope = (typeof SCOPES)[number];

const HOUR_TYPE_LABELS: Record<HourType, string> = {
  LECTURE: 'Лекції',
  PRACTICAL: 'Практичні',
  LAB: 'Лабораторні'
};

const SCOPE_LABELS: Record<Scope, string> = {
  ALL: 'Усі дисципліни',
  MANDATORY: "Обов'язкові",
  ELECTIVE: 'Вибіркові'
};

/**
 * Builds a course-count constraint's enum name, matching lecturer_workload_constraint_type in
 * schema.sql: MIN_LECTURE_COURSES, MAX_MANDATORY_LAB_COURSES, and so on.
 */
const courseKey = (bound: 'MIN' | 'MAX', scope: Scope, hourType: HourType): string =>
  scope === 'ALL' ? `${bound}_${hourType}_COURSES` : `${bound}_${scope}_${hourType}_COURSES`;

const MIN_HOURS = 'MIN_HOURS_PER_YEAR';
const MAX_HOURS = 'MAX_HOURS_PER_YEAR';
const MAX_COURSES = 'MAX_COURSES';

/**
 * The three constraints that apply to a lecturer as a whole. These tend to be filled in for
 * everybody (often just the annual hour bounds), so they say little about whether a lecturer's
 * workload has actually been described in detail — hence the split below.
 */
const GENERAL_KEYS: string[] = [MIN_HOURS, MAX_HOURS, MAX_COURSES];

/**
 * The per-hour-type / per-course-kind constraints — the ones that are only set deliberately, for
 * a lecturer whose workload needs shaping beyond the blanket limits.
 */
const SPECIFIC_KEYS: string[] = SCOPES.flatMap(
  (s) => HOUR_TYPES.flatMap((h) => [courseKey('MIN', s, h), courseKey('MAX', s, h)]));

/** Every constraint the backend enum knows about, in the order the form lays them out. */
const ALL_KEYS: string[] = [...GENERAL_KEYS, ...SPECIFIC_KEYS];

const LABELS: Record<string, string> = {
  [MIN_HOURS]: 'Мінімум годин на рік',
  [MAX_HOURS]: 'Максимум годин на рік',
  [MAX_COURSES]: 'Максимум дисциплін усього',
  ...Object.fromEntries(SCOPES.flatMap((s) => HOUR_TYPES.flatMap((h) => [
    [courseKey('MIN', s, h), `${SCOPE_LABELS[s]} · ${HOUR_TYPE_LABELS[h]} · мінімум`],
    [courseKey('MAX', s, h), `${SCOPE_LABELS[s]} · ${HOUR_TYPE_LABELS[h]} · максимум`]
  ])))
};

interface ConstraintNode { id: string; constraintType: string; value: number }

/** One lecturer's card: every constraint, set or not, plus the state needed to save it. */
interface LecturerBlock {
  id: string;
  name: string;
  /** Echoed back on save — LecturerInputPayload declares these non-null. */
  firstName: string;
  lastName: string;
  /** constraintType → current value as a string; '' means "not set". */
  values: Record<string, WritableSignal<string>>;
  /** constraintType → existing lecturer_workload_constraints row id, or null. */
  rowIds: Record<string, string | null>;
  dirty: WritableSignal<boolean>;
  saving: WritableSignal<boolean>;
  error: WritableSignal<string>;
}

/** A broken consistency rule: the message to show, and which fields to light up. */
interface Violation { message: string; keys: string[] }

/**
 * Workload constraints for every lecturer of a department — the inputs a workload generator has to
 * satisfy, edited one card per lecturer.
 *
 * The rules are only meaningful as a set (a maximum for mandatory lecture courses is nonsense
 * beside a smaller maximum for lecture courses overall), so a card is validated as a whole, saved
 * in one mutation through Lecturer's `workloadConstraints` nested list, and cannot be saved while
 * it contradicts itself.
 */
@Component({
  selector: 'app-lecturer-constraint-list',
  templateUrl: './lecturer-constraint-list.html',
  imports: [FormsModule, DepartmentWorkloadSummary]
})
export class LecturerConstraintList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);
  private auth = inject(AuthService);

  @Input() departmentId!: string;

  /**
   * This account's level on the кафедра whose lecturers are being edited here.
   *
   * Every write this component makes is an `updateLecturer` carrying the `workloadConstraints`
   * nested list, and a Lecturer's permission scope is its кафедра, so one question answers the whole
   * screen: nothing here is scoped any narrower than the department the tab belongs to.
   */
  private departmentLevel = signal<AccessLevel | null>(null);

  /** The level actually in force: the кафедра's own, or a stronger university-wide grant. */
  private effectiveLevel = computed(() => maxLevel(this.auth.globalLevel(), this.departmentLevel()));

  /**
   * Whether this account may change a card at all.
   *
   * `EDIT` and not `FULL`, including for «Очистити»: clearing a lecturer's fields does not delete
   * anything by itself, it prepares an update that sends a shorter `workloadConstraints` list, and
   * the rows that disappear do so because the nested list no longer names them. That is one
   * `updateLecturer`, and an update needs `EDIT`.
   */
  canEdit = computed(() => allows(this.effectiveLevel(), 'EDIT'));

  readonly HOUR_TYPES = HOUR_TYPES;
  readonly SCOPES = SCOPES;
  readonly HOUR_TYPE_LABELS = HOUR_TYPE_LABELS;
  readonly SCOPE_LABELS = SCOPE_LABELS;
  readonly MIN_HOURS = MIN_HOURS;
  readonly MAX_HOURS = MAX_HOURS;
  readonly MAX_COURSES = MAX_COURSES;

  blocks = signal<LecturerBlock[]>([]);
  error = signal('');
  loading = signal(false);

  /** `default_max_hours_per_year` — the ceiling that applies when MAX_HOURS_PER_YEAR isn't set. */
  defaultMaxHours = signal<number | null>(null);

  lecturerFilter = signal('');

  /**
   * Narrows the list to lecturers with at least one *specific* constraint. Counting every
   * constraint would barely filter anything, since the general three are typically set for
   * everyone — see GENERAL_KEYS.
   */
  onlySpecific = signal(false);

  visibleBlocks = computed(() => {
    const q = this.lecturerFilter().trim().toLowerCase();
    const specificOnly = this.onlySpecific();
    return this.blocks().filter((b) => {
      if (specificOnly && !this.specificCount(b)) return false;
      return !q || b.name.toLowerCase().includes(q);
    });
  });

  /** Lecturers whose workload has been shaped beyond the blanket limits. */
  specificallyConstrainedCount = computed(() => this.blocks().filter((b) => this.specificCount(b) > 0).length);

  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    if (this.departmentId) { this.loadPermission(); this.load(); }
  }

  ngOnChanges() {
    if (this.initialized && this.departmentId) { this.loadPermission(); this.load(); }
  }

  /**
   * Asks about the кафедра the tab was opened on. The answer is dropped if the host has moved on to
   * another department in the meantime: a late reply about the previous one would decide this one.
   */
  private loadPermission() {
    const id = this.departmentId;
    this.departmentLevel.set(null);
    this.auth.accessLevel('DEPARTMENT', id).subscribe({
      next: (level) => { if (id === this.departmentId) this.departmentLevel.set(level); },
      error: () => { if (id === this.departmentId) this.departmentLevel.set(null); }
    });
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  /** Cards with unsaved edits are preserved across a reload, except `keepId` (the one just saved). */
  private load(keepId: string | null = null) {
    if (!this.departmentId) return;
    this.loading.set(true);

    const lecturers = `query($departmentId: ID, $limit: Int!, $offset: Int!) { lecturers { lecturerConnection(limit: $limit, offset: $offset, departmentId: $departmentId) { nodes {
      id firstName middleName lastName
      workloadConstraints { id constraintType value }
    } } } }`;
    const property = `query($name: ID!) { globalProperties { globalProperty(name: $name) { value } } }`;

    forkJoin({ l: this.gql.request(lecturers, { departmentId: this.departmentId, limit: 500, offset: 0 }), p: this.gql.request(property, { name: 'default_max_hours_per_year' }) }).subscribe({
      next: ({ l, p }: any) => {
        const raw = p.globalProperties.globalProperty?.value;
        const parsed = raw != null ? Number(raw) : NaN;
        this.defaultMaxHours.set(Number.isFinite(parsed) ? parsed : null);

        const dirtyBefore = new Map<string, LecturerBlock>();
        for (const b of this.blocks()) {
          if (b.id !== keepId && b.dirty()) dirtyBefore.set(b.id, b);
        }

        const blocks: LecturerBlock[] = l.lecturers.lecturerConnection.nodes
          .map((n: any) => dirtyBefore.get(n.id) ?? this.toBlock(n))
          .sort((a: LecturerBlock, b: LecturerBlock) => compareUk(a.name, b.name));

        this.blocks.set(blocks);
        this.error.set('');
        this.loading.set(false);
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }

  private toBlock(node: any): LecturerBlock {
    const byType = new Map<string, ConstraintNode>();
    for (const c of node.workloadConstraints ?? []) byType.set(c.constraintType, c);

    const values: Record<string, WritableSignal<string>> = {};
    const rowIds: Record<string, string | null> = {};
    for (const key of ALL_KEYS) {
      const existing = byType.get(key);
      values[key] = signal(existing?.value != null ? String(existing.value) : '');
      rowIds[key] = existing?.id ?? null;
    }

    return {
      id: node.id,
      name: [node.lastName, node.firstName, node.middleName].filter(Boolean).join(' '),
      firstName: node.firstName,
      lastName: node.lastName,
      values,
      rowIds,
      dirty: signal(false),
      saving: signal(false),
      error: signal('')
    };
  }

  // ── Reading / editing values ─────────────────────────────────────────────

  value(block: LecturerBlock, key: string): string {
    return block.values[key]();
  }

  label(key: string): string {
    return LABELS[key] ?? key;
  }

  courseKey(bound: 'MIN' | 'MAX', scope: Scope, hourType: HourType): string {
    return courseKey(bound, scope, hourType);
  }

  setValue(block: LecturerBlock, key: string, raw: any) {
    block.values[key].set(raw == null ? '' : String(raw));
    block.dirty.set(true);
    block.error.set('');
  }

  /** Parsed value, or null when the field is blank (i.e. the constraint isn't set). */
  private num(block: LecturerBlock, key: string): number | null {
    const raw = block.values[key]().trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  }

  setCount(block: LecturerBlock): number {
    return this.countSet(block, ALL_KEYS);
  }

  /** How many of the per-hour-type / per-course-kind constraints this lecturer has set. */
  specificCount(block: LecturerBlock): number {
    return this.countSet(block, SPECIFIC_KEYS);
  }

  private countSet(block: LecturerBlock, keys: string[]): number {
    return keys.filter((k) => block.values[k]().trim() !== '').length;
  }

  // ── Consistency validation ───────────────────────────────────────────────

  /**
   * Every consistency rule between constraints, evaluated together. Unset constraints are simply
   * absent from a rule rather than defaulting to zero — except in the "minimums must fit under the
   * maximum" rule, where an unset minimum genuinely is zero.
   */
  violations(block: LecturerBlock): Violation[] {
    const out: Violation[] = [];
    const n = (k: string) => this.num(block, k);

    for (const key of ALL_KEYS) {
      const v = n(key);
      if (v !== null && (Number.isNaN(v) || v < 0)) {
        out.push({ message: `«${this.label(key)}» має бути невід'ємним числом.`, keys: [key] });
      }
    }

    // ── hours per year ──
    const minH = n(MIN_HOURS);
    const maxH = n(MAX_HOURS);
    if (ok(minH) && ok(maxH) && minH! > maxH!) {
      out.push({ message: `Мінімум годин на рік (${minH}) більший за максимум (${maxH}).`, keys: [MIN_HOURS, MAX_HOURS] });
    } else if (ok(minH) && !ok(maxH) && this.defaultMaxHours() !== null && minH! > this.defaultMaxHours()!) {
      // No explicit maximum, so the global default applies — and the minimum has to fit under it.
      out.push({
        message: `Мінімум годин на рік (${minH}) більший за типовий максимум (${this.defaultMaxHours()}). `
          + 'Задайте власний максимум або зменшіть мінімум.',
        keys: [MIN_HOURS]
      });
    }

    const maxAll = n(MAX_COURSES);

    for (const h of HOUR_TYPES) {
      const ht = HOUR_TYPE_LABELS[h];
      const minT = n(courseKey('MIN', 'ALL', h));
      const maxT = n(courseKey('MAX', 'ALL', h));

      if (ok(minT) && ok(maxT) && minT! > maxT!) {
        out.push({ message: `${ht}: мінімум дисциплін (${minT}) більший за максимум (${maxT}).`,
                   keys: [courseKey('MIN', 'ALL', h), courseKey('MAX', 'ALL', h)] });
      }

      for (const scope of ['MANDATORY', 'ELECTIVE'] as const) {
        const sl = SCOPE_LABELS[scope].toLowerCase();
        const mn = n(courseKey('MIN', scope, h));
        const mx = n(courseKey('MAX', scope, h));

        if (ok(mn) && ok(mx) && mn! > mx!) {
          out.push({ message: `${ht}, ${sl}: мінімум (${mn}) більший за максимум (${mx}).`,
                     keys: [courseKey('MIN', scope, h), courseKey('MAX', scope, h)] });
        }
        // A subset can never be bounded above more loosely than the whole.
        if (ok(mx) && ok(maxT) && mx! > maxT!) {
          out.push({ message: `${ht}, ${sl}: максимум (${mx}) більший за максимум усіх дисциплін цього виду (${maxT}).`,
                     keys: [courseKey('MAX', scope, h), courseKey('MAX', 'ALL', h)] });
        }
        if (ok(mx) && ok(maxAll) && mx! > maxAll!) {
          out.push({ message: `${ht}, ${sl}: максимум (${mx}) більший за максимум дисциплін усього (${maxAll}).`,
                     keys: [courseKey('MAX', scope, h), MAX_COURSES] });
        }
      }

      // MANDATORY and ELECTIVE are disjoint, so their minimums must fit under the same ceiling.
      const mandMin = ok(n(courseKey('MIN', 'MANDATORY', h))) ? n(courseKey('MIN', 'MANDATORY', h))! : 0;
      const elecMin = ok(n(courseKey('MIN', 'ELECTIVE', h))) ? n(courseKey('MIN', 'ELECTIVE', h))! : 0;
      const bothKeys = [courseKey('MIN', 'MANDATORY', h), courseKey('MIN', 'ELECTIVE', h)];
      if (mandMin + elecMin > 0 && ok(maxT) && mandMin + elecMin > maxT!) {
        out.push({
          message: `${ht}: обов'язкові (${mandMin}) + вибіркові (${elecMin}) мінімуми перевищують максимум усіх дисциплін цього виду (${maxT}).`,
          keys: [...bothKeys, courseKey('MAX', 'ALL', h)]
        });
      }
      if (mandMin + elecMin > 0 && ok(maxAll) && mandMin + elecMin > maxAll!) {
        out.push({
          message: `${ht}: обов'язкові (${mandMin}) + вибіркові (${elecMin}) мінімуми перевищують максимум дисциплін усього (${maxAll}).`,
          keys: [...bothKeys, MAX_COURSES]
        });
      }

      // A per-hour-type bound can't exceed the bound across every hour type.
      if (ok(maxT) && ok(maxAll) && maxT! > maxAll!) {
        out.push({ message: `${ht}: максимум (${maxT}) більший за максимум дисциплін усього (${maxAll}).`,
                   keys: [courseKey('MAX', 'ALL', h), MAX_COURSES] });
      }
      if (ok(minT) && ok(maxAll) && minT! > maxAll!) {
        out.push({ message: `${ht}: мінімум (${minT}) більший за максимум дисциплін усього (${maxAll}).`,
                   keys: [courseKey('MIN', 'ALL', h), MAX_COURSES] });
      }
    }

    return out;
  }

  /** Fields to light up in a card — the union of every violated rule's fields. */
  invalidKeys(block: LecturerBlock): Set<string> {
    const keys = new Set<string>();
    for (const v of this.violations(block)) for (const k of v.keys) keys.add(k);
    return keys;
  }

  hasViolations(block: LecturerBlock): boolean {
    return this.violations(block).length > 0;
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  save(block: LecturerBlock) {
    // The template does not draw «Зберегти» without EDIT, so reaching here means the card was made
    // dirty some other way; the mutation is refused server-side either way, and stopping short of it
    // spares the user a round trip that comes back «requires EDIT access».
    if (!this.canEdit()) {
      block.error.set('Змінення обмежень потребує рівня доступу «Редагування» до кафедри.');
      return;
    }
    if (this.hasViolations(block)) {
      block.error.set('Виправте суперечності перед збереженням.');
      return;
    }

    // Only constraints with a value are sent; a blank field is left out of the nested list, which
    // is what makes the backend delete a row that used to be there.
    const constraints = ALL_KEYS
      .filter((k) => block.values[k]().trim() !== '')
      .map((k) => {
        const row: Record<string, any> = { constraintType: k, value: Number(block.values[k]()) };
        if (block.rowIds[k]) row['id'] = block.rowIds[k];
        return row;
      });

    const input = {
      firstName: block.firstName,
      lastName: block.lastName,
      workloadConstraints: constraints
    };

    const q = `mutation($id: ID!, $input: LecturerInputPayload!) {
      lecturers { updateLecturer(id: $id, lecturer: $input) { isSuccess errorStatus } } }`;

    block.saving.set(true);
    this.gql.request(q, { id: block.id, input }).subscribe({
      next: (d: any) => {
        const res = d.lecturers.updateLecturer;
        block.saving.set(false);
        if (res.isSuccess) this.load(block.id);
        else block.error.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => { block.saving.set(false); block.error.set(e.message); }
    });
  }

  /** Reverts a card to what the server holds. */
  revert(block: LecturerBlock) {
    this.load(block.id);
  }

  /** Clears every field of a card — saving then removes all of that lecturer's constraints. */
  clear(block: LecturerBlock) {
    if (!this.canEdit()) return;
    for (const k of ALL_KEYS) block.values[k].set('');
    block.dirty.set(true);
    block.error.set('');
  }
}

/** A constraint participates in a rule only when it is set and numeric. */
function ok(v: number | null): boolean {
  return v !== null && Number.isFinite(v);
}
