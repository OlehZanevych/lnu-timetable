import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { Option, SearchSelect } from './search-select';

interface GlobalProperty {
  name: string;
  type: string;
  value: string;
}

/** Known values for current_semester_parity — the only ENUM-typed property today, so its options
 *  aren't discoverable from the schema (global_properties has no allowed-values metadata). */
const SEMESTER_PARITY_OPTIONS: Option[] = [
  { id: 'ODD', label: 'Перший (непарний)' },
  { id: 'EVEN', label: 'Другий (парний)' }
];

/** Friendlier labels for the properties seeded so far; falls back to the raw name otherwise. */
const PROPERTY_LABELS: Record<string, string> = {
  academic_hour_duration_minutes: 'Тривалість академічної години (хв)',
  semester_duration_weeks: 'Тривалість семестру (тижнів)',
  current_semester_parity: 'Поточний семестр',
  default_class_duration_hours: 'Тривалість заняття за замовчуванням (акад. год.)'
};

/** System-wide settings editor for the global_properties table (name/type/value triples). */
@Component({
  selector: 'app-global-properties-page',
  templateUrl: './global-properties-page.html',
  imports: [FormsModule, SearchSelect]
})
export class GlobalPropertiesPage implements OnInit {
  private gql = inject(GraphqlService);

  readonly semesterParityOptions = SEMESTER_PARITY_OPTIONS;

  properties = signal<GlobalProperty[]>([]);
  error = signal('');
  saveError = signal('');
  savingName = signal<string | null>(null);

  /** Draft values keyed by property name, edited locally before saving. */
  draft: Record<string, string> = {};

  ngOnInit() {
    this.load();
  }

  private load() {
    const q = `{ globalProperties { list { name type value } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const list: GlobalProperty[] = d.globalProperties.list;
        this.properties.set(list);
        for (const p of list) this.draft[p.name] = p.value;
      },
      error: (e) => this.error.set(e.message)
    });
  }

  label(p: GlobalProperty): string {
    return PROPERTY_LABELS[p.name] ?? p.name;
  }

  isSemesterParity(p: GlobalProperty): boolean {
    return p.name === 'current_semester_parity';
  }

  inputType(p: GlobalProperty): string {
    return p.type === 'INTEGER' || p.type === 'DECIMAL' ? 'number' : 'text';
  }

  isDirty(p: GlobalProperty): boolean {
    return (this.draft[p.name] ?? '') !== p.value;
  }

  save(p: GlobalProperty) {
    const value = this.draft[p.name];
    if (!value) return;
    this.savingName.set(p.name);
    this.saveError.set('');
    const q = `mutation($name: ID!, $value: String!) { globalProperties { updateGlobalProperty(name: $name, value: $value) { isSuccess errorStatus } } }`;
    this.gql.request(q, { name: p.name, value }).subscribe({
      next: (d: any) => {
        this.savingName.set(null);
        const res = d.globalProperties.updateGlobalProperty;
        if (res.isSuccess) this.load();
        else this.saveError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => {
        this.savingName.set(null);
        this.saveError.set(e.message);
      }
    });
  }
}
