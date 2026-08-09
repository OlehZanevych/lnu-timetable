import { Component, Input, OnChanges, OnInit, WritableSignal, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GqlVars, GraphqlService } from './graphql.service';
import { compareUk } from './sort';
import { TimeSelect } from './time-select';

/**
 * The four restriction kinds, matching timetable_constraint_type in schema.sql. Each applies
 * either to every day or to one named day, which is what covers the eight rules the faculty asks
 * for with four types.
 */
type ConstraintType = 'MAX_CLASSES_PER_DAY' | 'NOT_BEFORE' | 'NOT_AFTER' | 'UNAVAILABLE';

/** The three subjects a restriction can belong to. Everything else here is driven off this. */
export type ConstraintSubject = 'lecturer' | 'academicGroup' | 'room';

/** Monday = 1, matching timetable_entries.day_of_week. */
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const DAY_LABELS: Record<number, string> = {
  1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 7: 'Нд'
};

const DAY_FULL: Record<number, string> = {
  1: 'понеділок', 2: 'вівторок', 3: 'середа', 4: 'четвер', 5: "п'ятниця", 6: 'субота', 7: 'неділя'
};

/**
 * How each subject is loaded and saved. The GraphQL schema is generated from the backend's entity
 * config, so all three follow the same shape — a namespaced connection query and an
 * `update<Entity>` mutation taking an `<Entity>InputPayload` — and only the names differ.
 *
 * `required` lists the input fields the payload declares non-null: they have to be echoed back
 * unchanged or the mutation is rejected, exactly as the workload-constraint editor echoes a
 * lecturer's first and last name.
 */
interface SubjectMeta {
  namespace: string;
  connection: string;
  /** connection argument that scopes the list to the page's department or faculty */
  filterArg: string;
  entity: string;
  /** mutation argument name, e.g. `lecturer:` */
  single: string;
  /** extra fields to select so the payload's non-null fields can be echoed back on save */
  selection: string;
  required: (node: any) => Record<string, any>;
  label: (node: any) => string;
  /** shown under the subject's name in the card header */
  sub: (node: any) => string;
  title: string;
  hint: string;
  emptyText: string;
  searchLabel: string;
}

const SUBJECTS: Record<ConstraintSubject, SubjectMeta> = {
  lecturer: {
    namespace: 'lecturers',
    connection: 'lecturerConnection',
    filterArg: 'departmentId',
    entity: 'Lecturer',
    single: 'lecturer',
    selection: 'firstName middleName lastName',
    required: (n) => ({ firstName: n.firstName, lastName: n.lastName }),
    label: (n) => [n.lastName, n.firstName, n.middleName].filter(Boolean).join(' '),
    sub: () => '',
    title: 'Обмеження розкладу викладачів',
    hint: 'Коли викладачеві можна ставити пари.',
    emptyText: 'На цій кафедрі ще немає викладачів.',
    searchLabel: 'Пошук викладача'
  },
  academicGroup: {
    namespace: 'academicGroups',
    connection: 'academicGroupConnection',
    filterArg: 'facultyId',
    entity: 'AcademicGroup',
    single: 'academicGroup',
    selection: 'name courseYear studyForm specialty { id name }',
    required: (n) => ({
      name: n.name,
      courseYear: n.courseYear,
      studyForm: n.studyForm,
      specialtyId: n.specialty?.id
    }),
    label: (n) => n.name,
    sub: (n) => [n.courseYear ? `${n.courseYear} курс` : '', n.specialty?.name].filter(Boolean).join(' · '),
    title: 'Обмеження розкладу академічних груп',
    hint: 'Коли групі можна ставити пари.',
    emptyText: 'На цьому факультеті ще немає академічних груп.',
    searchLabel: 'Пошук групи'
  },
  room: {
    namespace: 'rooms',
    connection: 'roomConnection',
    filterArg: 'facultyId',
    entity: 'Room',
    single: 'room',
    selection: 'number name building { id name }',
    required: (n) => ({ number: n.number }),
    label: (n) => n.number,
    sub: (n) => [n.name, n.building?.name].filter(Boolean).join(' · '),
    title: 'Обмеження розкладу аудиторій',
    hint: 'Коли аудиторію можна займати.',
    emptyText: 'На цьому факультеті ще немає аудиторій.',
    searchLabel: 'Пошук аудиторії'
  }
};

/** One editable restriction. `id` is the existing row's id, or null for one just added. */
interface Rule {
  id: string | null;
  type: WritableSignal<ConstraintType>;
  /** '' = every day, otherwise '1'..'7' */
  day: WritableSignal<string>;
  /** MAX_CLASSES_PER_DAY */
  count: WritableSignal<string>;
  /** NOT_BEFORE, and the start of an UNAVAILABLE window */
  from: WritableSignal<string>;
  /** NOT_AFTER, and the end of an UNAVAILABLE window */
  to: WritableSignal<string>;
}

/** One subject's card: its rules plus the state needed to save them. */
interface Block {
  id: string;
  name: string;
  sub: string;
  node: any;
  rules: WritableSignal<Rule[]>;
  dirty: WritableSignal<boolean>;
  saving: WritableSignal<boolean>;
  error: WritableSignal<string>;
}

interface Violation { message: string; index: number }

const TYPE_LABELS: Record<ConstraintType, string> = {
  MAX_CLASSES_PER_DAY: 'Не більше пар',
  NOT_BEFORE: 'Починати не раніше',
  NOT_AFTER: 'Закінчувати не пізніше',
  UNAVAILABLE: 'Не займати проміжок'
};

const TYPES = Object.keys(TYPE_LABELS) as ConstraintType[];

/**
 * Scheduling restrictions for every lecturer of a department, or every academic group or room of a
 * faculty — the inputs a scheduler has to satisfy, edited one card per subject.
 *
 * A subject's rules are only meaningful together (a day-specific rule *overrides* the every-day
 * rule of the same kind rather than adding to it), so a card is validated as a whole and saved in
 * one mutation through the subject's `timetableConstraints` nested list — sending the full desired
 * set, which is what makes the backend delete a rule that was removed.
 *
 * The same component serves all three subjects because the generated GraphQL schema gives them the
 * same shape; SUBJECTS above holds everything that differs.
 */
@Component({
  selector: 'app-timetable-constraint-list',
  templateUrl: './timetable-constraint-list.html',
  imports: [FormsModule, TimeSelect]
})
export class TimetableConstraintList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);

  /** Which subject this instance edits. */
  @Input({ required: true }) subject!: ConstraintSubject;
  /** The department id (lecturers) or faculty id (groups, rooms) the list is scoped to. */
  @Input({ required: true }) scopeId!: string;

  readonly TYPES = TYPES;
  readonly TYPE_LABELS = TYPE_LABELS;
  readonly DAYS = DAYS;
  readonly DAY_LABELS = DAY_LABELS;

  blocks = signal<Block[]>([]);
  error = signal('');
  loading = signal(false);
  filter = signal('');
  onlyConstrained = signal(false);

  get meta(): SubjectMeta { return SUBJECTS[this.subject]; }

  visibleBlocks = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const only = this.onlyConstrained();
    return this.blocks().filter((b) => {
      if (only && !b.rules().length) return false;
      if (!q) return true;
      return b.name.toLowerCase().includes(q) || b.sub.toLowerCase().includes(q);
    });
  });

  constrainedCount = computed(() => this.blocks().filter((b) => b.rules().length > 0).length);

  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    if (this.scopeId) this.load();
  }

  ngOnChanges() {
    if (this.initialized && this.scopeId) this.load();
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  /** Cards with unsaved edits survive a reload, except `keepId` (the one just saved). */
  private load(keepId: string | null = null) {
    if (!this.scopeId) return;
    const m = this.meta;
    this.loading.set(true);

    // `m.filterArg` is metadata — `departmentId` for lecturers, `facultyId` for groups and rooms —
    // so the argument *name* is assembled here. Its value is not: it goes through a variable named
    // after whichever parameter this list scopes by.
    const v = new GqlVars();
    const args = `${v.arg('limit', 'Int!', 500)}, ${v.arg('offset', 'Int!', 0)}, `
      + `${m.filterArg}: ${v.ref(m.filterArg, 'ID', this.scopeId)}`;
    const q = `${v.declaration()}{ ${m.namespace} { ${m.connection}(${args}) { nodes {
      id ${m.selection}
      timetableConstraints { id constraintType dayOfWeek constraintValue }
    } } } }`;

    this.gql.request(q, v.values).subscribe({
      next: (d: any) => {
        const dirtyBefore = new Map<string, Block>();
        for (const b of this.blocks()) {
          if (b.id !== keepId && b.dirty()) dirtyBefore.set(b.id, b);
        }
        const blocks: Block[] = d[m.namespace][m.connection].nodes
          .map((n: any) => dirtyBefore.get(n.id) ?? this.toBlock(n))
          .sort((a: Block, b: Block) => compareUk(a.name, b.name));
        this.blocks.set(blocks);
        this.error.set('');
        this.loading.set(false);
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }

  private toBlock(node: any): Block {
    const m = this.meta;
    const rules = (node.timetableConstraints ?? []).map((c: any) => this.toRule(c));
    return {
      id: node.id,
      name: m.label(node),
      sub: m.sub(node),
      node,
      rules: signal(this.sortRules(rules)),
      dirty: signal(false),
      saving: signal(false),
      error: signal('')
    };
  }

  /** Splits a stored `constraintValue` back into the field the matching type edits. */
  private toRule(c: any): Rule {
    const type = c.constraintType as ConstraintType;
    const v: string = c.constraintValue ?? '';
    const [from, to] = type === 'UNAVAILABLE' ? v.split('-') : ['', ''];
    return {
      id: c.id,
      type: signal(type),
      day: signal(c.dayOfWeek != null ? String(c.dayOfWeek) : ''),
      count: signal(type === 'MAX_CLASSES_PER_DAY' ? v : ''),
      from: signal(type === 'NOT_BEFORE' ? v : (from ?? '')),
      to: signal(type === 'NOT_AFTER' ? v : (to ?? ''))
    };
  }

  private sortRules(rules: Rule[]): Rule[] {
    return [...rules].sort((a, b) => {
      const da = a.day() === '' ? 0 : Number(a.day());
      const db = b.day() === '' ? 0 : Number(b.day());
      return da - db || TYPES.indexOf(a.type()) - TYPES.indexOf(b.type());
    });
  }

  // ── Editing ──────────────────────────────────────────────────────────────

  addRule(block: Block) {
    block.rules.update((rs) => [...rs, {
      id: null,
      type: signal<ConstraintType>('NOT_BEFORE'),
      day: signal(''),
      count: signal(''),
      from: signal(''),
      to: signal('')
    }]);
    block.dirty.set(true);
    block.error.set('');
  }

  removeRule(block: Block, index: number) {
    block.rules.update((rs) => rs.filter((_, i) => i !== index));
    block.dirty.set(true);
    block.error.set('');
  }

  /** Changing the kind clears the fields the previous kind used, so nothing stale is saved. */
  setType(block: Block, rule: Rule, value: string) {
    rule.type.set(value as ConstraintType);
    rule.count.set('');
    rule.from.set('');
    rule.to.set('');
    block.dirty.set(true);
    block.error.set('');
  }

  touch(block: Block) {
    block.dirty.set(true);
    block.error.set('');
  }

  dayLabel(day: string): string {
    return day === '' ? 'усі дні' : DAY_FULL[Number(day)];
  }

  // ── Validation ───────────────────────────────────────────────────────────

  /**
   * Everything the database would reject, checked before the round trip, plus the contradictions
   * only visible across rules — a duplicate every-day rule, or a window that swallows the whole day.
   */
  violations(block: Block): Violation[] {
    const out: Violation[] = [];
    const rules = block.rules();
    const seen = new Map<string, number>();

    rules.forEach((r, i) => {
      const type = r.type();
      const day = r.day();
      const where = day === '' ? 'усі дні' : DAY_FULL[Number(day)];

      if (type === 'MAX_CLASSES_PER_DAY') {
        const raw = r.count().trim();
        if (raw === '') out.push({ message: `${where}: вкажіть кількість пар.`, index: i });
        else if (!/^\d+$/.test(raw)) out.push({ message: `${where}: кількість пар має бути цілим невід'ємним числом.`, index: i });
        else if (Number(raw) > 999) out.push({ message: `${where}: кількість пар завелика.`, index: i });
      } else if (type === 'NOT_BEFORE') {
        if (!r.from()) out.push({ message: `${where}: вкажіть час, раніше якого пар немає.`, index: i });
      } else if (type === 'NOT_AFTER') {
        if (!r.to()) out.push({ message: `${where}: вкажіть час, пізніше якого пар немає.`, index: i });
      } else {
        if (!r.from() || !r.to()) out.push({ message: `${where}: вкажіть початок і кінець проміжку.`, index: i });
        else if (r.from() >= r.to()) {
          out.push({ message: `${where}: кінець проміжку (${r.to()}) має бути пізнішим за початок (${r.from()}).`, index: i });
        }
      }

      // One row per (type, day) for the three single-valued kinds — the database enforces this
      // with a partial unique index, so catching it here saves a failed save.
      if (type !== 'UNAVAILABLE') {
        const key = `${type}|${day}`;
        const first = seen.get(key);
        if (first !== undefined) {
          out.push({ message: `${where}: «${TYPE_LABELS[type]}» задано двічі.`, index: i });
        } else {
          seen.set(key, i);
        }
      } else if (r.from() && r.to()) {
        const key = `U|${day}|${r.from()}-${r.to()}`;
        if (seen.has(key)) out.push({ message: `${where}: проміжок ${r.from()}–${r.to()} задано двічі.`, index: i });
        else seen.set(key, i);
      }
    });

    // A start-after later than a finish-by leaves no room for anything, on the same day or through
    // the every-day rule that applies to it.
    for (const day of ['', ...DAYS.map(String)]) {
      const nb = this.effective(rules, 'NOT_BEFORE', day);
      const na = this.effective(rules, 'NOT_AFTER', day);
      if (nb && na && nb.value >= na.value) {
        out.push({
          message: `${this.dayLabel(day)}: початок не раніше ${nb.value} суперечить закінченню не пізніше ${na.value}.`,
          index: nb.index
        });
      }
    }

    return out;
  }

  /**
   * The rule of `type` that actually applies on `day`: the day's own if it has one, otherwise the
   * every-day rule. Mirrors the "more specific wins" rule documented in schema.sql.
   */
  private effective(rules: Rule[], type: ConstraintType, day: string):
      { value: string; index: number } | null {
    let general: { value: string; index: number } | null = null;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.type() !== type) continue;
      const value = type === 'NOT_BEFORE' ? r.from() : r.to();
      if (!value) continue;
      if (r.day() === day && day !== '') return { value, index: i };
      if (r.day() === '') general = { value, index: i };
    }
    return general;
  }

  invalidRows(block: Block): Set<number> {
    return new Set(this.violations(block).map((v) => v.index));
  }

  hasViolations(block: Block): boolean {
    return this.violations(block).length > 0;
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  save(block: Block) {
    if (this.hasViolations(block)) {
      block.error.set('Виправте помилки перед збереженням.');
      return;
    }
    const m = this.meta;

    // The full desired set is sent: a rule that was removed is simply absent, which is what makes
    // the backend delete its row (see MutationDefinition#nestedList).
    const timetableConstraints = block.rules().map((r) => {
      const row: Record<string, any> = {
        constraintType: r.type(),
        constraintValue: this.serialize(r)
      };
      if (r.day() !== '') row['dayOfWeek'] = Number(r.day());
      if (r.id) row['id'] = r.id;
      return row;
    });

    const input = { ...m.required(block.node), timetableConstraints };
    const q = `mutation($id: ID!, $input: ${m.entity}InputPayload!) {
      ${m.namespace} { update${m.entity}(id: $id, ${m.single}: $input) { isSuccess errorStatus } } }`;

    block.saving.set(true);
    this.gql.request(q, { id: block.id, input }).subscribe({
      next: (d: any) => {
        const res = d[m.namespace][`update${m.entity}`];
        block.saving.set(false);
        if (res.isSuccess) this.load(block.id);
        else block.error.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => { block.saving.set(false); block.error.set(e.message); }
    });
  }

  /** The stored form of a rule — see timetable_constraint_type in schema.sql. */
  private serialize(r: Rule): string {
    switch (r.type()) {
      case 'MAX_CLASSES_PER_DAY': return String(Number(r.count().trim()));
      case 'NOT_BEFORE': return r.from();
      case 'NOT_AFTER': return r.to();
      default: return `${r.from()}-${r.to()}`;
    }
  }

  /** A one-line rendering of a rule, for the card header summary. */
  describe(r: Rule): string {
    const where = r.day() === '' ? 'щодня' : DAY_LABELS[Number(r.day())];
    switch (r.type()) {
      case 'MAX_CLASSES_PER_DAY': return `${where}: ≤ ${r.count() || '?'} пар`;
      case 'NOT_BEFORE': return `${where}: з ${r.from() || '?'}`;
      case 'NOT_AFTER': return `${where}: до ${r.to() || '?'}`;
      default: return `${where}: ✕ ${r.from() || '?'}–${r.to() || '?'}`;
    }
  }

  revert(block: Block) {
    this.load(block.id);
  }

  clear(block: Block) {
    block.rules.set([]);
    block.dirty.set(true);
    block.error.set('');
  }
}
