import { Injectable, computed, inject, signal } from '@angular/core';
import { GraphqlService } from './graphql.service';
import { PlanLimits, parsePlanLimits } from './plan-limits';

export interface GlobalPropertyRow {
  name: string;
  type: string;
  value: string;
}

/**
 * The `global_properties` settings table, loaded once per session.
 *
 * Five screens now read limits from it — both curriculum tabs, both working-curriculum tabs and the
 * settings page itself — and they read the *same* rows, so a limit an administrator changes takes
 * effect everywhere at once rather than in whichever component happened to query for it. That is
 * also why this is a service and not a query repeated per component: the older pattern
 * (`department-workload-summary.ts` and `lecturer-workload-detail.ts` each asking for
 * `default_max_hours_per_year` on their own) costs a round trip per screen and cannot be
 * invalidated after a save.
 *
 * `limits` is a **computed signal**, which matters under zoneless change detection: a component
 * reading it inside its own `computed()` re-runs when the settings arrive, instead of memoising the
 * defaults forever (see the zoneless note in the README).
 */
@Injectable({ providedIn: 'root' })
export class GlobalPropertiesService {
  private gql = inject(GraphqlService);

  readonly properties = signal<GlobalPropertyRow[]>([]);
  readonly loaded = signal(false);
  readonly error = signal('');

  /** The typed limits every plan is measured against; the seeded defaults until the rows arrive. */
  readonly limits = computed<PlanLimits>(() => parsePlanLimits(this.properties()));

  private pending = false;

  /**
   * Loads the table unless it is already loaded or in flight. Safe to call from every consumer's
   * `ngOnInit`: the first caller pays for the query and the rest read the signal.
   */
  ensureLoaded(): void {
    if (this.loaded() || this.pending) return;
    this.refresh();
  }

  /** Re-reads the table — called by the settings page after a save, so other screens follow. */
  refresh(): void {
    this.pending = true;
    const q = `{ globalProperties { list { name type value } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        this.properties.set(d.globalProperties.list ?? []);
        this.loaded.set(true);
        this.error.set('');
        this.pending = false;
      },
      error: (e) => {
        // A settings table that cannot be read leaves the defaults in place rather than blanking
        // every limit: a plan measured against the seeded figures is better than one measured
        // against none, and the message says which happened.
        this.error.set(e.message);
        this.pending = false;
      }
    });
  }

  /** One property's raw value, or null when it is absent or empty. */
  value(name: string): string | null {
    const found = this.properties().find((p) => p.name === name);
    const raw = found?.value ?? '';
    return raw.trim() === '' ? null : raw;
  }

  /** One property read as a number, or null when unset or unparseable. */
  numberValue(name: string): number | null {
    const raw = this.value(name);
    if (raw === null) return null;
    const n = Number(raw.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
}
