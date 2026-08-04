import { Component, Input } from '@angular/core';
import { ComplianceCheck, CurriculumPlan, fmtNumber, fmtShare } from './curriculum-plan';

/**
 * The headline figures of a specialty's освітня програма, and every statutory rule the plan
 * currently breaks.
 *
 * Purely presentational: it renders a {@link CurriculumPlan} and computes nothing, so both
 * specialty tabs that show a curriculum — the flat table ("Навчальні плани") and the course-first
 * editor ("Редагування навчальних планів") — display one set of numbers rather than two that can
 * drift, and the same set the printed «Навчальний план» is built from.
 *
 * The plan arrives as a plain `@Input` rather than a signal on purpose: nothing here reads it
 * inside a `computed()`, and an input binding already marks the view dirty when the parent's own
 * signal changes — which is what keeps the editor's figures moving as fields are typed into.
 */
@Component({
  selector: 'app-curriculum-summary',
  templateUrl: './curriculum-summary.html'
})
export class CurriculumSummary {
  @Input({ required: true }) plan!: CurriculumPlan;
  /** Optional line under the tiles, e.g. to say the figures include unsaved edits. */
  @Input() note = '';

  readonly fmtNumber = fmtNumber;
  readonly fmtShare = fmtShare;

  /**
   * The elective-share check, or undefined when nobody has set that limit. The tile takes both its
   * caption and its tint from it, so clearing the setting turns the rule off here exactly as it
   * does in the printed sheet — rather than leaving a red tile against a rule no longer in force.
   */
  electiveCheck(): ComplianceCheck | undefined {
    return this.plan.checks.find((c) => c.key === 'ELECTIVE_SHARE');
  }
}
