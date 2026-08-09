import { Component, DestroyRef, ElementRef, computed, forwardRef, inject, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

export type Option = { id: string; label: string };

/** A select2-like dropdown: type to filter options. Works with [(ngModel)]. */
@Component({
  selector: 'app-search-select',
  template: `
    <div class="ss" [class.open]="open()">
      <div class="ss-control">
        <input
          class="ss-input"
          [value]="open() ? search() : display()"
          [placeholder]="placeholder()"
          (input)="onInput($event)"
          (focus)="open.set(true)"
          autocomplete="off" />
        @if (value() && !open() && clearable()) {
          <button type="button" class="ss-clear" (click)="clear($event)">✕</button>
        }
        <span class="ss-arrow">▾</span>
      </div>
      @if (open()) {
        <ul class="ss-menu">
          @for (o of filtered(); track o.id) {
            <li [class.sel]="o.id === value()" (click)="pick(o)">{{ o.label }}</li>
          } @empty {
            <li class="ss-empty">Нічого не знайдено</li>
          }
        </ul>
      }
    </div>
  `,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => SearchSelect), multi: true }]
})
export class SearchSelect implements ControlValueAccessor {
  options = input<Option[]>([]);
  placeholder = input('— оберіть —');
  /**
   * Whether the ✕ that empties the control is offered. Set `false` where `''` is not a value the
   * field can hold — the семестр picker above a timetable, say: the empty string is not "no filter"
   * there, it is a value the backend's parity filter matches no row with, so clearing would empty
   * the grid and blame the data. Where `''` *is* a meaning the screen has — «Мій кабінет»'s tables
   * read it as the whole year — the ✕ is offered and the host decides what an empty value does.
   */
  clearable = input(true);

  private host = inject(ElementRef);
  value = signal('');
  search = signal('');
  open = signal(false);

  private onChange: (v: any) => void = () => {};
  private onTouched: () => void = () => {};

  filtered = computed(() => {
    const q = this.search().toLowerCase();
    return this.options().filter((o) => o.label.toLowerCase().includes(q));
  });
  display = computed(() => this.options().find((o) => o.id === this.value())?.label ?? '');

  writeValue(v: any) { this.value.set(v == null ? '' : String(v)); }
  registerOnChange(fn: any) { this.onChange = fn; }
  registerOnTouched(fn: any) { this.onTouched = fn; }

  onInput(e: Event) {
    this.search.set((e.target as HTMLInputElement).value);
    this.open.set(true);
  }

  pick(o: Option) {
    this.value.set(o.id);
    this.onChange(o.id);
    this.onTouched();
    this.search.set('');
    this.open.set(false);
  }

  clear(e: Event) {
    e.stopPropagation();
    this.value.set('');
    this.onChange('');
  }

  constructor() {
    // Closes the dropdown on any outside click. Registered on `document` in the CAPTURE phase
    // (not via @HostListener, which is bubble-phase) so this still fires even when a click is
    // inside a modal that calls `$event.stopPropagation()` on its content wrapper (a common
    // pattern in this app to stop backdrop-close clicks from closing the modal) — a bubble-phase
    // listener would never see that click at all, leaving the dropdown stuck open.
    const onDocClick = (e: MouseEvent) => {
      if (!this.host.nativeElement.contains(e.target)) this.open.set(false);
    };
    document.addEventListener('click', onDocClick, true);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('click', onDocClick, true));
  }
}
