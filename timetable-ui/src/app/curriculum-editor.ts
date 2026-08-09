import { Component, Input, OnChanges, OnInit, WritableSignal, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { GraphqlService } from './graphql.service';
import { GlobalPropertiesService } from './global-properties.service';
import { SearchSelect, Option } from './search-select';
import { CONTROL_FORM_OPTIONS, HOUR_TYPE_OPTIONS, toOptions } from './entities';
import { CurriculumSummary } from './curriculum-summary';
import { PlanHourType, PlanItemInput, buildCurriculumPlan } from './curriculum-plan';
import { compareUk } from './sort';
import { courseLabel } from './course-label';

/** Highest semester offerable in a plan. curriculum_items.semester is a plain INTEGER, so this is
 *  a UI-side bound only — 11 is the largest value present in real data (PhD plans). */
const MAX_SEMESTER = 12;

/**
 * Whether a course of the specialty is a component of its навчальний план in its own right.
 *
 * An `ELECTIVE` is not. It is one of the choices inside a `ELECTIVE_GROUP`, and the group is what
 * the plan reserves a slot for; which child fills that slot is decided a level down, on
 * `WorkingCurriculumItem.course`. Listing the children here put «Основи web програмування (пм)»
 * and its forty siblings on the page as top-level blocks marked «без позицій плану», burying the
 * components that actually are the plan under courses that structurally never can be.
 *
 * The rule is the course's own type rather than "has a parent course", so that it is the same rule
 * the database is cleaned by — see
 * `timetable/src/main/resources/db/migration/V1__delete_curriculum_items_on_elective_courses.sql`,
 * which removes the plan positions that should never have been attached to one. In the seeded data
 * the two readings coincide exactly: all 664 electives have a parent, and nothing else does.
 */
const isPlannable = (course: { courseType?: string }): boolean => course.courseType !== 'ELECTIVE';

/**
 * `courses.semester` as this page uses it: the one semester the course may be planned for, or null
 * when it may be planned for any — which is every course until somebody sets the column.
 *
 * Anything that is not a positive integer within the range the page can offer reads as "no
 * restriction". A course restricted to a semester this page cannot show would otherwise leave the
 * dropdown with nothing selectable and «+ Семестр» permanently disabled, i.e. a discipline nobody
 * can plan and no message saying why; ignoring the value instead leaves the page exactly as
 * useful as it was before the column existed.
 */
const fixedSemester = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SEMESTER ? n : null;
};

/**
 * One hour type's slot inside a semester block. Every semester block always carries one of these
 * per hour type (a fixed set of placeholder rows), whether or not a curriculum_item_hours row
 * actually exists — `id` is null until one does, and a blank/zero `hours` means "not set".
 */
interface HoursDraft {
  hourType: string;
  label: string;
  /** Existing curriculum_item_hours row id, or null when this type has no row. */
  id: string | null;
  hours: WritableSignal<string>;
}

/** One curriculum_items row (a "semester block") being edited inside a course block. */
interface ItemDraft {
  key: number;
  id: string | null;
  semester: WritableSignal<string>;
  controlForm: WritableSignal<string>;
  ectsCredits: WritableSignal<string>;
  /** Fixed-length, one entry per hour type, in HOUR_TYPE_OPTIONS order. Never grows or shrinks. */
  hours: HoursDraft[];
  dirty: WritableSignal<boolean>;
  saving: WritableSignal<boolean>;
  error: WritableSignal<string>;
}

/** A course of this specialty, with every curriculum item the specialty has for it. */
interface CourseBlock {
  courseId: string;
  /** Raw course name, used for sorting. */
  name: string;
  /** "Name (tag1, tag2)" — what the header shows. */
  label: string;
  /**
   * Raw `courses.course_type`. Not editable here — it belongs to the course, not to the plan — but
   * it is what sorts a component into обов'язкові / вибіркові and so decides the 25 % share the
   * summary above the page reports.
   */
  courseType: string;
  /**
   * `courses.semester`, or null for the great majority of courses. When set, this course is a
   * component of one semester and of no other: the block offers that semester and nothing else,
   * accepts a single position, and {@link validate} refuses anything that slipped past both.
   */
  semester: number | null;
  items: WritableSignal<ItemDraft[]>;
}

/**
 * Curriculum editor for a specialty: one block per course allowed for the specialty (via the
 * course_specialties join table), each holding its curriculum items as inline-editable semester
 * blocks, each of those holding a row per hour type.
 *
 * Sibling relationship to the other specialty subpages:
 *   - "Навчальні плани" (CurriculumItemList) is a flat table of the same curriculum_items, edited
 *     through a modal — good for scanning a whole plan, tedious for filling one course out. It
 *     carries the printable «Навчальний план»; this page carries only the summary strip they share.
 *   - "Редагування робочих планів" (WorkingCurriculumList) nests one level deeper still, hanging
 *     working_curriculum_items off each hours row. Its block markup is the visual model reused here.
 *   - "Робочі навчальні плани" (WorkingCurriculumView) reads those back as a document, per курс.
 *
 * Unlike both, this page is course-first: every course of the specialty is listed even when it has
 * no curriculum items yet, so gaps in the plan are visible rather than merely absent.
 *
 * No backend work is needed — createCurriculumItem/updateCurriculumItem already write the nested
 * `hours` list in one call (see CurriculumSchemaConfig's `.nestedList("hours", ...)`).
 */
@Component({
  selector: 'app-curriculum-editor',
  templateUrl: './curriculum-editor.html',
  imports: [FormsModule, RouterLink, SearchSelect, CurriculumSummary]
})
export class CurriculumEditor implements OnInit, OnChanges {
  private gql = inject(GraphqlService);
  private settings = inject(GlobalPropertiesService);

  @Input() specialtyId!: string;
  /**
   * Raw `specialties.degree`. A signal, not a plain field, because {@link plan} reads it inside a
   * `computed()` — see the zoneless note in the README.
   */
  @Input() set degree(value: string | null) { this.degreeSignal.set(value ?? ''); }

  readonly CONTROL_FORM_OPTIONS = CONTROL_FORM_OPTIONS;
  readonly HOUR_TYPE_OPTIONS = HOUR_TYPE_OPTIONS;
  readonly CONTROL_FORM_SELECT_OPTIONS = toOptions(CONTROL_FORM_OPTIONS);

  blocks = signal<CourseBlock[]>([]);
  error = signal('');
  loading = signal(false);

  /** Free-text course-name filter — a specialty can have 200+ courses. */
  courseFilter = signal('');

  /** Hides courses that have no curriculum items yet. */
  onlyPlanned = signal(false);

  visibleBlocks = computed(() => {
    const q = this.courseFilter().trim().toLowerCase();
    const plannedOnly = this.onlyPlanned();
    return this.blocks().filter((b) => {
      if (plannedOnly && b.items().length === 0) return false;
      return !q || b.label.toLowerCase().includes(q);
    });
  });

  plannedCount = computed(() => this.blocks().filter((b) => b.items().length > 0).length);

  private degreeSignal = signal('');

  /**
   * The same освітня програма the "Навчальні плани" tab summarises and the printed «Навчальний
   * план» is built from — but computed from the **drafts on screen**, unsaved edits included.
   *
   * That is the point of showing it here: the 25 % частка вибіркових and the programme volume move
   * as fields are typed into, so a plan can be brought within ст. 5 and ст. 62 before anything is
   * written. It works only because every editable value is its own signal (see the zoneless note in
   * the README) — a `computed()` over plain fields would memoise the first value it ever read.
   */
  plan = computed(() => {
    const items: PlanItemInput[] = [];
    for (const block of this.blocks()) {
      for (const draft of block.items()) {
        const semester = Number(draft.semester());
        if (!Number.isFinite(semester) || semester <= 0) continue;   // a block with no semester yet
        const hours: Partial<Record<PlanHourType, number>> = {};
        for (const row of draft.hours) {
          const n = Number(row.hours().trim());
          if (Number.isFinite(n) && n > 0) hours[row.hourType as PlanHourType] = n;
        }
        const credits = Number(draft.ectsCredits());
        items.push({
          id: draft.id ?? `draft-${draft.key}`,
          semester,
          controlForm: draft.controlForm(),
          ectsCredits: Number.isFinite(credits) && credits > 0 ? credits : 0,
          course: { id: block.courseId, name: block.name, courseType: block.courseType, semester: block.semester },
          hours
        });
      }
    }
    return buildCurriculumPlan(items, this.degreeSignal(), this.settings.limits());
  });

  /** True while any block on the page carries unsaved edits — the summary says so when it does. */
  hasUnsaved = computed(() =>
    this.blocks().some((b) => b.items().some((i) => i.dirty())));

  private nextKey = 1;
  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    this.settings.ensureLoaded();
    if (this.specialtyId) this.load();
  }

  ngOnChanges() {
    if (this.initialized && this.specialtyId) this.load();
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  /**
   * Rebuilds every course block from the server. Blocks with unsaved edits are kept as they are
   * (apart from `keepCourseId`, the one just saved) so that saving one course doesn't silently
   * discard work in progress elsewhere on the page.
   */
  private load(keepCourseId: string | null = null) {
    if (!this.specialtyId) return;
    this.loading.set(true);

    // courseType comes along for the summary above the page: it is what tells обов'язкові from
    // вибіркові, and so what the 25 % of ст. 62 ч. 1 п. 15 is measured on.
    const coursesQuery = `query($specialtyId: ID, $limit: Int!, $offset: Int!) { courses { courseConnection(limit: $limit, offset: $offset, specialtyId: $specialtyId) {
      nodes { id name courseType semester tags { tag } }
    } } }`;
    // ELECTIVE courses are deliberately not among them — see `isPlannable`.
    const itemsQuery = `query($specialtyId: ID, $limit: Int!, $offset: Int!) { curriculumItems { curriculumItemConnection(limit: $limit, offset: $offset, specialtyId: $specialtyId) {
      nodes { id semester controlForm ectsCredits course { id } hours { id hourType hours } }
    } } }`;

    forkJoin({
      courses: this.gql.request(coursesQuery, { specialtyId: this.specialtyId, limit: 1000, offset: 0 }),
      items: this.gql.request(itemsQuery, { specialtyId: this.specialtyId, limit: 1000, offset: 0 })
    }).subscribe({
      next: ({ courses, items }: any) => {
        const dirtyBefore = new Map<string, CourseBlock>();
        for (const b of this.blocks()) {
          if (b.courseId !== keepCourseId && b.items().some((i) => i.dirty())) dirtyBefore.set(b.courseId, b);
        }

        const byCourse = new Map<string, any[]>();
        for (const node of items.curriculumItems.curriculumItemConnection.nodes) {
          const courseId = node.course?.id;
          if (!courseId) continue;
          const list = byCourse.get(courseId) ?? [];
          list.push(node);
          byCourse.set(courseId, list);
        }

        const blocks: CourseBlock[] = courses.courses.courseConnection.nodes
          .filter(isPlannable)
          .map((c: any) => {
          const preserved = dirtyBefore.get(c.id);
          if (preserved) return preserved;
          const drafts = (byCourse.get(c.id) ?? [])
            .sort((a, b) => (a.semester ?? 0) - (b.semester ?? 0))
            .map((node) => this.toItemDraft(node));
          return {
            courseId: c.id,
            name: c.name,
            label: courseLabel(c.name, c.tags, c.semester),
            courseType: c.courseType ?? 'MANDATORY',
            semester: fixedSemester(c.semester),
            items: signal<ItemDraft[]>(drafts)
          };
        });

        this.blocks.set(this.sortBlocks(blocks));
        this.error.set('');
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(e.message);
        this.loading.set(false);
      }
    });
  }

  private toItemDraft(node: any): ItemDraft {
    const existing = new Map<string, any>();
    for (const h of node.hours ?? []) existing.set(h.hourType, h);
    return {
      key: this.nextKey++,
      id: node.id,
      semester: signal(node.semester != null ? String(node.semester) : ''),
      controlForm: signal(node.controlForm ?? ''),
      ectsCredits: signal(node.ectsCredits != null ? String(node.ectsCredits) : ''),
      hours: this.blankHours(existing),
      dirty: signal(false),
      saving: signal(false),
      error: signal('')
    };
  }

  /** One slot per hour type, in a fixed order, pre-filled from any rows the item already has. */
  private blankHours(existing?: Map<string, any>): HoursDraft[] {
    return this.HOUR_TYPE_OPTIONS.map((opt) => {
      const row = existing?.get(opt.value);
      return {
        hourType: opt.value,
        label: opt.label,
        id: row?.id ?? null,
        hours: signal(row?.hours != null ? String(row.hours) : '')
      };
    });
  }

  /**
   * Courses with no curriculum items yet come first, alphabetically — they are what still needs
   * planning. Everything else is ordered by its earliest semester, ties broken by course name.
   */
  private sortBlocks(blocks: CourseBlock[]): CourseBlock[] {
    return blocks.slice().sort((a, b) => {
      const sa = this.minSemester(a);
      const sb = this.minSemester(b);
      if (sa === null && sb === null) return this.compareNames(a, b);
      if (sa === null) return -1;
      if (sb === null) return 1;
      return sa - sb || this.compareNames(a, b);
    });
  }

  private compareNames(a: CourseBlock, b: CourseBlock): number {
    return compareUk(a.name, b.name);
  }

  /** Lowest semester among a course's items, or null when it has none. */
  private minSemester(block: CourseBlock): number | null {
    let min: number | null = null;
    for (const item of block.items()) {
      const n = Number(item.semester());
      if (!Number.isFinite(n) || n <= 0) continue;
      if (min === null || n < min) min = n;
    }
    return min;
  }

  // ── Labels ───────────────────────────────────────────────────────────────

  itemTitle(item: ItemDraft): string {
    const s = item.semester();
    return s ? `Семестр ${s}` : 'Новий семестр';
  }

  // ── Option lists ─────────────────────────────────────────────────────────

  /**
   * Semesters selectable for a block: everything from 1..MAX_SEMESTER that no sibling block already
   * uses, plus the block's own current value. Excluding taken semesters here is what enforces
   * "no two blocks with the same semester" — save() re-checks it, since two blocks can both be
   * new and unsaved at once.
   *
   * A course with `courses.semester` set offers **that semester and nothing else**. It is a
   * discipline of one semester, and every position naming it belongs there; the point of the
   * column is that the wrong value stops being reachable rather than being caught afterwards.
   *
   * The one addition is the block's own stored value when it disagrees — a position written before
   * the course was restricted. It stays on the list, marked, because an edit form must never
   * silently drop a value the database holds (the same rule the «Навчальні плани» discipline picker
   * follows for an elective it is already editing). Choosing it again is possible; choosing a
   * *third* semester is not, which is what makes the mismatch something you correct rather than
   * something you can spread.
   */
  semesterOptions(block: CourseBlock, item: ItemDraft): Option[] {
    const own = item.semester();
    if (block.semester !== null) {
      const fixed = String(block.semester);
      const opts: Option[] = [{ id: fixed, label: `Семестр ${block.semester}` }];
      if (own && own !== fixed) opts.push({ id: own, label: `Семестр ${own} — не відповідає дисципліні` });
      return opts;
    }

    const taken = new Set<string>();
    for (const sibling of block.items()) {
      if (sibling.key !== item.key && sibling.semester()) taken.add(sibling.semester());
    }
    const opts: Option[] = [];
    for (let n = 1; n <= MAX_SEMESTER; n++) {
      const v = String(n);
      if (!taken.has(v) || v === own) opts.push({ id: v, label: `Семестр ${n}` });
    }
    return opts;
  }

  /**
   * True once every semester 1..MAX_SEMESTER is used by this course — nothing left to add. A course
   * restricted to one semester has exactly one position to give, so the button closes after it.
   */
  canAddItem(block: CourseBlock): boolean {
    if (block.semester !== null) return block.items().length === 0;
    return block.items().length < MAX_SEMESTER;
  }

  /** The block's own restriction, for the template — «лише семестр N» beside the course name. */
  fixedSemesterOf(block: CourseBlock): number | null {
    return block.semester;
  }

  /** A stored position sitting in a semester its course is no longer allowed in. */
  isOffSemester(block: CourseBlock, item: ItemDraft): boolean {
    const own = item.semester();
    return block.semester !== null && !!own && Number(own) !== block.semester;
  }

  // ── Editing ──────────────────────────────────────────────────────────────

  setField(item: ItemDraft, field: 'semester' | 'controlForm' | 'ectsCredits', value: any) {
    item[field].set(value == null ? '' : String(value));
    this.touch(item);
  }

  setHours(item: ItemDraft, row: HoursDraft, value: any) {
    row.hours.set(value == null ? '' : String(value));
    this.touch(item);
  }

  private touch(item: ItemDraft) {
    item.dirty.set(true);
    item.error.set('');
  }

  addItem(block: CourseBlock) {
    if (!this.canAddItem(block)) return;
    const draft: ItemDraft = {
      key: this.nextKey++,
      id: null,
      semester: signal(this.firstFreeSemester(block)),
      controlForm: signal(''),
      ectsCredits: signal(''),
      hours: this.blankHours(),
      dirty: signal(true),
      saving: signal(false),
      error: signal('')
    };
    block.items.set([...block.items(), draft]);
  }

  private firstFreeSemester(block: CourseBlock): string {
    if (block.semester !== null) return String(block.semester);
    const taken = new Set(block.items().map((i) => i.semester()));
    for (let n = 1; n <= MAX_SEMESTER; n++) {
      if (!taken.has(String(n))) return String(n);
    }
    return '';
  }

  /** Drops an unsaved block outright; a persisted one is deleted server-side. */
  removeItem(block: CourseBlock, item: ItemDraft) {
    if (!item.id) {
      block.items.set(block.items().filter((i) => i.key !== item.key));
      return;
    }
    item.saving.set(true);
    const q = `mutation($id: ID!) { curriculumItems { deleteCurriculumItem(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: item.id }).subscribe({
      next: (d: any) => {
        const res = d.curriculumItems.deleteCurriculumItem;
        item.saving.set(false);
        if (res.isSuccess) this.load(block.courseId);
        else item.error.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => { item.saving.set(false); item.error.set(e.message); }
    });
  }

  /** Reverts one block to its persisted state (or removes it, if it was never saved). */
  revertItem(block: CourseBlock, item: ItemDraft) {
    if (!item.id) {
      block.items.set(block.items().filter((i) => i.key !== item.key));
      return;
    }
    // Pass this course id so load() rebuilds *this* block from the server rather than preserving
    // it as "dirty" — discarding the edits is exactly the point here.
    this.load(block.courseId);
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  save(block: CourseBlock, item: ItemDraft) {
    const problem = this.validate(block, item);
    if (problem) { item.error.set(problem); return; }

    const input: Record<string, any> = {
      specialtyId: this.specialtyId,
      courseId: block.courseId,
      semester: Number(item.semester()),
      controlForm: item.controlForm(),
      hours: this.buildHoursInput(item)
    };
    const ects = item.ectsCredits();
    if (ects !== '') input['ectsCredits'] = Number(ects);

    const id = item.id;
    const op = id ? 'updateCurriculumItem' : 'createCurriculumItem';
    const q = id
      ? `mutation($id: ID!, $input: CurriculumItemInputPayload!) { curriculumItems { ${op}(id: $id, curriculumItem: $input) { isSuccess errorStatus } } }`
      : `mutation($input: CurriculumItemInputPayload!) { curriculumItems { ${op}(curriculumItem: $input) { isSuccess errorStatus } } }`;

    item.saving.set(true);
    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = d.curriculumItems[op];
        item.saving.set(false);
        if (res.isSuccess) {
          // Reload so the new row gets its real id (and its hours rows theirs), and so the course
          // block re-sorts into place if its lowest semester changed.
          this.load(block.courseId);
        } else {
          item.error.set(res.errorStatus === 'DUPLICATED_KEY'
            ? 'Для цієї дисципліни вже існує позиція з таким семестром.'
            : (res.errorStatus || 'Помилка операції'));
        }
      },
      error: (e) => { item.saving.set(false); item.error.set(e.message); }
    });
  }

  /**
   * Only hour types with a value above zero are sent. A blank or 0 field is "not set": for a type
   * that has no row yet nothing is created, and for one that does, leaving it out of the nested
   * `hours` list is what makes the backend delete it (see CurriculumSchemaConfig's
   * `.nestedList("hours", ...)` reconciliation — omitted entries are treated as removed).
   */
  private buildHoursInput(item: ItemDraft): Record<string, any>[] {
    const rows: Record<string, any>[] = [];
    for (const h of item.hours) {
      const n = this.hoursValue(h);
      if (n <= 0) continue;
      const row: Record<string, any> = { hourType: h.hourType, hours: n };
      // Reuse the existing row id so the backend updates that row instead of inserting a second
      // one for the same (curriculum_item_id, hour_type) — which UNIQUE would reject anyway.
      if (h.id) row['id'] = h.id;
      rows.push(row);
    }
    return rows;
  }

  /** A blank field reads as 0, i.e. "not set". */
  private hoursValue(row: HoursDraft): number {
    const raw = row.hours().trim();
    if (raw === '') return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  }

  /**
   * Duplicate semesters are already unreachable through the dropdown, but two *new* blocks can be
   * added before either is saved — so the check is repeated here rather than trusted. The database
   * backs it up with UNIQUE (course_id, specialty_id, semester).
   */
  private validate(block: CourseBlock, item: ItemDraft): string {
    if (!item.semester()) return 'Оберіть семестр.';
    if (!item.controlForm()) return 'Оберіть форму контролю.';

    const semester = item.semester();
    if (block.items().some((i) => i.key !== item.key && i.semester() === semester)) {
      return `Семестр ${semester} для цієї дисципліни вже додано.`;
    }
    // The dropdown already offers nothing else, so this only fires on a position stored before the
    // course was restricted — which is exactly the case that must not be re-saved as it stands.
    if (block.semester !== null && Number(semester) !== block.semester) {
      return `Цю дисципліну можна планувати лише на семестр ${block.semester}.`;
    }

    for (const h of item.hours) {
      const n = this.hoursValue(h);
      if (Number.isNaN(n) || n < 0) return `Некоректна кількість годин для «${h.label}».`;
    }
    return '';
  }

  // ── Display helpers ──────────────────────────────────────────────────────

  /** Total hours across an item's rows — shown in the block header as a sanity check. */
  totalHours(item: ItemDraft): number {
    return item.hours.reduce((sum, h) => {
      const n = this.hoursValue(h);
      return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
  }

  /** Marks a field whose current value would drop an hours row that exists on the server. */
  willDelete(row: HoursDraft): boolean {
    return row.id !== null && this.hoursValue(row) <= 0;
  }
}
