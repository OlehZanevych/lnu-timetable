import { Component, Input } from '@angular/core';
import { fmtNumber } from './curriculum-plan';
import { WorkingCurriculumPlan } from './working-curriculum-plan';

/**
 * The headline figures of a робочий навчальний план, and every rule it currently breaks.
 *
 * Purely presentational, like {@link CurriculumSummary}: it renders a {@link WorkingCurriculumPlan}
 * and computes nothing, so the editing tab ("Редагування робочих планів"), the reading tab
 * ("Робочі навчальні плани") and the printed sheet show one set of numbers. On the editing tab that
 * is the point — the coverage figure moves as кафедри are assigned, so it is obvious when the last
 * block of hours has found an owner.
 */
@Component({
  selector: 'app-working-curriculum-summary',
  templateUrl: './working-curriculum-summary.html'
})
export class WorkingCurriculumSummary {
  @Input({ required: true }) plan!: WorkingCurriculumPlan;
  /** Optional line under the tiles, e.g. to say which курс the figures cover. */
  @Input() note = '';

  readonly fmtNumber = fmtNumber;
}
