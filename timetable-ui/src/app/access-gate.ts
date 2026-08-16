import { Component, Input, OnChanges, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from './auth.service';
import { AccessNeed, describeNeed } from './access-need';

/**
 * «Немає доступу» — what a screen says instead of its controls when the caller may not use them.
 *
 * A card rather than a redirect, and that is the decision worth writing down. A guard that bounces
 * somebody to the faculty home answers a pasted link with a screen they did not ask for and no
 * explanation; three people forwarding each other `/faculty/3/timetable` would each conclude
 * something different about why. Rendering the refusal where the page would have been keeps the URL
 * meaningful, and names the level that is missing so the reader knows what to ask for.
 */
@Component({
  selector: 'app-no-access',
  imports: [RouterLink],
  template: `
    <div class="card no-access">
      <h3>Немає доступу</h3>
      <p>{{ explanation() }}</p>
      <p class="muted">
        Права надає деканат або адміністратор системи — на факультет, кафедру чи окремий запис.
      </p>
      <a class="btn-link" routerLink="/">← До списку факультетів</a>
    </div>
  `
})
export class NoAccessCard {
  /** What was being asked for, so the card can name the level rather than only refusing. */
  @Input() need: AccessNeed | null = null;

  /** An optional sentence about this particular screen, shown in place of the generic one. */
  @Input() reason = '';

  protected explanation(): string {
    if (this.reason) return this.reason;
    return this.need ? describeNeed(this.need) : 'Цей розділ доступний лише за наявності відповідних прав.';
  }
}

/**
 * Renders its content when the caller meets `need`, and {@link NoAccessCard} when they do not.
 *
 * The point of it being a component rather than a route guard is that a tab is not a route: the open
 * tab of a drill-down page is a path segment, but the page is one component and its sections are a
 * switch inside it. Wrapping the section body is the only place a per-tab answer can be given, and
 * once the mechanism exists for tabs there is no reason for whole pages to use a second one.
 *
 * While the answer is in flight it renders nothing at all — a screen that shows its controls and then
 * withdraws them is worse than one that waits a moment, and the wait is one cached query at most.
 */
@Component({
  selector: 'app-access-gate',
  imports: [NoAccessCard],
  template: `
    @switch (state()) {
      @case ('allowed') { <ng-content /> }
      @case ('denied') { <app-no-access [need]="need" [reason]="reason" /> }
    }
  `
})
export class AccessGate implements OnChanges {
  private auth = inject(AuthService);

  @Input({ required: true }) need!: AccessNeed;

  /** Passed through to the card when refused. */
  @Input() reason = '';

  protected state = signal<'checking' | 'allowed' | 'denied'>('checking');

  ngOnChanges() {
    this.state.set('checking');
    const asked = this.need;
    this.auth.resolveNeed(asked).subscribe({
      // A late answer to a question the host has since changed (a tab switched while the first was
      // resolving) must not decide the new one.
      next: (ok) => { if (this.need === asked) this.state.set(ok ? 'allowed' : 'denied'); },
      error: () => { if (this.need === asked) this.state.set('denied'); }
    });
  }
}
