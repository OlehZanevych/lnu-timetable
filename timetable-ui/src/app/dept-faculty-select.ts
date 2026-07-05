import { Component, computed, effect, forwardRef, input, signal } from '@angular/core';
import { ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from '@angular/forms';
import { Option, SearchSelect } from './search-select';

export type DeptOption = Option & { facultyId?: string };

/**
 * Department selector with an optional faculty pre-filter.
 * When editing, the faculty of the current department is pre-selected automatically.
 * The user can clear or change the faculty filter to show departments from other faculties.
 */
@Component({
  selector: 'app-dept-faculty-select',
  imports: [FormsModule, SearchSelect],
  template: `
    <div class="dfs-wrap">
      <div class="dfs-parent-row">
        <span class="dfs-parent-label">{{ parentLabel() }}:</span>
        <app-search-select
          [options]="parentOptions()"
          placeholder="— всі факультети —"
          [(ngModel)]="selectedFaculty"
          [ngModelOptions]="{ standalone: true }" />
      </div>
      <app-search-select
        [options]="filteredDepts()"
        placeholder="— оберіть кафедру —"
        [(ngModel)]="selectedDept"
        [ngModelOptions]="{ standalone: true }" />
    </div>
  `,
  styles: [`
    .dfs-wrap { display: flex; flex-direction: column; gap: 6px; width: 100%; }
    .dfs-parent-row { display: flex; align-items: center; gap: 8px; }
    .dfs-parent-label { font-size: 0.8rem; color: var(--text-muted, #888); white-space: nowrap; }
    .dfs-parent-row app-search-select { flex: 1; }
  `],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => DeptFacultySelect), multi: true }]
})
export class DeptFacultySelect implements ControlValueAccessor {
  deptOptions = input<DeptOption[]>([]);
  parentOptions = input<Option[]>([]);
  parentLabel = input('Факультет');

  private _value = signal('');
  private _facultyId = signal('');

  // Getters/setters let [(ngModel)] work with internal signals
  get selectedFaculty(): string { return this._facultyId(); }
  set selectedFaculty(v: string) { this._facultyId.set(v ?? ''); }

  get selectedDept(): string { return this._value(); }
  set selectedDept(v: string) {
    this._value.set(v ?? '');
    this.onChange(v ?? '');
    this.onTouched();
  }

  filteredDepts = computed(() => {
    const fId = this._facultyId();
    if (!fId) return this.deptOptions();
    return this.deptOptions().filter((d) => d.facultyId === fId);
  });

  private onChange: (v: any) => void = () => {};
  private onTouched: () => void = () => {};

  constructor() {
    // When options load, pre-select faculty for the current value (handles async load)
    effect(() => {
      const opts = this.deptOptions();
      const id = this._value();
      if (id && opts.length > 0 && !this._facultyId()) {
        const dept = opts.find((d) => d.id === id);
        if (dept?.facultyId) this._facultyId.set(dept.facultyId);
      }
    });
  }

  writeValue(v: any) {
    const id = v == null ? '' : String(v);
    this._value.set(id);
    // Pre-set faculty if options already available (sync case)
    if (id) {
      const dept = this.deptOptions().find((d) => d.id === id);
      if (dept?.facultyId) this._facultyId.set(dept.facultyId);
    }
  }

  registerOnChange(fn: any) { this.onChange = fn; }
  registerOnTouched(fn: any) { this.onTouched = fn; }
}
