import { Directive, OnInit, inject, signal } from '@angular/core';
import { GraphqlService } from './graphql.service';
import { EntityMeta, FieldMeta, entityBySingle } from './entities';
import { Option } from './search-select';

/** Shared CRUD logic for every entity page. Subclasses only provide `meta`. */
@Directive()
export abstract class BaseEntity implements OnInit {
  abstract meta: EntityMeta;

  protected gql = inject(GraphqlService);

  rows = signal<any[]>([]);
  options = signal<Record<string, Option[]>>({});
  editingId = signal<string | null>(null);
  showForm = signal(false);
  error = signal('');
  form: Record<string, any> = {};

  ngOnInit() {
    this.load();
    this.loadOptions();
  }

  private refFields(): FieldMeta[] {
    return this.meta.fields.filter((f) => f.type === 'ref');
  }

  private selection(): string {
    const scalars = this.meta.fields.filter((f) => f.type !== 'ref').map((f) => f.name);
    const relations = this.refFields().map((f) => `${f.relation} { id ${f.refLabel} }`);
    return ['id', ...scalars, ...relations].join(' ');
  }

  load() {
    const m = this.meta;
    const q = `{ ${m.namespace} { ${m.list}(limit: 1000, offset: 0) { nodes { ${this.selection()} } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.rows.set(d[m.namespace][m.list].nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadOptions() {
    for (const f of this.refFields()) {
      const r = entityBySingle(f.ref!);
      if (!r) continue;
      const q = `{ ${r.namespace} { ${r.list}(limit: 1000) { nodes { id ${f.refLabel} } } } }`;
      this.gql.request(q).subscribe((d: any) => {
        const opts: Option[] = d[r.namespace][r.list].nodes.map((n: any) => ({ id: n.id, label: `${n[f.refLabel!]} (#${n.id})` }));
        this.options.update((o) => ({ ...o, [f.name]: opts }));
      });
    }
  }

  display(row: any, f: FieldMeta): any {
    if (f.type === 'ref') return row[f.relation!] ? `${row[f.relation!][f.refLabel!]} (#${row[f.relation!].id})` : '—';
    return row[f.name] ?? '—';
  }

  openCreate() {
    this.reset();
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
    for (const f of this.meta.fields) {
      const v = this.form[f.name];
      if (v === undefined || v === null || v === '') continue;
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
        else this.error.set(res.errorStatus || 'Operation failed');
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
        else this.error.set(res.errorStatus || 'Delete failed');
      },
      error: (e) => this.error.set(e.message)
    });
  }
}
