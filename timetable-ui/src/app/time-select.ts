import { Component, computed, forwardRef, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

const pad = (n: number): string => String(n).padStart(2, '0');

const range = (from: number, to: number, step: number): string[] => {
  const out: string[] = [];
  for (let n = from; n <= to; n += step) out.push(pad(n));
  return out;
};

/**
 * Two dropdowns (hour + minute) bound to a single "HH:mm" string. Works with [(ngModel)].
 *
 * Replaces a free-text time input so only valid slot times can be entered. A value already stored
 * outside the configured range/step (e.g. an imported "07:07") is still offered as an extra option
 * so opening the edit form never silently rewrites it.
 */
@Component({
  selector: 'app-time-select',
  template: `
    <div class="ts">
      <select class="ts-part" aria-label="Година" [required]="required()" (change)="pickHour($event)">
        <option value="" [selected]="!hour()">--</option>
        @for (h of hours(); track h) {
          <option [value]="h" [selected]="h === hour()">{{ h }}</option>
        }
      </select>
      <span class="ts-sep">:</span>
      <select class="ts-part" aria-label="Хвилини" [required]="required()" (change)="pickMinute($event)">
        <option value="" [selected]="!minute()">--</option>
        @for (m of minutes(); track m) {
          <option [value]="m" [selected]="m === minute()">{{ m }}</option>
        }
      </select>
    </div>
  `,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => TimeSelect), multi: true }]
})
export class TimeSelect implements ControlValueAccessor {
  minHour = input(6);
  maxHour = input(21);
  minuteStep = input(5);
  /** Mirrors the native `required` attribute onto both selects so an empty pair blocks submit,
   *  matching what the plain `<input required>` this component replaced used to do. */
  required = input(false);

  hour = signal('');
  minute = signal('');

  private onChange: (v: any) => void = () => {};
  private onTouched: () => void = () => {};

  hours = computed(() => this.withCurrent(range(this.minHour(), this.maxHour(), 1), this.hour()));
  minutes = computed(() => this.withCurrent(range(0, 59, this.minuteStep()), this.minute()));

  /** Keeps an already-stored, off-grid value selectable instead of dropping it from the list. */
  private withCurrent(list: string[], current: string): string[] {
    return current && !list.includes(current) ? [...list, current].sort() : list;
  }

  writeValue(v: any) {
    const m = /^(\d{1,2}):(\d{1,2})/.exec(String(v ?? ''));
    this.hour.set(m ? pad(Number(m[1])) : '');
    this.minute.set(m ? pad(Number(m[2])) : '');
  }

  registerOnChange(fn: any) { this.onChange = fn; }
  registerOnTouched(fn: any) { this.onTouched = fn; }

  pickHour(e: Event) {
    this.hour.set((e.target as HTMLSelectElement).value);
    this.emit();
  }

  pickMinute(e: Event) {
    this.minute.set((e.target as HTMLSelectElement).value);
    this.emit();
  }

  /** Emits "HH:mm" only once both parts are chosen; a half-filled pair reads as empty. */
  private emit() {
    const h = this.hour();
    const m = this.minute();
    this.onChange(h && m ? `${h}:${m}` : '');
    this.onTouched();
  }
}
