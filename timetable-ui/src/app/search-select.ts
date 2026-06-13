import { Component, ElementRef, HostListener, computed, forwardRef, inject, input, signal } from '@angular/core';
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
        @if (value() && !open()) {
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

  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent) {
    if (!this.host.nativeElement.contains(e.target)) this.open.set(false);
  }
}
