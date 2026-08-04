import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Option, SearchSelect } from './search-select';
import { GlobalPropertiesService, GlobalPropertyRow } from './global-properties.service';
import { GraphqlService } from './graphql.service';

/** Known values for current_semester_parity — the only ENUM-typed property today, so its options
 *  aren't discoverable from the schema (global_properties has no allowed-values metadata). */
const SEMESTER_PARITY_OPTIONS: Option[] = [
  { id: 'ODD', label: 'Перший (непарний)' },
  { id: 'EVEN', label: 'Другий (парний)' }
];

/**
 * What is known about a property beyond its name/type/value triple: how to label it, what it is
 * for, and whether it may be left empty.
 *
 * The table itself carries no metadata — it is a bare name/type/value store — so this is where the
 * settings page learns to present it. A property with no entry here still appears, under «Інші
 * налаштування», labelled by its raw name: a value seeded straight into the database is visible and
 * editable rather than invisible.
 */
interface PropertyMeta {
  label: string;
  /** One line under the field, saying what the value governs. */
  hint?: string;
  /**
   * True when clearing the field is a meaningful instruction rather than a mistake. Only limits are
   * optional: emptying one means «ця межа не встановлена», and the check that rests on it is then
   * dropped from the screens and from the printed «Відповідність» tables.
   */
  optional?: boolean;
  /** Smallest sensible value; used for the `min` attribute and for validation. */
  min?: number;
}

interface PropertyGroup {
  title: string;
  description?: string;
  names: string[];
}

const PROPERTY_META: Record<string, PropertyMeta> = {
  academic_hour_duration_minutes: {
    label: 'Тривалість академічної години, хв', min: 1,
    hint: 'Використовується для перерахунку академічних годин у астрономічний час.'
  },
  semester_duration_weeks: {
    label: 'Тривалість семестру, тижнів', min: 1,
    hint: 'Скільки тижнів має семестр; за цим числом розкладаються заняття на тиждень.'
  },
  current_semester_parity: {
    label: 'Поточний семестр',
    hint: 'Який семестр навчального року триває: перший (непарний) чи другий (парний).'
  },
  default_class_duration_hours: {
    label: 'Тривалість заняття за замовчуванням, акад. год.', min: 1,
    hint: 'Значення, з яким створюється нова позиція навантаження.'
  },
  default_max_hours_per_year: {
    label: 'Максимум годин на рік за замовчуванням, акад. год.', min: 0, optional: true,
    hint: 'Стеля навантаження викладача, який не має власного обмеження.'
  },

  hours_per_ects_credit: {
    label: 'Годин в одному кредиті ЄКТС', min: 1,
    hint: 'Загальний обсяг кожної позиції плану — це кредити, помножені на це число. ' +
          'Єдина межа, яку не можна лишити порожньою: на ній стоять усі підсумки.'
  },
  credits_per_academic_year: {
    label: 'Кредитів ЄКТС на навчальний рік', min: 0, optional: true,
    hint: 'Орієнтир річного обсягу. Порожнє поле вимикає цю перевірку.'
  },
  credits_per_year_tolerance: {
    label: 'Допустиме відхилення річного обсягу, кредитів', min: 0, optional: true,
    hint: 'Наскільки річний обсяг може відходити від орієнтиру, лишаючись прийнятним.'
  },
  min_elective_share_percent: {
    label: 'Найменша частка вибіркових компонентів, %', min: 0, optional: true,
    hint: 'Частка обсягу освітньої програми, яку мають становити вибіркові освітні компоненти. ' +
          'Порожнє поле вимикає цю перевірку.'
  },
  max_courses_per_semester: {
    label: 'Найбільше освітніх компонентів у семестрі', min: 0, optional: true,
    hint: 'Порожнє поле вимикає цю перевірку.'
  },
  max_exams_per_semester: {
    label: 'Найбільше екзаменів у семестрі', min: 0, optional: true,
    hint: 'Порожнє поле вимикає цю перевірку.'
  },

  min_credits_junior_bachelor: { label: 'Молодший бакалавр — не менше, кредитів', min: 0, optional: true },
  max_credits_junior_bachelor: { label: 'Молодший бакалавр — не більше, кредитів', min: 0, optional: true },
  min_credits_bachelor:        { label: 'Бакалавр — не менше, кредитів', min: 0, optional: true },
  max_credits_bachelor:        { label: 'Бакалавр — не більше, кредитів', min: 0, optional: true },
  min_credits_master:          { label: 'Магістр — не менше, кредитів', min: 0, optional: true },
  max_credits_master:          { label: 'Магістр — не більше, кредитів', min: 0, optional: true },
  min_credits_phd:             { label: 'Доктор філософії — не менше, кредитів', min: 0, optional: true },
  max_credits_phd:             { label: 'Доктор філософії — не більше, кредитів', min: 0, optional: true }
};

/** The order the page reads in: what the academic year is, then what a plan must add up to. */
const PROPERTY_GROUPS: PropertyGroup[] = [
  {
    title: 'Освітній процес',
    description: 'Як влаштований навчальний рік і з чого складається заняття.',
    names: ['academic_hour_duration_minutes', 'semester_duration_weeks', 'current_semester_parity',
            'default_class_duration_hours']
  },
  {
    title: 'Навчальне навантаження',
    description: 'Межі, що застосовуються до викладача, який не має власних обмежень.',
    names: ['default_max_hours_per_year']
  },
  {
    title: 'Обсяг освітньої програми',
    description: 'Скільки кредитів ЄКТС має програма і скільки годин стоїть за одним кредитом. ' +
                 'Ці числа задають підсумки навчального плану та перевірки його обсягу.',
    names: ['hours_per_ects_credit', 'credits_per_academic_year', 'credits_per_year_tolerance']
  },
  {
    title: 'Обсяг за освітніми ступенями',
    description: 'Допустимий обсяг освітньої програми окремо для кожного ступеня. Ступінь, для ' +
                 'якого не задано жодної межі, у перевірках не оцінюється.',
    names: ['min_credits_junior_bachelor', 'max_credits_junior_bachelor',
            'min_credits_bachelor', 'max_credits_bachelor',
            'min_credits_master', 'max_credits_master',
            'min_credits_phd', 'max_credits_phd']
  },
  {
    title: 'Обмеження навчального плану',
    description: 'Межі, за якими навчальний план перевіряється на збалансованість. Порожнє поле ' +
                 'означає, що межу не встановлено, і відповідна перевірка не виконується.',
    names: ['min_elective_share_percent', 'max_courses_per_semester', 'max_exams_per_semester']
  }
];

/** A group and the rows that actually exist for it, resolved against what the table returned. */
export interface RenderedGroup {
  title: string;
  description?: string;
  rows: RenderedProperty[];
}

export interface RenderedProperty {
  row: GlobalPropertyRow;
  label: string;
  hint: string;
  optional: boolean;
  min: number | null;
  /** 'select' | 'checkbox' | 'number' | 'text' — chosen from `global_properties.type`. */
  control: 'select' | 'checkbox' | 'number' | 'text';
  /** Decimal step for DECIMAL, whole numbers otherwise. */
  step: string;
}

/**
 * System-wide settings editor for the `global_properties` table.
 *
 * Two things the earlier version did not do. The properties are **grouped**: the table is a flat
 * name/type/value store and reads as a list of unrelated switches, while what an administrator
 * actually wants is «що таке навчальний рік» in one place and «яким має бути навчальний план» in
 * another. And the **type drives the editor and the validation** rather than being displayed as a
 * column of its own: `INTEGER` gets a whole-number field that refuses a fraction, `DECIMAL` a
 * fractional one, `BOOLEAN` a checkbox, `ENUM` a dropdown. A column reading "INTEGER" told a reader
 * nothing they could act on; a field that will not accept `3.5` tells them exactly the same thing
 * at the moment it matters.
 */
@Component({
  selector: 'app-global-properties-page',
  templateUrl: './global-properties-page.html',
  imports: [FormsModule, SearchSelect]
})
export class GlobalPropertiesPage implements OnInit {
  private gql = inject(GraphqlService);
  private settings = inject(GlobalPropertiesService);

  readonly semesterParityOptions = SEMESTER_PARITY_OPTIONS;

  readonly properties = this.settings.properties;
  readonly error = this.settings.error;

  saveError = signal('');
  savingName = signal<string | null>(null);

  /** Draft values keyed by property name, edited locally before saving. */
  draft: Record<string, string> = {};

  /** The known groups, then everything the table holds that no group claims. */
  groups = computed<RenderedGroup[]>(() => {
    const byName = new Map(this.properties().map((p) => [p.name, p]));
    const claimed = new Set<string>();
    const groups: RenderedGroup[] = [];

    for (const group of PROPERTY_GROUPS) {
      const rows: RenderedProperty[] = [];
      for (const name of group.names) {
        const row = byName.get(name);
        if (!row) continue;   // a property this build knows but the database has not been given
        claimed.add(name);
        rows.push(this.render(row));
      }
      if (rows.length) groups.push({ title: group.title, description: group.description, rows });
    }

    // Anything seeded straight into the database stays visible rather than silently uneditable.
    const rest = this.properties().filter((p) => !claimed.has(p.name)).map((p) => this.render(p));
    if (rest.length) {
      groups.push({
        title: 'Інші налаштування',
        description: 'Властивості, яких ця версія інтерфейсу не знає; редагуються як є.',
        rows: rest
      });
    }
    return groups;
  });

  ngOnInit() {
    this.settings.refresh();
    // The drafts follow whatever the table returns, including a value someone else has just saved.
    queueMicrotask(() => this.syncDrafts());
  }

  private syncDrafts() {
    for (const p of this.properties()) {
      if (this.draft[p.name] === undefined) this.draft[p.name] = p.value;
    }
  }

  private render(row: GlobalPropertyRow): RenderedProperty {
    const meta = PROPERTY_META[row.name] ?? { label: row.name };
    if (this.draft[row.name] === undefined) this.draft[row.name] = row.value;
    return {
      row,
      label: meta.label,
      hint: meta.hint ?? '',
      optional: meta.optional === true,
      min: meta.min ?? null,
      control: row.name === 'current_semester_parity' || row.type === 'ENUM' ? 'select'
             : row.type === 'BOOLEAN' ? 'checkbox'
             : row.type === 'INTEGER' || row.type === 'DECIMAL' ? 'number'
             : 'text',
      // An INTEGER field that steps by one is what stops a fraction being typed in the first place.
      step: row.type === 'DECIMAL' ? '0.01' : '1'
    };
  }

  // ── Validation ───────────────────────────────────────────────────────────

  /**
   * What is wrong with the current draft, in Ukrainian, or '' when it is saveable. The rules come
   * from `global_properties.type` — which is exactly why the type no longer needs a column of its
   * own: it is visible in what the field will and will not accept.
   */
  problem(p: RenderedProperty): string {
    const raw = (this.draft[p.row.name] ?? '').trim();

    if (raw === '') {
      return p.optional ? '' : 'Значення обовʼязкове.';
    }
    if (p.row.type === 'INTEGER' || p.row.type === 'DECIMAL') {
      const n = Number(raw.replace(',', '.'));
      if (!Number.isFinite(n)) return 'Потрібне число.';
      if (p.row.type === 'INTEGER' && !Number.isInteger(n)) return 'Потрібне ціле число.';
      if (p.min !== null && n < p.min) return `Не менше ${p.min}.`;
      return '';
    }
    if (p.row.type === 'BOOLEAN') {
      return raw === 'true' || raw === 'false' ? '' : 'Потрібне значення «так» або «ні».';
    }
    if (p.row.type === 'ENUM' && p.control === 'select') {
      return this.semesterParityOptions.some((o) => o.id === raw) ? '' : 'Оберіть значення зі списку.';
    }
    return '';
  }

  isDirty(p: RenderedProperty): boolean {
    return (this.draft[p.row.name] ?? '') !== p.row.value;
  }

  canSave(p: RenderedProperty): boolean {
    return this.isDirty(p) && !this.problem(p) && this.savingName() !== p.row.name;
  }

  /** BOOLEAN is stored as the text 'true'/'false', so the checkbox binds through these two. */
  checked(p: RenderedProperty): boolean {
    return (this.draft[p.row.name] ?? '') === 'true';
  }

  setChecked(p: RenderedProperty, value: boolean) {
    this.draft[p.row.name] = value ? 'true' : 'false';
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  save(p: RenderedProperty) {
    if (!this.canSave(p)) return;
    // A cleared optional limit is stored as an empty string: the column is NOT NULL, and «не
    // встановлено» has to survive a round trip for the checks that rest on it to stay switched off.
    const value = (this.draft[p.row.name] ?? '').trim();
    this.savingName.set(p.row.name);
    this.saveError.set('');
    const q = `mutation($name: ID!, $value: String!) { globalProperties { updateGlobalProperty(name: $name, value: $value) { isSuccess errorStatus } } }`;
    this.gql.request(q, { name: p.row.name, value }).subscribe({
      next: (d: any) => {
        this.savingName.set(null);
        const res = d.globalProperties.updateGlobalProperty;
        // Refreshing the shared service is what makes a changed limit take effect on the plan
        // screens too, rather than only here.
        if (res.isSuccess) this.settings.refresh();
        else this.saveError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => {
        this.savingName.set(null);
        this.saveError.set(e.message);
      }
    });
  }
}
