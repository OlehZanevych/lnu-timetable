import { Component, DestroyRef, ElementRef, computed, forwardRef, inject, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { Option } from './search-select';

/**
 * A checkbox-list dropdown for selecting several options at once (e.g. academic groups).
 * Works with [(ngModel)] bound to a string[] of selected ids. Reuses the same `.ss*` classes
 * as app-search-select for a consistent look, with its own tag/checkbox styling on top.
 */
@Component({
  selector: 'app-multi-select',
  template: `
    <div class="ss ms" [class.open]="open()">
      <div class="ss-control ms-control" (click)="open.set(true)">
        <div class="ms-tags">
          @if (selectedLabels().length) {
            @for (label of selectedLabels(); track label) {
              <span class="ms-tag">{{ label }}</span>
            }
          } @else {
            <span class="ms-placeholder">{{ placeholder() }}</span>
          }
        </div>
        <span class="ss-arrow">▾</span>
      </div>
      @if (open()) {
        <div class="ss-menu ms-menu">
          <input
            class="ss-input ms-search"
            [value]="search()"
            (input)="onSearch($event)"
            placeholder="Пошук..."
            autocomplete="off" />
          <ul class="ms-list">
            @for (o of filtered(); track o.id) {
              <li [class.sel]="isSelected(o.id)" (click)="toggle(o.id)">
                <input type="checkbox" [checked]="isSelected(o.id)" (click)="$event.preventDefault()" />
                <span>{{ o.label }}</span>
              </li>
            } @empty {
              <li class="ss-empty">Нічого не знайдено</li>
            }
          </ul>
        </div>
      }
    </div>
  `,
  styles: [`
    .ms-control { flex-wrap: wrap; min-height: 38px; cursor: pointer; padding: 4px 6px; gap: 4px; }
    .ms-tags { flex: 1; display: flex; flex-wrap: wrap; gap: 4px; }
    .ms-tag { background: #eef2f9; color: var(--navy, #1d4f91); font-size: 12px; padding: 2px 8px; border-radius: 10px; }
    .ms-placeholder { color: #9aa5b1; font-size: 13px; padding: 4px 2px; }
    .ms-menu { padding: 6px; }
    .ms-search { border: 1px solid var(--line, #d8dee5); border-radius: 6px; margin-bottom: 4px; width: 100%; box-sizing: border-box; }
    .ms-list { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow-y: auto; }
    .ms-list li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .ms-list li:hover { background: #eef2f9; }
    .ms-list li.sel { background: #f3f7fd; }
  `],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MultiSelect), multi: true }]
})
export class MultiSelect implements ControlValueAccessor {
  options = input<Option[]>([]);
  placeholder = input('— оберіть —');

  private host = inject(ElementRef);
  value = signal<string[]>([]);
  search = signal('');
  open = signal(false);

  private onChange: (v: any) => void = () => {};
  private onTouched: () => void = () => {};

  filtered = computed(() => {
    const q = this.search().toLowerCase();
    return this.options().filter((o) => o.label.toLowerCase().includes(q));
  });

  selectedLabels = computed(() => {
    const ids = new Set(this.value());
    return this.options().filter((o) => ids.has(o.id)).map((o) => o.label);
  });

  isSelected(id: string): boolean {
    return this.value().includes(id);
  }

  writeValue(v: any) {
    this.value.set(Array.isArray(v) ? v.map((x) => String(x)) : []);
  }

  registerOnChange(fn: any) { this.onChange = fn; }
  registerOnTouched(fn: any) { this.onTouched = fn; }

  onSearch(e: Event) {
    this.search.set((e.target as HTMLInputElement).value);
  }

  toggle(id: string) {
    const cur = this.value();
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    this.value.set(next);
    this.onChange(next);
    this.onTouched();
  }

  constructor() {
    // See the identical constructor in SearchSelect for why this is a capture-phase listener on
    // `document` rather than a (bubble-phase) @HostListener: modal content wrappers in this app
    // call `$event.stopPropagation()` on click to keep the modal from closing, which also
    // silently swallows the click before it can bubble to document. Since this component has no
    // other way to close (toggling an item keeps the list open for further picks), that left it
    // permanently stuck open inside any modal.
    const onDocClick = (e: MouseEvent) => {
      if (!this.host.nativeElement.contains(e.target)) this.open.set(false);
    };
    document.addEventListener('click', onDocClick, true);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('click', onDocClick, true));
  }
}
