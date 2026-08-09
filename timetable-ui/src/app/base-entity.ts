import { Directive, Input, OnChanges, OnInit, SimpleChanges, computed, inject, signal } from '@angular/core';
import { GqlVars, GraphqlService } from './graphql.service';
import { EntityMeta, FieldMeta, entityBySingle, toOptions } from './entities';
import { Option } from './search-select';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { toResourceType } from './resource-type';

/** Shared CRUD logic for every entity page. Subclasses only provide `meta`. */
@Directive()
export abstract class BaseEntity implements OnInit, OnChanges {
  abstract meta: EntityMeta;

  /**
   * When set, appends `meta.filterParam: filterValue` to the connection query.
   * Changing this value triggers an automatic reload.
   */
  @Input()
  set filterValue(val: string | null | undefined) {
    this._filterValue = val ?? null;
    if (this.initialized) this.load();
  }
  get filterValue(): string | null { return this._filterValue; }
  private _filterValue: string | null = null;

  /**
   * An additional, always-on filter argument name for the connection query (e.g. "facultyId"),
   * combined with {@link extraFilterValue}. Unlike filterValue/meta.filterParam — which is
   * typically an optional user-facing sub-filter — this is meant for a fixed scope the host page
   * always wants applied (e.g. courses always scoped to the current faculty, regardless of the
   * optional department sub-filter on the same list). Only takes effect if the entity's
   * connection query actually declares a matching backend filter argument.
   */
  @Input() extraFilterParam: string | null = null;

  @Input()
  set extraFilterValue(val: string | null | undefined) {
    this._extraFilterValue = val ?? null;
    if (this.initialized) this.load();
  }
  get extraFilterValue(): string | null { return this._extraFilterValue; }
  private _extraFilterValue: string | null = null;

  /**
   * A free-text narrowing of the rows already loaded, for host pages that want a search box.
   *
   * Client-side and deliberately so. The connection is fetched once with `limit: 1000` and no
   * paging, so within a scope every candidate row is already here; a round trip per keystroke would
   * be slower than the filter it replaces. It also needs no backend support — a `.filter` argument
   * is an equality on a column, which is not what "find the discipline whose name contains this" is.
   *
   * What it searches is exactly what the table shows: every visible cell, rendered through
   * `display()`. So a search matches the ref labels and tag text a reader can see, and cannot match
   * a column that was hidden by `presets`.
   */
  @Input()
  set search(val: string | null | undefined) { this._search.set((val ?? '').trim()); }
  get search(): string { return this._search(); }
  private _search = signal('');

  /** The rows after {@link search}; what the table renders. */
  visibleRows = computed(() => {
    const q = this._search().toLocaleLowerCase('uk');
    if (!q) return this.rows();
    return this.rows().filter((row) => this.rowText(row).includes(q));
  });

  /** Whether the search box, rather than an empty scope, is why nothing is listed. */
  filteredToNothing = computed(() =>
    !!this._search() && this.rows().length > 0 && this.visibleRows().length === 0);

  private rowText(row: any): string {
    return this.tableFields
      .map((f) => {
        const v = this.display(row, f);
        return v === null || v === undefined ? '' : String(v);
      })
      .join(' ')
      .toLocaleLowerCase('uk');
  }

  /**
   * Key/value pairs pre-filled into the create form when openCreate() is called.
   * Useful for pre-selecting a parent entity (e.g. { facultyId: '1' }).
   */
  @Input() presets: Record<string, string> = {};

  /**
   * Scopes the option list for specific ref fields.
   * Key = field name (e.g. 'academicGroupId'), value = the filter value to pass.
   * The referenced entity's filterParam is used as the GraphQL argument name.
   * Changing this triggers a reload of the affected options.
   */
  @Input()
  set refFilters(val: Record<string, string>) {
    const prev = JSON.stringify(this._refFilters);
    this._refFilters = val ?? {};
    if (this.initialized && JSON.stringify(this._refFilters) !== prev) {
      this.loadOptions();
    }
  }
  get refFilters(): Record<string, string> { return this._refFilters; }
  private _refFilters: Record<string, string> = {};

  protected gql = inject(GraphqlService);
  protected auth = inject(AuthService);

  rows = signal<any[]>([]);
  options = signal<Record<string, Option[]>>({});
  editingId = signal<string | null>(null);
  showForm = signal(false);
  error = signal('');
  form: Record<string, any> = {};

  /** The current user's access level per row id of this page's entity type; absent means none. */
  accessById = signal<Map<string, AccessLevel>>(new Map());

  /** Whether the "+ Add" control should be shown at all — a coarse, cheap heuristic (any admin or
   *  any delegated permission at all); the actual create mutation is still authoritatively checked
   *  server-side regardless, so this only ever hides the button, never grants access. */
  get canShowCreate(): boolean {
    return this.auth.isAdmin() || (this.auth.currentUser()?.permissions?.length ?? 0) > 0;
  }

  /**
   * The route to a row's own page, or null when this entity has none. Declared once per entity in
   * `entities.ts`, so every table of it — the standalone table page and every embedding on a faculty
   * or department page alike — offers the same «Відкрити →».
   */
  detailLink(row: any): any[] | null {
    return this.meta.detailRoute ? ['/' + this.meta.detailRoute, row.id] : null;
  }

  /** The level this user holds on a row — their university-wide grant, or the row's own, whichever is higher. */
  levelOf(row: any): AccessLevel | null {
    return maxLevel(this.auth.globalLevel(), this.accessById().get(String(row.id)));
  }

  canEdit(row: any): boolean {
    return allows(this.levelOf(row), 'EDIT');
  }

  /**
   * Deleting needs FULL, not EDIT. This is the one place the split is visible to a user: somebody
   * who maintains this table every day sees «Редагувати» without «Видалити» beside it, and cannot
   * remove a row — with everything under it — by mis-clicking.
   */
  canDelete(row: any): boolean {
    return allows(this.levelOf(row), 'FULL');
  }

  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    this.load();
    this.loadOptions();
  }

  ngOnChanges(changes: SimpleChanges) {
    // filterValue changes are handled by the setter; only re-trigger if not already handled
    // presets changes do not need a reload — they only affect the create form
  }

  /**
   * The two optional scope filters, as arguments naming variables. Which of them apply is decided
   * here, so the *argument names* are metadata (`meta.filterParam` is `facultyId` on one entity and
   * `departmentId` on another) while the values they carry are not: each is bound to a variable of
   * its own, named for the parameter it fills.
   */
  private filterClause(v: GqlVars): string {
    const m = this.meta;
    const parts: string[] = [];
    if (m.filterParam && this._filterValue) parts.push(`${m.filterParam}: ${v.ref(m.filterParam, 'ID', this._filterValue)}`);
    if (this.extraFilterParam && this._extraFilterValue) parts.push(`${this.extraFilterParam}: ${v.ref(this.extraFilterParam, 'ID', this._extraFilterValue)}`);
    return parts.length ? `, ${parts.join(', ')}` : '';
  }

  /** Single-value ref fields AND many-to-many multiref fields — both are backed by an options
   *  list loaded from the referenced entity (see loadOptions). */
  private refFields(): FieldMeta[] {
    return this.meta.fields.filter((f) => f.type === 'ref' || f.type === 'multiref');
  }

  private tagFields(): FieldMeta[] {
    return this.meta.fields.filter((f) => f.type === 'tags');
  }

  private selection(): string {
    const scalars = this.meta.fields
      .filter((f) => f.type !== 'ref' && f.type !== 'enum' && f.type !== 'multiref' && f.type !== 'tags')
      .map((f) => f.name);
    const enums = this.meta.fields.filter((f) => f.type === 'enum').map((f) => f.name);
    const relations = this.refFields().map((f) => `${f.relation} { id ${f.refLabel} }`);
    const tagRelations = this.tagFields().map((f) => `${f.relation} { id ${f.tagField} }`);
    return ['id', ...scalars, ...enums, ...relations, ...tagRelations].join(' ');
  }

  load() {
    const m = this.meta;
    const v = new GqlVars();
    const paging = `${v.arg('limit', 'Int!', 1000)}, ${v.arg('offset', 'Int!', 0)}`;
    const filter = this.filterClause(v);
    const q = `${v.declaration()}{ ${m.namespace} { ${m.list}(${paging}${filter}) { nodes { ${this.selection()} } } } }`;
    this.gql.request(q, v.values).subscribe({
      next: (d: any) => {
        const nodes = d[m.namespace][m.list].nodes;
        this.rows.set(nodes);
        this.loadAccessLevels(nodes);
      },
      error: (e) => this.error.set(e.message)
    });
  }

  /** Batched permission check for every loaded row's edit/delete buttons — see AuthService#accessLevels. */
  private loadAccessLevels(rows: any[]) {
    // A university-wide MANAGE grant already answers every row; anything weaker still has to ask,
    // because a grant on an individual row can be stronger than the global one.
    if (this.auth.globalLevel() === 'MANAGE' || rows.length === 0) return;
    const resourceType = toResourceType(this.meta.name);
    this.auth.accessLevels(resourceType, rows.map((r) => String(r.id)))
      .subscribe((levels) => this.accessById.set(levels));
  }

  private loadOptions() {
    for (const f of this.refFields()) {
      const r = entityBySingle(f.ref!);
      if (!r) continue;

      if (f.parentFilter) {
        // Load ref entities with their parent's info (e.g. departments with faculty { id name })
        const v = new GqlVars();
        const limit = v.arg('limit', 'Int!', 1000);
        const q = `${v.declaration()}{ ${r.namespace} { ${r.list}(${limit}) { nodes { id ${f.refLabel} faculty { id name } } } } }`;
        this.gql.request(q, v.values).subscribe((d: any) => {
          const opts = d[r.namespace][r.list].nodes.map((n: any) => ({
            id: n.id,
            label: n[f.refLabel!],
            facultyId: n.faculty?.id ?? '',
          }));
          this.options.update((o) => ({ ...o, [f.name]: opts }));
        });
        // Load parent entities (faculties) for the filter
        const pf = f.parentFilter;
        const pv = new GqlVars();
        const pLimit = pv.arg('limit', 'Int!', 1000);
        const pq = `${pv.declaration()}{ ${pf.namespace} { ${pf.list}(${pLimit}) { nodes { id name } } } }`;
        this.gql.request(pq, pv.values).subscribe((d: any) => {
          const opts: Option[] = d[pf.namespace][pf.list].nodes.map((n: any) => ({ id: n.id, label: n.name }));
          this.options.update((o) => ({ ...o, [f.name + '_parent']: opts }));
        });
      } else {
        const refFilterVal = this._refFilters[f.name];
        const v = new GqlVars();
        const limit = v.arg('limit', 'Int!', 1000);
        const extraFilter = refFilterVal && r.filterParam
          ? `, ${r.filterParam}: ${v.ref(r.filterParam, 'ID', refFilterVal)}` : '';
        const q = `${v.declaration()}{ ${r.namespace} { ${r.list}(${limit}${extraFilter}) { nodes { id ${f.refLabel} } } } }`;
        this.gql.request(q, v.values).subscribe((d: any) => {
          const opts: Option[] = d[r.namespace][r.list].nodes.map((n: any) => ({ id: n.id, label: n[f.refLabel!] }));
          this.options.update((o) => ({ ...o, [f.name]: opts }));
        });
      }
    }
  }

  /** Fields shown in the table (excludes columns whose value is preset/fixed by context). */
  get tableFields(): FieldMeta[] {
    return this.meta.fields.filter((f) => !this.presets[f.name]);
  }

  /** Options for an enum field's app-search-select, in {id, label} shape. */
  enumOptions(f: FieldMeta): Option[] {
    return toOptions(f.enumOptions || []);
  }

  /**
   * The route to the entity a `ref` column points at, or null when that entity has no page of its
   * own (or the column is empty). The cell used to print the referenced row's database id beside
   * its name — «Дискретна математика (#42)» — which is the only thing that told two same-named rows
   * apart and the only way to get from one to the other. A link does both, and does the second one
   * properly: the id was never something to be read, only something to be looked up.
   */
  refLink(row: any, f: FieldMeta): any[] | null {
    if (f.type !== 'ref' || !f.ref) return null;
    const target = row[f.relation!];
    const meta = entityBySingle(f.ref);
    return target && meta?.detailRoute ? ['/' + meta.detailRoute, target.id] : null;
  }

  display(row: any, f: FieldMeta): any {
    if (f.type === 'ref') return row[f.relation!] ? row[f.relation!][f.refLabel!] : '—';
    if (f.type === 'multiref') return (row[f.relation!] ?? []).map((x: any) => x[f.refLabel!]).join(', ') || '—';
    if (f.type === 'tags') return (row[f.relation!] ?? []).map((x: any) => x[f.tagField!]).join(', ') || '—';
    if (f.type === 'enum') {
      const opt = f.enumOptions?.find((o) => o.value === row[f.name]);
      return opt ? opt.label : (row[f.name] ?? '—');
    }
    // A false flag reads better as a blank cell than as "Ні" repeated down the column: the point of
    // the column is to show which row *is* the default one.
    if (f.type === 'boolean') return row[f.name] ? 'Так' : '';
    return row[f.name] ?? '—';
  }

  openCreate() {
    this.reset();
    Object.assign(this.form, this.presets);
    this.showForm.set(true);
  }

  edit(row: any) {
    this.editingId.set(row.id);
    this.form = {};
    for (const f of this.meta.fields) {
      if (f.type === 'ref') this.form[f.name] = row[f.relation!]?.id ?? '';
      else if (f.type === 'multiref') this.form[f.name] = (row[f.relation!] ?? []).map((x: any) => String(x.id));
      else if (f.type === 'tags') this.form[f.name] = (row[f.relation!] ?? []).map((x: any) => x[f.tagField!]).join(', ');
      // Not `?? ''`: a checkbox needs a real boolean, and '' would also be read as "empty" by
      // buildInput and dropped, so unticking a box would never reach the server.
      else if (f.type === 'boolean') this.form[f.name] = !!row[f.name];
      else this.form[f.name] = row[f.name] ?? '';
    }
    this.error.set('');
    this.showForm.set(true);
  }

  reset() {
    this.editingId.set(null);
    this.form = {};
    this.error.set('');
    this.showForm.set(false);
  }

  private buildInput(): Record<string, any> {
    const input: Record<string, any> = {};
    const isUpdate = this.editingId() !== null;
    for (const f of this.meta.fields) {
      const v = this.form[f.name];

      // Many-to-many id lists and tag lists are always sent in full (an empty array clears the
      // relation) rather than following the generic "omit when empty" rule below — see
      // MutationDefinition#manyToMany / #nestedList: omitting the field entirely leaves existing
      // rows untouched, which isn't what a cleared multi-select/tag input in the form means.
      if (f.type === 'multiref') {
        input[f.name] = Array.isArray(v) ? v : [];
        continue;
      }
      if (f.type === 'tags') {
        input[f.name] = String(v ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .map((tag) => ({ [f.tagField!]: tag }));
        continue;
      }

      // An unticked checkbox is a value, not an absence — it has to be sent as `false`, otherwise
      // a set could be made the default but never un-made.
      if (f.type === 'boolean') {
        input[f.name] = !!v;
        continue;
      }

      const empty = v === undefined || v === null || v === '';
      if (empty) {
        // Editing an existing row: send an explicit null for cleared optional fields (e.g.
        // removing a "Група вибіркових" parent course) so the backend clears the column instead
        // of leaving it untouched. Creating: nothing to clear yet, so just omit the field.
        if (isUpdate && !f.required) input[f.name] = null;
        continue;
      }
      input[f.name] = f.type === 'number' ? Number(v) : v;
    }
    return input;
  }

  /**
   * The one thing this form checks beyond «обов'язкове поле»: a number outside the range its column
   * accepts.
   *
   * It is here rather than on the input because `min`/`max` attributes alone do nothing — Angular
   * puts `novalidate` on the forms it manages, so the browser never enforces them — and because of
   * what the server does with the value if it gets through: a `CHECK` violation and a missing
   * foreign key both arrive as `DataIntegrityViolationException`, and the generic handler reports
   * either as the entity's `…_NOT_FOUND` status (see the service README's *Known limitations*). So
   * «Семестр: 0» on a discipline would come back as "a referenced entity does not exist", which
   * names the wrong problem entirely. Refusing it here is what keeps that limitation confined to
   * callers who bypass the UI.
   */
  private validate(): string {
    for (const f of this.meta.fields) {
      if (f.type !== 'number') continue;
      const raw = this.form[f.name];
      if (raw === undefined || raw === null || raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) return `Некоректне число в полі «${f.label}».`;
      if (f.min !== undefined && n < f.min) return `«${f.label}»: не менше ${f.min}.`;
      if (f.max !== undefined && n > f.max) return `«${f.label}»: не більше ${f.max}.`;
    }
    return '';
  }

  save() {
    const m = this.meta;
    const problem = this.validate();
    if (problem) { this.error.set(problem); return; }
    const input = this.buildInput();
    const id = this.editingId();
    const op = id ? `update${m.name}` : `create${m.name}`;
    const q = id
      ? `mutation($id: ID!, $input: ${m.name}InputPayload!) { ${m.namespace} { ${op}(id: $id, ${m.single}: $input) { isSuccess errorStatus } } }`
      : `mutation($input: ${m.name}InputPayload!) { ${m.namespace} { ${op}(${m.single}: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = d[m.namespace][op];
        if (res.isSuccess) { this.reset(); this.load(); }
        else this.error.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.error.set(e.message)
    });
  }

  remove(row: any) {
    const m = this.meta;
    const q = `mutation($id: ID!) { ${m.namespace} { delete${m.name}(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: row.id }).subscribe({
      next: (d: any) => {
        const res = d[m.namespace][`delete${m.name}`];
        if (res.isSuccess) this.load();
        else this.error.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.error.set(e.message)
    });
  }
}
