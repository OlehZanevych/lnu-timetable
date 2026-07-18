import { Directive, Input, OnChanges, OnInit, SimpleChanges, inject, signal } from '@angular/core';
import { GraphqlService } from './graphql.service';
import { EntityMeta, FieldMeta, entityBySingle, toOptions } from './entities';
import { Option } from './search-select';

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

  rows = signal<any[]>([]);
  options = signal<Record<string, Option[]>>({});
  editingId = signal<string | null>(null);
  showForm = signal(false);
  error = signal('');
  form: Record<string, any> = {};

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

  private filterClause(): string {
    const m = this.meta;
    const parts: string[] = [];
    if (m.filterParam && this._filterValue) parts.push(`${m.filterParam}: "${this._filterValue}"`);
    if (this.extraFilterParam && this._extraFilterValue) parts.push(`${this.extraFilterParam}: "${this._extraFilterValue}"`);
    return parts.length ? `, ${parts.join(', ')}` : '';
  }

  private refFields(): FieldMeta[] {
    return this.meta.fields.filter((f) => f.type === 'ref');
  }

  private selection(): string {
    const scalars = this.meta.fields.filter((f) => f.type !== 'ref' && f.type !== 'enum').map((f) => f.name);
    const enums = this.meta.fields.filter((f) => f.type === 'enum').map((f) => f.name);
    const relations = this.refFields().map((f) => `${f.relation} { id ${f.refLabel} }`);
    return ['id', ...scalars, ...enums, ...relations].join(' ');
  }

  load() {
    const m = this.meta;
    const filter = this.filterClause();
    const q = `{ ${m.namespace} { ${m.list}(limit: 1000, offset: 0${filter}) { nodes { ${this.selection()} } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.rows.set(d[m.namespace][m.list].nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadOptions() {
    for (const f of this.refFields()) {
      const r = entityBySingle(f.ref!);
      if (!r) continue;

      if (f.parentFilter) {
        // Load ref entities with their parent's info (e.g. departments with faculty { id name })
        const q = `{ ${r.namespace} { ${r.list}(limit: 1000) { nodes { id ${f.refLabel} faculty { id name } } } } }`;
        this.gql.request(q).subscribe((d: any) => {
          const opts = d[r.namespace][r.list].nodes.map((n: any) => ({
            id: n.id,
            label: n[f.refLabel!],
            facultyId: n.faculty?.id ?? '',
          }));
          this.options.update((o) => ({ ...o, [f.name]: opts }));
        });
        // Load parent entities (faculties) for the filter
        const pf = f.parentFilter;
        const pq = `{ ${pf.namespace} { ${pf.list}(limit: 1000) { nodes { id name } } } }`;
        this.gql.request(pq).subscribe((d: any) => {
          const opts: Option[] = d[pf.namespace][pf.list].nodes.map((n: any) => ({ id: n.id, label: n.name }));
          this.options.update((o) => ({ ...o, [f.name + '_parent']: opts }));
        });
      } else {
        const refFilterVal = this._refFilters[f.name];
        const extraFilter = refFilterVal && r.filterParam ? `, ${r.filterParam}: "${refFilterVal}"` : '';
        const q = `{ ${r.namespace} { ${r.list}(limit: 1000${extraFilter}) { nodes { id ${f.refLabel} } } } }`;
        this.gql.request(q).subscribe((d: any) => {
          const opts: Option[] = d[r.namespace][r.list].nodes.map((n: any) => ({ id: n.id, label: `${n[f.refLabel!]} (#${n.id})` }));
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

  display(row: any, f: FieldMeta): any {
    if (f.type === 'ref') return row[f.relation!] ? `${row[f.relation!][f.refLabel!]} (#${row[f.relation!].id})` : '—';
    if (f.type === 'enum') {
      const opt = f.enumOptions?.find((o) => o.value === row[f.name]);
      return opt ? opt.label : (row[f.name] ?? '—');
    }
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
      this.form[f.name] = f.type === 'ref' ? (row[f.relation!]?.id ?? '') : (row[f.name] ?? '');
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

  save() {
    const m = this.meta;
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
