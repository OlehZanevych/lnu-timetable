import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { GlobalPropertiesService } from './global-properties.service';
import { Option, SearchSelect } from './search-select';
import { WorkingCurriculumSummary } from './working-curriculum-summary';
import { CONTROL_FORM_OPTIONS, HOUR_TYPE_OPTIONS, TEACHING_FORMAT_OPTIONS } from './entities';
import { fmtNumber, fmtOrDash } from './curriculum-plan';
import {
  WorkingPlanItemInput, buildWorkingCurriculumPlan
} from './working-curriculum-plan';
import type { CurriculumSpecialty } from './curriculum-item-list';
import { courseTagNames } from './course-label';
// `working-curriculum-report`, `pdf-fonts` and `workload-report` are imported dynamically in
// downloadPlan(): see the comment there for why the PDF engine is kept out of the main bundle.

/**
 * The read-only counterpart of {@link WorkingCurriculumList}: a specialty's робочий навчальний план
 * as a document rather than as a set of editable rows — one line per discipline with the кафедра
 * behind it, the same plan broken down per кафедра, and the printable «Робочий навчальний план».
 *
 * The editing tab nests three levels deep (curriculum item → hours block → working item), which is
 * the right shape for assigning a кафедра to one block of hours and the wrong one for reading what
 * the year actually looks like. This page flattens the same rows into the table a навчальний відділ
 * reads, and never writes.
 *
 * A **курс filter** scopes it, because a робочий навчальний план is drawn up for one academic year
 * — the one thing every ЗВО положення agrees on. The model has no cohort or intake year, so the
 * year is chosen here rather than stored; «усі курси» is offered too, and the document says which
 * of the two it is.
 */
@Component({
  selector: 'app-working-curriculum-view',
  templateUrl: './working-curriculum-view.html',
  imports: [FormsModule, RouterLink, SearchSelect, WorkingCurriculumSummary]
})
export class WorkingCurriculumView implements OnInit, OnChanges {
  private gql = inject(GraphqlService);
  private settings = inject(GlobalPropertiesService);

  @Input() specialtyId!: string;
  /** The specialty itself, passed down from the page that already loaded it. */
  @Input() set specialty(value: CurriculumSpecialty | null) { this.specialtySignal.set(value); }

  readonly fmtNumber = fmtNumber;
  readonly fmtOrDash = fmtOrDash;

  items = signal<WorkingPlanItemInput[]>([]);
  error = signal('');
  loading = signal(false);

  private specialtySignal = signal<CurriculumSpecialty | null>(null);
  private studyForms = signal<string[]>([]);

  /** '' means «усі курси»; otherwise the course year the plan is scoped to. */
  courseYearFilter = signal('');

  exporting = signal(false);
  exportError = signal('');

  /**
   * The plan the printed sheet is built from. Both this page and the PDF read this one object, so
   * the screen and the document cannot disagree.
   */
  plan = computed(() => {
    const raw = this.courseYearFilter();
    const year = raw === '' ? null : Number(raw);
    return buildWorkingCurriculumPlan(
      this.items(), Number.isFinite(year!) ? year : null, this.settings.limits());
  });

  /** «усі курси» plus every course year the specialty's curriculum actually reaches. */
  courseYearOptions = computed<Option[]>(() => [
    { id: '', label: 'усі курси' },
    ...this.plan().courseYears.map((y) => ({ id: String(y), label: `${y} курс` }))
  ]);

  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    this.settings.ensureLoaded();
    if (this.specialtyId) { this.load(); this.loadStudyForms(); }
  }

  ngOnChanges() {
    if (this.initialized && this.specialtyId) { this.load(); this.loadStudyForms(); }
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  /**
   * The same tree the editing tab loads, plus `courseType` (which sorts a component into
   * обов'язкові/вибіркові) and `studentsCount` on each group — individual work is charged per
   * student, so the department-hours projection cannot be made without it.
   */
  private load() {
    if (!this.specialtyId) return;
    this.loading.set(true);
    const q = `{ curriculumItems { curriculumItemConnection(limit: 500, offset: 0, specialtyId: "${this.specialtyId}") { nodes {
      id semester controlForm ectsCredits
      course { id name courseType tags { tag } }
      hours { id hourType hours
        workingCurriculumItems {
          id lecturerCount teachingFormat
          department { id name }
          course { id name tags { tag } }
          academicGroups { id name studentsCount }
        }
      }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        this.items.set(d.curriculumItems.curriculumItemConnection.nodes.map(toPlanItem));
        this.error.set('');
        this.loading.set(false);
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }

  private loadStudyForms() {
    if (!this.specialtyId) return;
    const q = `{ academicGroups { academicGroupConnection(limit: 500, offset: 0, specialtyId: "${this.specialtyId}") { nodes { id studyForm } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.studyForms.set(
        d.academicGroups.academicGroupConnection.nodes.map((g: any) => g.studyForm).filter(Boolean)),
      error: () => this.studyForms.set([])
    });
  }

  // ── Labels ───────────────────────────────────────────────────────────────

  controlFormLabel(v: string): string {
    return CONTROL_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  hourTypeLabel(v: string): string {
    return HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  teachingFormatLabel(v: string): string {
    return TEACHING_FORMAT_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  /** «Кафедра А (лекції); Кафедра Б (лабораторні)», qualified only when there is more than one. */
  departmentsLabel(row: { departments: { departmentName: string; hourTypes: string[] }[] }): string {
    const list = row.departments;
    if (!list.length) return '';
    return list
      .map((d) => list.length > 1
        ? `${d.departmentName} (${d.hourTypes.map((t) => this.hourTypeLabel(t).toLowerCase()).join(', ')})`
        : d.departmentName)
      .join('; ');
  }

  unassignedLabel(hourTypes: string[]): string {
    return hourTypes.map((t) => this.hourTypeLabel(t).toLowerCase()).join(', ');
  }

  // ── Export ───────────────────────────────────────────────────────────────

  /**
   * Builds the printable «Робочий навчальний план» and hands it to the browser as a download.
   * Everything happens on the client; the only fetch is for the embedded font, on the first export.
   *
   * The document modules are **imported dynamically**, so the PDF engine and the report stay out of
   * the main bundle — a user who never exports pays nothing for the ability to.
   */
  async downloadPlan() {
    const specialty = this.specialtySignal();
    if (!specialty || this.exporting() || !this.plan().rows.length) return;

    this.exporting.set(true);
    this.exportError.set('');
    const generatedAt = new Date();
    const plan = this.plan();

    try {
      const [{ downloadPdf, loadReportFonts },
             { buildWorkingCurriculumReport, workingCurriculumReportFileName },
             { academicYearLabel }] = await Promise.all([
        import('./pdf-fonts'), import('./working-curriculum-report'), import('./workload-report')
      ]);
      const fonts = await loadReportFonts();
      const bytes = buildWorkingCurriculumReport({
        plan,
        specialtyCode: specialty.code ?? '',
        specialtyName: specialty.name ?? '',
        degree: specialty.degree ?? '',
        facultyName: specialty.faculty?.name ?? '',
        studyForms: this.studyForms(),
        generatedAt,
        fonts
      });
      downloadPdf(bytes, workingCurriculumReportFileName(
        specialty.code ?? '', plan.courseYear, academicYearLabel(generatedAt)));
    } catch (e: unknown) {
      this.exportError.set(e instanceof Error ? e.message : 'Не вдалося сформувати PDF');
    } finally {
      this.exporting.set(false);
    }
  }
}

/** Flattens a loaded curriculum item into the shape `working-curriculum-plan.ts` computes on. */
const toPlanItem = (node: any): WorkingPlanItemInput => ({
  id: node.id,
  semester: node.semester,
  controlForm: node.controlForm,
  ectsCredits: node.ectsCredits ?? 0,
  course: node.course
    ? { id: node.course.id, name: node.course.name, courseType: node.course.courseType ?? 'MANDATORY',
        tags: courseTagNames(node.course.tags) }
    : null,
  hours: (node.hours ?? []).map((h: any) => ({
    id: h.id,
    hourType: h.hourType,
    hours: h.hours ?? 0,
    positions: (h.workingCurriculumItems ?? []).map((w: any) => ({
      id: w.id,
      departmentId: w.department?.id ?? '',
      departmentName: w.department?.name ?? '—',
      lecturerCount: w.lecturerCount ?? 1,
      teachingFormat: w.teachingFormat ?? '',
      electiveCourseName: w.course?.name ?? null,
      groups: (w.academicGroups ?? []).map((g: any) => ({
        id: g.id, name: g.name, studentsCount: g.studentsCount ?? null
      }))
    }))
  }))
});
