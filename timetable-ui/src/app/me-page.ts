import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { GlobalPropertiesService } from './global-properties.service';
import { SearchSelect } from './search-select';
import { TimetableView } from './timetable-view';
import {
  CONTROL_FORM_OPTIONS, HOUR_TYPE_OPTIONS, SEMESTER_PARITY_OPTIONS, STUDY_FORM_OPTIONS,
  courseTypeLabel, halfYearOf, positionLabel, termLabel, termLabelShort
} from './entities';
import { fmtNumber } from './curriculum-plan';
import { compareUk } from './sort';
import { LecturerStats, STAT_HOUR_TYPES, StatItem, computeStats } from './workload-stats';
import { loadDepartmentWorkloads } from './workload-tree';
import { courseLabel } from './course-label';

/** Which tab is open. Which of them exist at all depends on who the account belongs to. */
type DeskSection = 'workload' | 'curriculum' | 'timetable';

interface LecturerProfile {
  id: string;
  fullName: string;
  position: string;
  academicDegree: string;
  departmentId: string;
  departmentName: string;
  facultyName: string;
}

interface StudentProfile {
  id: string;
  fullName: string;
  recordBookNumber: string;
  groupId: string;
  groupName: string;
  courseYear: number;
  studyForm: string;
  specialtyId: string;
  specialtyName: string;
  specialtyCode: string;
  facultyName: string;
}

/** One discipline of the student's own plan, for the semester (or semesters) on screen. */
interface CurriculumRow {
  /** The `curriculum_items` id — *not* the course's; see `courseId`. */
  id: string;
  semester: number;
  /** `courses.id` behind {@link CurriculumRow.courseName} — what the table links each line to. */
  courseId: string;
  courseName: string;
  courseType: string;
  controlForm: string;
  ectsCredits: number;
  /** hourType → hours, exactly as `curriculum_item_hours` stores them. */
  hours: Record<string, number>;
  /** LECTURE + PRACTICAL + LAB — the hours a student is actually in a room for. */
  contactHours: number;
  totalHours: number;
}

/**
 * «Мій кабінет» — the one screen written for the person the account *belongs to* rather than for
 * whoever administers them.
 *
 * Every other page in this app is a deanery instrument: it asks "how loaded is this department",
 * "is this plan within ст. 5", "where can this class go". A lecturer and a student have a much
 * narrower question — *what am I carrying, and when do I have to be where* — and answering it used
 * to mean knowing your own id and typing `/lecturer/123`. `users.lecturer_id` / `users.student_id`
 * (see `schema.sql`) make that resolvable from the session instead, and this page is what they are
 * for. It replaced the old `/timetable` grid, which showed every class in the university with no
 * scope and no semester filter, so autumn and spring overlapped in the same cells.
 *
 * **Nothing here is a permission.** The link says who you are, not what you may edit: the tabs are
 * read-only, and a lecturer who is also a завідувач still reaches everything else through the
 * department page exactly as before. That separation is deliberate — see `AuthService.personLink`.
 *
 * **One semester control governs the whole page.** The workload table, the curriculum table and the
 * timetable grid all follow the picker in the header, which starts on `current_semester_parity`.
 * Two controls that could disagree about which half-year is on screen would be worse than none:
 * a student comparing their plan against their timetable has to be looking at the same term in
 * both. That is why `TimetableView` grew an `externalSemesterParity` input rather than this page
 * mounting it with its own picker still showing.
 */
@Component({
  selector: 'app-me-page',
  templateUrl: './me-page.html',
  imports: [FormsModule, RouterLink, SearchSelect, TimetableView]
})
export class MyDeskPage implements OnInit {
  private gql = inject(GraphqlService);
  private settings = inject(GlobalPropertiesService);
  auth = inject(AuthService);

  readonly positionLabel = positionLabel;
  readonly courseTypeLabel = courseTypeLabel;
  readonly termLabel = termLabel;
  readonly termLabelShort = termLabelShort;
  readonly fmtNumber = fmtNumber;
  readonly STAT_HOUR_TYPES = STAT_HOUR_TYPES;

  readonly parityOptions = SEMESTER_PARITY_OPTIONS;

  /** 'ODD' / 'EVEN' — seeded from `current_semester_parity`, then whatever the reader picks. This
   *  page shows a plan and a timetable side by side, and both name one half-year, never the year. */
  semesterParity = signal('ODD');
  activeSection = signal<DeskSection>('timetable');

  loading = signal(false);
  error = signal('');

  lecturer = signal<LecturerProfile | null>(null);
  /** The lecturer's own row of the department-wide statistics — the same arithmetic «Зведене
   *  навантаження» and «Оцінка навантаження» show, so the three cannot disagree. */
  stats = signal<LecturerStats | null>(null);

  student = signal<StudentProfile | null>(null);
  curriculum = signal<CurriculumRow[]>([]);

  /** 'lecturer' | 'student' | null — read from the session, not from a route parameter. */
  readonly role = computed(() => this.auth.personLink());

  readonly sections = computed<{ key: DeskSection; label: string }[]>(() =>
    this.role() === 'lecturer'
      ? [{ key: 'workload',   label: '&#x1F4CA; Моє навантаження' },
         { key: 'timetable',  label: '&#x1F4C5; Мій розклад' }]
      : [{ key: 'curriculum', label: '&#x1F4D8; Мій навчальний план' },
         { key: 'timetable',  label: '&#x1F4C5; Мій розклад' }]);

  /** Half of the academic year the picker names. Always one or the other — see `parityOptions`. */
  private readonly selectedHalf = computed<1 | 2>(() => this.semesterParity() === 'EVEN' ? 2 : 1);

  readonly parityTitle = computed(() =>
    this.selectedHalf() === 1 ? 'перше півріччя (непарні семестри)'
                              : 'друге півріччя (парні семестри)');

  // ── Lecturer: the positions they carry, narrowed to the half-year on screen ──────────────────

  readonly workloadItems = computed<StatItem[]>(() => {
    const s = this.stats();
    if (!s) return [];
    const half = this.selectedHalf();
    const items = s.items.filter((i) => halfYearOf(i.semester) === half);
    return [...items].sort((a, b) => a.semester - b.semester
      || compareUk(a.courseName, b.courseName)
      || compareUk(a.hourType, b.hourType));
  });

  readonly workloadSummary = computed(() => {
    const s = this.stats();
    const items = this.workloadItems();
    return {
      positions: items.length,
      hours: items.reduce((sum, i) => sum + i.hours, 0),
      // Counted the way MAX_COURSES counts a discipline: only teaching work makes one "taught".
      courses: new Set(items.filter((i) => ['LECTURE', 'PRACTICAL', 'LAB'].includes(i.hourType))
        .map((i) => i.courseName)).size,
      groups: new Set(items.flatMap((i) => i.groupNames)).size,
      /** Always the whole year: a ceiling is annual, so showing it against half the load would lie. */
      annualHours: s?.totalHours ?? 0,
      minHours: s?.minHours ?? null,
      maxHours: s?.effectiveMaxHours ?? null,
      maxIsDefault: s?.maxIsDefault ?? false,
      deviation: s?.deviation ?? 0
    };
  });

  /** Hours by kind of work within the half-year on screen. */
  readonly workloadByHourType = computed<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const t of STAT_HOUR_TYPES) out[t] = 0;
    for (const i of this.workloadItems()) out[i.hourType] = (out[i.hourType] ?? 0) + i.hours;
    return out;
  });

  // ── Student: the semesters their навчальний план is read for, and its rows ──────────────────

  /**
   * Which programme-wide semesters the student is in. `academic_groups.course_year` says which year
   * they are on and the picker says which half of it, so semester = (year − 1) × 2 + half; with the
   * whole year selected, both. The model stores no per-student semester, and this is the derivation
   * every other screen uses in the other direction (`courseYearOf` / `halfYearOf` in entities.ts).
   */
  readonly targetSemesters = computed<number[]>(() => {
    const year = this.student()?.courseYear ?? 0;
    if (!year) return [];
    const base = (year - 1) * 2;
    return [base + this.selectedHalf()];
  });

  readonly curriculumRows = computed<CurriculumRow[]>(() => {
    const wanted = new Set(this.targetSemesters());
    return this.curriculum()
      .filter((r) => wanted.has(r.semester))
      .sort((a, b) => a.semester - b.semester || compareUk(a.courseName, b.courseName));
  });

  readonly curriculumSummary = computed(() => {
    const rows = this.curriculumRows();
    return {
      courses: rows.length,
      credits: rows.reduce((sum, r) => sum + (r.ectsCredits ?? 0), 0),
      contactHours: rows.reduce((sum, r) => sum + r.contactHours, 0),
      totalHours: rows.reduce((sum, r) => sum + r.totalHours, 0),
      exams: rows.filter((r) => r.controlForm === 'EXAM').length,
      credited: rows.filter((r) => r.controlForm !== 'EXAM').length
    };
  });

  /** Ids for `TimetableView`; arrays because its filters are id lists. */
  readonly lecturerIds = computed(() => {
    const id = this.lecturer()?.id;
    return id ? [id] : [];
  });

  readonly academicGroupIds = computed(() => {
    const id = this.student()?.groupId;
    return id ? [id] : [];
  });

  readonly timetableSubject = computed(() =>
    this.role() === 'lecturer' ? this.lecturer()?.fullName ?? '' : this.student()?.groupName ?? '');

  readonly timetableFaculty = computed(() =>
    this.role() === 'lecturer' ? this.lecturer()?.facultyName ?? '' : this.student()?.facultyName ?? '');

  /** Whether the stored half-year has been applied, or the reader has already chosen one. */
  private paritySeeded = false;

  /** The half-year that is actually running is the useful default; the reader may pick another.
   *  An effect, not a microtask — see `TimetableView`'s constructor for why. */
  constructor() {
    effect(() => {
      const settled = this.settings.loaded() || !!this.settings.error();
      if (!settled || this.paritySeeded) return;
      this.paritySeeded = true;
      const current = this.settings.value('current_semester_parity');
      if (current === 'ODD' || current === 'EVEN') this.semesterParity.set(current);
    });
  }

  onParityChange(value: string) {
    this.paritySeeded = true;
    this.semesterParity.set(value === 'EVEN' ? 'EVEN' : 'ODD');
  }

  ngOnInit() {
    this.settings.ensureLoaded();

    const role = this.role();
    this.activeSection.set(role === 'lecturer' ? 'workload' : role === 'student' ? 'curriculum' : 'timetable');
    if (role === 'lecturer') this.loadLecturer();
    else if (role === 'student') this.loadStudent();
  }

  selectSection(key: DeskSection) { this.activeSection.set(key); }

  hourTypeLabel(v: string): string {
    return HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  controlFormLabel(v: string): string {
    return CONTROL_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  studyFormLabel(v: string): string {
    return STUDY_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  deviationLabel(d: number): string { return !d ? '' : d > 0 ? `+${d}` : String(d); }

  // ── Loading ─────────────────────────────────────────────────────────────────────────────────

  /**
   * A lecturer's own figures come from the *department's* whole tree, not from their workloads
   * alone: `computeStats` needs every position of the department to count distinct disciplines and
   * to apply the same rules the two department views apply (several lecturers on one item each
   * accrue the full hours; individual work costs hours × students). Reusing it is what keeps «Моє
   * навантаження» and «Зведене навантаження» from ever quoting different totals for the same person.
   */
  private loadLecturer() {
    const lecturerId = this.auth.currentUser()?.lecturerId;
    if (!lecturerId) return;
    this.loading.set(true);

    const profileQuery = `{
      lecturers { lecturer(id: "${lecturerId}") {
        id firstName middleName lastName position
        academicDegree { name }
        department { id name faculty { name } }
        workloadConstraints { constraintType value }
      } }
      globalProperties { globalProperty(name: "default_max_hours_per_year") { value } }
    }`;

    this.gql.request(profileQuery).subscribe({
      next: (d: any) => {
        const l = d.lecturers?.lecturer;
        if (!l) {
          // The account outlived the lecturer row it pointed at (ON DELETE SET NULL keeps the
          // account, so this is reachable only between the delete and an admin re-linking).
          this.error.set('Обліковий запис пов’язаний із викладачем, якого вже немає в системі. ' +
                         'Зверніться до адміністратора.');
          this.loading.set(false);
          return;
        }
        const name = [l.lastName, l.firstName, l.middleName].filter(Boolean).join(' ');
        const departmentId = l.department?.id ?? '';
        this.lecturer.set({
          id: l.id,
          fullName: name,
          position: l.position ?? '',
          academicDegree: l.academicDegree?.name ?? '',
          departmentId,
          departmentName: l.department?.name ?? '',
          facultyName: l.department?.faculty?.name ?? ''
        });

        const raw = d.globalProperties?.globalProperty?.value;
        const parsed = raw != null ? Number(raw) : NaN;
        const defaultMaxHoursPerYear = Number.isFinite(parsed) ? parsed : null;
        const constraints = Object.fromEntries(
          (l.workloadConstraints ?? []).map((c: any) => [c.constraintType, c.value]));

        if (!departmentId) { this.loading.set(false); return; }
        loadDepartmentWorkloads(this.gql, departmentId).subscribe({
          next: (workloads) => {
            const rows = computeStats({
              workloads,
              lecturers: [{ id: l.id, name, constraints }],
              defaultMaxHoursPerYear
            });
            this.stats.set(rows[0] ?? null);
            this.error.set('');
            this.loading.set(false);
          },
          error: (e) => { this.error.set(e.message); this.loading.set(false); }
        });
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }

  /**
   * The student's plan is their *specialty's* plan — `curriculum_items` hang off a specialty, not
   * off a cohort — narrowed to the semesters their course year and the picker name. There is no
   * per-student curriculum in the model and there should not be one: what a student is entitled to
   * see is the programme they are enrolled in.
   */
  private loadStudent() {
    const studentId = this.auth.currentUser()?.studentId;
    if (!studentId) return;
    this.loading.set(true);

    const q = `{ students { student(id: "${studentId}") {
      id firstName middleName lastName recordBookNumber
      academicGroup {
        id name courseYear studyForm
        specialty { id name code degree faculty { name } }
      }
    } } }`;

    this.gql.request(q).subscribe({
      next: (d: any) => {
        const s = d.students?.student;
        if (!s) {
          this.error.set('Обліковий запис пов’язаний зі студентом, якого вже немає в системі. ' +
                         'Зверніться до адміністратора.');
          this.loading.set(false);
          return;
        }
        const g = s.academicGroup;
        const specialtyId = g?.specialty?.id ?? '';
        this.student.set({
          id: s.id,
          fullName: [s.lastName, s.firstName, s.middleName].filter(Boolean).join(' '),
          recordBookNumber: s.recordBookNumber ?? '',
          groupId: g?.id ?? '',
          groupName: g?.name ?? '',
          courseYear: g?.courseYear ?? 0,
          studyForm: g?.studyForm ?? '',
          specialtyId,
          specialtyName: g?.specialty?.name ?? '',
          specialtyCode: g?.specialty?.code ?? '',
          facultyName: g?.specialty?.faculty?.name ?? ''
        });

        if (!specialtyId) { this.loading.set(false); return; }
        this.loadCurriculum(specialtyId);
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }

  private loadCurriculum(specialtyId: string) {
    // The whole plan is fetched and narrowed here rather than per semester: the picker moves
    // between two semesters of the same programme, and re-querying on every switch would cost a
    // round trip to show rows already in hand. A specialty's plan is ~60 rows.
    const q = `{ curriculumItems { curriculumItemConnection(limit: 1000, offset: 0, specialtyId: "${specialtyId}") { nodes {
      id semester controlForm ectsCredits
      course { id name courseType tags { tag } }
      hours { hourType hours }
    } } } }`;

    this.gql.request(q).subscribe({
      next: (d: any) => {
        const nodes = d.curriculumItems.curriculumItemConnection.nodes ?? [];
        this.curriculum.set(nodes.map((n: any) => {
          const hours: Record<string, number> = {};
          for (const h of n.hours ?? []) hours[h.hourType] = h.hours ?? 0;
          const contact = ['LECTURE', 'PRACTICAL', 'LAB']
            .reduce((sum, t) => sum + (hours[t] ?? 0), 0);
          return {
            id: n.id,
            semester: n.semester ?? 0,
            // The tag is part of how a discipline is named on paper («Database Systems
            // (англійською)»), so it travels with the name rather than into a column of its own.
            courseId: n.course?.id ? String(n.course.id) : '',
            courseName: courseLabel(n.course?.name, n.course?.tags),
            courseType: n.course?.courseType ?? '',
            controlForm: n.controlForm ?? '',
            ectsCredits: n.ectsCredits ?? 0,
            hours,
            contactHours: contact,
            totalHours: Object.values(hours).reduce((sum: number, v: number) => sum + v, 0)
          } as CurriculumRow;
        }));
        this.error.set('');
        this.loading.set(false);
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }
}
