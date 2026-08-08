import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { GlobalPropertiesService } from './global-properties.service';
import { courseTypeLabel, CONTROL_FORM_OPTIONS, COURSE_TYPE_OPTIONS, DAY_OF_WEEK_OPTIONS,
         HOUR_TYPE_OPTIONS, TEACHING_FORMAT_OPTIONS, WEEK_PARITY_OPTIONS,
         termLabelShort, toOptions } from './entities';
import { fmtNumber, fmtOrDash } from './curriculum-plan';
import { HOUR_TYPE_SHORT, POSITION_SHORT } from './timetable-grid';
import { SearchSelect, Option } from './search-select';
import { MultiSelect } from './multi-select';
import { compareUk } from './sort';
import { CourseTagRef, courseLabel, courseTagNames } from './course-label';

type CourseSection = 'info' | 'electives' | 'curricula' | 'working' | 'workloads' | 'timetable';

interface CourseInfo {
  id: string;
  name: string;
  courseType: string;
  faculty?: { id: string; name: string } | null;
  department?: { id: string; name: string; faculty?: { id: string; name: string } | null } | null;
  parentCourse?: { id: string; name: string; tags?: CourseTagRef[] | null } | null;
  childCourses?: { id: string; name: string; courseType: string; tags?: CourseTagRef[] | null }[];
  specialties?: { id: string; name: string; code?: string }[];
  tags?: CourseTagRef[];
}

/** One curriculum_items row this course appears in, with everything hanging off it. */
interface CurriculumRow {
  id: string;
  semester: number;
  controlForm: string;
  ectsCredits?: number;
  specialty?: { id: string; name: string; code?: string; degree?: string } | null;
  hours: {
    id: string;
    hourType: string;
    hours: number;
    workingCurriculumItems: {
      id: string;
      lecturerCount: number;
      teachingFormat: string;
      /** Combined positions this one has been merged into; its own workloads move there. */
      combinedWorkingCurriculumItems?: { id: string; workloads?: WorkloadRow[] }[];
      department?: { id: string; name: string; faculty?: { id: string } | null } | null;
      /** The elective actually chosen, set only when this item's discipline is an ELECTIVE_GROUP. */
      course?: { id: string; name: string; tags?: CourseTagRef[] | null } | null;
      academicGroups?: { id: string; name: string }[];
      workloads?: WorkloadRow[];
    }[];
  }[];
}

/** A working curriculum item found by the course filter rather than by walking this course's plan. */
interface ExtraWorkingItem {
  id: string;
  lecturerCount: number;
  teachingFormat: string;
  combinedWorkingCurriculumItems?: { id: string; workloads?: WorkloadRow[] }[];
  department?: { id: string; name: string; faculty?: { id: string } | null } | null;
  course?: { id: string; name: string; tags?: CourseTagRef[] | null } | null;
  academicGroups?: { id: string; name: string }[];
  workloads?: WorkloadRow[];
  curriculumItemHours?: {
    id: string;
    hourType: string;
    hours: number;
    curriculumItem?: {
      id: string;
      semester: number;
      ectsCredits?: number;
      specialty?: { id: string; name: string } | null;
      course?: { id: string; name: string; courseType?: string; tags?: CourseTagRef[] | null } | null;
    } | null;
  } | null;
}

interface WorkloadRow {
  id: string;
  durationHours?: number;
  classStartTimeSet?: { id: string; name: string } | null;
  lecturers?: { id: string; firstName?: string; lastName?: string; position?: string }[];
  academicGroups?: { id: string; name: string }[];
  combinedGroups?: { id: string; name: string }[];
  rooms?: { id: string; number: string; name?: string | null }[];
  roomGroups?: { id: string; name: string }[];
  timetableEntries?: EntryRow[];
}

/** One `timetable_entries` row — a class actually placed in the week. */
interface EntryRow {
  id: string;
  dayOfWeek: number;
  weekParity: string;
  classStartTime?: { id: string; ordinal: number; startTime: string } | null;
  room?: { id: string; number: string; name?: string | null } | null;
}

/**
 * One `lecturer_workloads` row of this discipline, with the context the editor needs: which РНП
 * position it belongs to (and so which groups may be assigned), which кафедра holds it (and so
 * which lecturers), and which факультет that кафедра belongs to (and so which bells and rooms).
 */
interface WorkloadCard {
  id: string;
  workingCurriculumItemId: string;
  specialtyName: string;
  semester: number;
  hourType: string;
  departmentId: string;
  departmentName: string;
  facultyId: string;
  teachingFormat: string;
  durationHours: number;
  startTimeSetId: string;
  startTimeSetName: string;
  lecturerIds: string[];
  lecturerNames: string;
  groupIds: string[];
  groupNames: string;
  combinedGroupIds: string[];
  combinedGroupNames: string;
  roomIds: string[];
  roomGroupIds: string[];
  roomLabel: string;
  scheduledClasses: number;
  /** The groups this position may assign — its working curriculum item's own. */
  availableGroups: Option[];
  /** This workload's placed classes, for the «Розклад занять» tab. */
  entries: EntryRow[];
  /** `curriculum_item_hours.hours` behind this position — what `expectedClasses` divides up. */
  hours: number;
  /** Lecturers and groups this row already holds, so a stored value outside the scoped option
   *  list is still shown rather than silently rendered as nothing — see `mergeHeld`. */
  heldLecturers: Option[];
  heldGroups: Option[];
}

/** A flattened delivery position, which is how the working-curriculum and workload tabs read. */
interface DeliveryRow {
  id: string;
  /** The `curriculum_item_hours` row this delivers — the FK the editor writes back. */
  hoursId: string;
  specialtyId: string;
  specialtyName: string;
  semester: number;
  hourType: string;
  hours: number;
  departmentId: string;
  departmentName: string;
  lecturerCount: number;
  teachingFormat: string;
  groupNames: string;
  lecturerNames: string;
  workloadCount: number;
  scheduledClasses: number;
  /** The chosen elective, when this course is an umbrella. */
  electiveCourseId: string;
  electiveLabel: string;
  groupIds: string[];
  /** True once this position has been merged into a combined one: its teaching is carried there,
   *  so adding a workload here would create a second, parallel assignment. */
  merged?: boolean;
  /** Set when this position sits under a *different* discipline's plan slot — an elective chosen
   *  out of an ELECTIVE_GROUP. Blank for an ordinary delivery of this course. */
  viaUmbrella?: string;
}

/**
 * Everything the system knows about one discipline, in one place.
 *
 * A `Course` is referenced from four directions — it sits in curricula, those curricula's hour
 * blocks are handed to departments as working curriculum items, those become lecturer workloads,
 * and those become classes in the timetable — and until now the only way to see any of it was to
 * walk the specialty and department pages one at a time. This page walks the chain once, in a
 * single query, and shows what it adds up to: which curricula the discipline appears in, which
 * кафедри deliver it to which groups, and which lecturers actually carry it.
 *
 * The info tab also edits and deletes the discipline, exactly as `FacultyPage` does for a faculty:
 * a modal over the entity's own fields — including the `specialtyIds` many-to-many and the `tags`
 * nested list the generic table offers — and a confirmation before `deleteCourse`, both hidden
 * unless `canModifyIds('COURSE', …)` says this account may.
 */
@Component({
  selector: 'app-course-page',
  templateUrl: './course-page.html',
  imports: [RouterLink, FormsModule, SearchSelect, MultiSelect]
})
export class CourseDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private gql = inject(GraphqlService);
  private settings = inject(GlobalPropertiesService);
  // Resolved as a field: `inject()` is only legal in an injection context, which ngOnInit is not.
  private destroyRef = inject(DestroyRef);
  auth = inject(AuthService);

  /**
   * Not `readonly`, and not read once from the snapshot.
   *
   * This page links to other courses on the same route — the parent «Група вибіркових», the child
   * electives, the elective chosen in a РНП row — and the router reuses a component across a
   * navigation that only changes a parameter. Reading the snapshot once left the id pointing at the
   * course the reader arrived on: the URL changed, nothing else did. It is driven by `paramMap`
   * instead, which emits the current value on subscribe and again on every such navigation.
   */
  courseId: string = this.route.snapshot.paramMap.get('id')!;
  readonly courseTypeLabel = courseTypeLabel;
  readonly termLabelShort = termLabelShort;
  readonly fmtNumber = fmtNumber;
  readonly fmtOrDash = fmtOrDash;
  readonly courseTypeOptions = toOptions(COURSE_TYPE_OPTIONS);
  /** What an elective inside a group may be — anything but another group. Nesting umbrellas would
   *  put a group in its own elective picker, with nothing to actually teach at the bottom. */
  readonly childCourseTypeOptions = toOptions(
    COURSE_TYPE_OPTIONS.filter((o) => o.value !== 'ELECTIVE_GROUP'));

  /**
   * «Вибіркові дисципліни» appears only on an umbrella. An `ELECTIVE_GROUP` is a slot in a
   * curriculum that a group later fills with one of its children (see `WorkingCurriculumItem.course`),
   * so its children are its content; on any other course type the section would be an empty table
   * explaining nothing.
   */
  sections = computed<{ key: CourseSection; label: string }[]>(() => [
    { key: 'info',      label: '&#x2139; Інформація' },
    ...(this.isElectiveGroup()
      ? [{ key: 'electives' as CourseSection, label: '&#x1F500; Вибіркові дисципліни' }]
      : []),
    { key: 'curricula', label: '&#x1F4CB; Навчальні плани' },
    { key: 'working',   label: '&#x1F5C2; Робочі навчальні плани' },
    { key: 'workloads', label: '&#x1F464; Навантаження викладачів' },
    { key: 'timetable', label: '&#x1F4C5; Розклад занять' }
  ]);

  isElectiveGroup = computed(() => this.course()?.courseType === 'ELECTIVE_GROUP');

  /**
   * The section actually rendered. «Вибіркові дисципліни» exists only on an umbrella, and the tab
   * can outlive it two ways — navigating from a group to one of its children, and changing this
   * course's own type in the edit modal. Either would otherwise leave `@switch` matching no case at
   * all, which is a blank page rather than an error.
   */
  resolvedSection = computed<CourseSection>(() => {
    const key = this.activeSection();
    return this.sections().some((sec) => sec.key === key) ? key : 'info';
  });

  /** This umbrella's electives — the section's rows. */
  childCourses = computed(() => [...(this.course()?.childCourses ?? [])]
    .sort((a, b) => compareUk(courseLabel(a.name, a.tags), courseLabel(b.name, b.tags))));

  course = signal<CourseInfo | null>(null);
  curricula = signal<CurriculumRow[]>([]);
  /** Working items reached through `workingCurriculumItemConnection(courseId:)` — see `deliveries`. */
  private extraWorkingItems = signal<ExtraWorkingItem[]>([]);
  error = signal('');
  loading = signal(false);
  activeSection = signal<CourseSection>('info');

  /** Whether the current user may edit/delete this Course — see AuthService#canModifyIds. */
  canModifyCourse = signal(false);

  /**
   * Specialties and departments this account may edit, for the plan editors below.
   *
   * A Course grant authorises all of them — `CurriculumItem` and `WorkingCurriculumItem` both name
   * Course among their `@PermissionParent`s, and the server ORs over the whole ancestor closure —
   * but it is not the *only* thing that does. A гарант of one specialty may edit that specialty's
   * plan positions without any right over the discipline itself, and gating the whole page on the
   * course alone would show them nothing to click. These are the other two ancestors, asked for
   * once the rows are known.
   */
  private modifiableSpecialties = signal<ReadonlySet<string>>(new Set());
  private modifiableDepartments = signal<ReadonlySet<string>>(new Set());

  /** May this plan position be edited: through the discipline, or through its specialty. */
  canModifyItem(item: CurriculumRow): boolean {
    return this.canModifyCourse()
      || (!!item.specialty && this.modifiableSpecialties().has(String(item.specialty.id)));
  }

  /** May this РНП position be edited: through the discipline, or through the кафедра holding it. */
  canModifyDelivery(row: DeliveryRow): boolean {
    return this.canModifyCourse() || this.modifiableDepartments().has(row.departmentId);
  }

  /** Whether anything at all on the plan tabs is editable — what the "+ add" buttons need. */
  canAddPlans = computed(() =>
    this.canModifyCourse() || this.modifiableSpecialties().size > 0);
  canAddDeliveries = computed(() =>
    this.canModifyCourse() || this.modifiableDepartments().size > 0);

  /**
   * Asks about the specialties and departments actually on screen, once they are known. Admins
   * short-circuit, and a course-wide grant makes the question moot.
   */
  private loadRowPermissions() {
    if (this.auth.isAdmin() || this.canModifyCourse()) return;

    const specialtyIds = [...new Set(this.curricula()
      .map((i) => i.specialty?.id).filter(Boolean).map(String))];
    const departmentIds = [...new Set(this.deliveries().map((d) => d.departmentId).filter(Boolean))];

    if (specialtyIds.length) {
      this.auth.canModifyIds('SPECIALTY', specialtyIds)
        .subscribe((ids) => this.modifiableSpecialties.set(ids));
    }
    if (departmentIds.length) {
      this.auth.canModifyIds('DEPARTMENT', departmentIds)
        .subscribe((ids) => this.modifiableDepartments.set(ids));
    }
  }

  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};

  showDeleteConfirm = signal(false);
  deleteError = signal('');

  facultyOptions = signal<Option[]>([]);
  departmentOptions = signal<Option[]>([]);
  specialtyOptions = signal<Option[]>([]);
  /** Every course, kept whole so the umbrella picker below can be derived from it. */
  private allCourses = signal<{ id: string; name: string; courseType: string; tags?: CourseTagRef[] | null }[]>([]);

  /**
   * A `parentCourse` is only ever an umbrella `ELECTIVE_GROUP`, so the picker offers those rather
   * than the several thousand courses the generic form lists — plus whatever is currently stored,
   * even if it is not one, because opening an edit form must never silently drop a stored value.
   */
  parentCourseOptions = computed<Option[]>(() => {
    const current = this.course()?.parentCourse?.id ?? '';
    return this.allCourses()
      .filter((c) => c.id !== this.courseId && (c.courseType === 'ELECTIVE_GROUP' || c.id === current))
      .map((c) => ({ id: c.id, label: courseLabel(c.name, c.tags) }));
  });

  /**
   * Which specialties this discipline may be added to: the ones it is offered to
   * (`course_specialties`), plus any it is already in — a stored value must never vanish from the
   * picker that edits it. Falls back to every specialty when the course names none, since an empty
   * picker would block the page entirely.
   */
  itemSpecialtyOptions = computed<Option[]>(() => {
    const allowed = new Set((this.course()?.specialties ?? []).map((sp) => String(sp.id)));
    for (const item of this.curricula()) if (item.specialty) allowed.add(String(item.specialty.id));
    if (!allowed.size) return this.specialtyOptions();
    return this.specialtyOptions().filter((o) => allowed.has(o.id));
  });

  /**
   * Every delivery position of this discipline.
   *
   * Two sources, because a working curriculum item names a course in two different senses. Walking
   * the curriculum tree finds the positions that *deliver* this discipline. But an `ELECTIVE`
   * chosen out of a group sits in no curriculum of its own — the umbrella holds the plan position,
   * and the child is named by `working_curriculum_items.course_id` — so its page would show an
   * empty РНП tab. `workingCurriculumItemConnection(courseId:)` ORs both directions server-side,
   * which is exactly the filter it was added for; the two are merged by id.
   */
  deliveries = computed<DeliveryRow[]>(() => {
    const rows: DeliveryRow[] = [];
    const seen = new Set<string>();

    for (const item of this.curricula()) {
      for (const block of item.hours ?? []) {
        for (const wci of block.workingCurriculumItems ?? []) {
          seen.add(String(wci.id));
          const lecturers = new Map<string, string>();
          let scheduled = 0;
          for (const w of wci.workloads ?? []) {
            scheduled += (w.timetableEntries ?? []).length;
            for (const l of w.lecturers ?? []) {
              const post = POSITION_SHORT[l.position ?? ''] ?? '';
              const name = `${(l.lastName ?? '').trim()} ${(l.firstName ?? '').trim().charAt(0)}.`.trim();
              lecturers.set(l.id, post ? `${post} ${name}` : name);
            }
          }
          rows.push({
            id: wci.id,
            hoursId: block.id,
            specialtyId: item.specialty?.id ?? '',
            specialtyName: item.specialty?.name ?? '—',
            semester: item.semester,
            hourType: block.hourType,
            hours: block.hours,
            departmentId: wci.department?.id ?? '',
            departmentName: wci.department?.name ?? '—',
            lecturerCount: wci.lecturerCount,
            teachingFormat: wci.teachingFormat,
            groupNames: (wci.academicGroups ?? []).map((g) => g.name).sort(compareUk).join(', '),
            lecturerNames: [...lecturers.values()].sort(compareUk).join(', '),
            workloadCount: (wci.workloads ?? []).length,
            scheduledClasses: scheduled,
            electiveCourseId: wci.course?.id ?? '',
            electiveLabel: wci.course ? courseLabel(wci.course.name, wci.course.tags) : '',
            groupIds: (wci.academicGroups ?? []).map((g) => String(g.id)),
            merged: (wci.combinedWorkingCurriculumItems ?? []).length > 0,
            viaUmbrella: ''
          });
        }
      }
    }

    for (const wci of this.extraWorkingItems()) {
      if (seen.has(String(wci.id))) continue;
      const ci = wci.curriculumItemHours?.curriculumItem;
      const lecturers = new Map<string, string>();
      let scheduled = 0;
      for (const w of wci.workloads ?? []) {
        scheduled += (w.timetableEntries ?? []).length;
        for (const l of w.lecturers ?? []) {
          const post = POSITION_SHORT[l.position ?? ''] ?? '';
          const name = `${(l.lastName ?? '').trim()} ${(l.firstName ?? '').trim().charAt(0)}.`.trim();
          lecturers.set(l.id, post ? `${post} ${name}` : name);
        }
      }
      rows.push({
        id: wci.id,
        hoursId: wci.curriculumItemHours?.id ?? '',
        specialtyId: ci?.specialty?.id ?? '',
        specialtyName: ci?.specialty?.name ?? '—',
        semester: ci?.semester ?? 0,
        hourType: wci.curriculumItemHours?.hourType ?? '',
        hours: wci.curriculumItemHours?.hours ?? 0,
        departmentId: wci.department?.id ?? '',
        departmentName: wci.department?.name ?? '—',
        lecturerCount: wci.lecturerCount,
        teachingFormat: wci.teachingFormat,
        groupNames: (wci.academicGroups ?? []).map((g) => g.name).sort(compareUk).join(', '),
        lecturerNames: [...lecturers.values()].sort(compareUk).join(', '),
        workloadCount: (wci.workloads ?? []).length,
        scheduledClasses: scheduled,
        electiveCourseId: wci.course?.id ?? '',
        electiveLabel: wci.course ? courseLabel(wci.course.name, wci.course.tags) : '',
        groupIds: (wci.academicGroups ?? []).map((g) => String(g.id)),
        merged: (wci.combinedWorkingCurriculumItems ?? []).length > 0,
        /** Delivered under another discipline's plan position — this course was chosen for it. */
        viaUmbrella: ci?.course ? courseLabel(ci.course.name, ci.course.tags) : ''
      });
    }

    return rows.sort((a, b) => a.semester - b.semester
      || compareUk(a.specialtyName, b.specialtyName)
      || compareUk(a.departmentName, b.departmentName));
  });

  /** The headline the info tab opens with: where this discipline is taught, and how much of it. */
  summary = computed(() => {
    const perCredit = this.settings.numberValue('hours_per_ects_credit') ?? 30;
    const specialties = new Set<string>();
    const departments = new Set<string>();
    const groups = new Set<string>();
    const lecturers = new Set<string>();

    // Plan positions and their hour blocks, keyed so a block reached from several working items is
    // counted once. An ELECTIVE has none of its own — it is delivered under its umbrella's slot —
    // so the blocks its РНП positions point at are gathered from those positions instead. Without
    // that, every tile on an elective's page read zero while its own «Розклад занять» tab listed
    // real lecturers, groups and classes.
    const planItems = new Map<string, { ectsCredits: number; specialtyId: string }>();
    const blocks = new Map<string, { hourType: string; hours: number }>();

    for (const item of this.curricula()) {
      planItems.set(String(item.id), {
        ectsCredits: item.ectsCredits ?? 0,
        specialtyId: item.specialty?.id ? String(item.specialty.id) : ''
      });
      for (const block of item.hours ?? []) {
        blocks.set(String(block.id), { hourType: block.hourType, hours: block.hours ?? 0 });
      }
    }

    for (const wci of this.extraWorkingItems()) {
      const ci = wci.curriculumItemHours?.curriculumItem;
      if (ci?.id && !planItems.has(String(ci.id))) {
        planItems.set(String(ci.id), {
          ectsCredits: ci.ectsCredits ?? 0,
          specialtyId: ci.specialty?.id ? String(ci.specialty.id) : ''
        });
      }
      const block = wci.curriculumItemHours;
      if (block?.id && !blocks.has(String(block.id))) {
        blocks.set(String(block.id), { hourType: block.hourType, hours: block.hours ?? 0 });
      }
    }

    let credits = 0;
    for (const item of planItems.values()) {
      credits += item.ectsCredits;
      if (item.specialtyId) specialties.add(item.specialtyId);
    }

    let contactHours = 0;
    for (const block of blocks.values()) {
      if (block.hourType !== 'INDEPENDENT_WORK') contactHours += block.hours;
    }

    // Who delivers it, from both levels. The РНП positions decide which кафедри carry the
    // discipline and to which groups — a position with no workload yet still has both — while the
    // workloads add the lecturers actually assigned and the classes actually placed. Both lists
    // already walk the curriculum tree and the positions reached by the course filter, deduped.
    for (const row of this.deliveries()) {
      if (row.departmentId) departments.add(row.departmentId);
      for (const id of row.groupIds) groups.add(id);
    }

    let scheduled = 0;
    for (const card of this.workloadCards()) {
      if (card.departmentId) departments.add(card.departmentId);
      for (const id of card.groupIds) groups.add(id);
      for (const id of card.lecturerIds) lecturers.add(id);
      scheduled += card.scheduledClasses;
    }

    return {
      curriculumItems: planItems.size,
      specialties: specialties.size,
      departments: departments.size,
      groups: groups.size,
      lecturers: lecturers.size,
      credits,
      contactHours,
      normativeHours: credits * perCredit,
      positions: this.deliveries().length,
      scheduledClasses: scheduled,
      /** True when nothing here is this discipline's own plan position — see the note on the tab. */
      viaUmbrellaOnly: this.curricula().length === 0 && planItems.size > 0
    };
  });

  /** The umbrella this elective is delivered under, named for the info tab's note. */
  umbrellaLabel = computed(() => {
    const parent = this.course()?.parentCourse;
    if (parent) return courseLabel(parent.name, parent.tags);
    for (const wci of this.extraWorkingItems()) {
      const c = wci.curriculumItemHours?.curriculumItem?.course;
      if (c && String(c.id) !== this.courseId) return courseLabel(c.name, c.tags);
    }
    return '';
  });

  ngOnInit() {
    this.settings.ensureLoaded();
    // Course-independent, so it is loaded once rather than per navigation.
    this.loadFormOptions();

    const sub = this.route.paramMap.subscribe((params) => {
      const id = params.get('id');
      if (!id) return;
      this.courseId = id;
      this.resetForCourse();
      this.load();
      this.loadCoursePermission();
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  /**
   * Clears everything that belonged to the previous discipline before the new one loads. Without
   * this the reader sees the old course's plans under the new course's name for the length of a
   * round trip, and any modal left open would save against the wrong id.
   */
  private resetForCourse() {
    this.course.set(null);
    this.curricula.set([]);
    this.extraWorkingItems.set([]);
    this.error.set('');
    this.activeSection.set('info');

    this.canModifyCourse.set(false);
    this.modifiableSpecialties.set(new Set());
    this.modifiableDepartments.set(new Set());

    this.showEditForm.set(false);
    this.showDeleteConfirm.set(false);
    this.pendingItemDelete.set(null);
    this.pendingWciDelete.set(null);
    this.closeChildForm();
    this.closeItemForm();
    this.closeWciForm();
    this.closeWorkloadForm();
    this.pendingWorkloadDelete.set(null);
    this.closeEntryForm();
    this.pendingEntryDelete.set(null);
  }

  private loadCoursePermission() {
    if (this.auth.isAdmin()) { this.canModifyCourse.set(true); return; }
    const id = this.courseId;
    this.auth.canModifyIds('COURSE', [id]).subscribe((ids) => {
      // A late answer about the course the reader has already navigated away from is not an answer
      // about this one.
      if (id === this.courseId) this.canModifyCourse.set(ids.has(id));
    });
  }

  selectSection(key: CourseSection) {
    this.activeSection.set(key);
    // Four unfiltered connections, for pickers only this tab opens — not worth a page view that
    // never leaves «Інформація».
    if (key === 'workloads' || key === 'timetable') {
      this.loadWorkloadOptions();
      this.loadClassStartTimes();
    }
    this.closeChildForm();
    this.closeItemForm();
    this.closeWciForm();
    this.closeWorkloadForm();
    this.closeEntryForm();
  }

  controlFormLabel(v: string): string {
    return CONTROL_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  hourTypeLabel(v: string): string {
    return HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  hourTypeShort(v: string): string { return HOUR_TYPE_SHORT[v] ?? this.hourTypeLabel(v); }

  teachingFormatLabel(v: string): string {
    return TEACHING_FORMAT_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  /** Exposed for the template — the shared rule, see `course-label.ts`. */
  courseLabel = courseLabel;

  /** This course's own tags, on their own line under the heading — this being the page about it,
   *  they get room of their own rather than parentheses. Every *other* course named on this page
   *  (the parent group, the child electives, the picker) is labelled the usual way. */
  tagList(): string {
    return courseTagNames(this.course()?.tags).join(', ');
  }

  /**
   * One query for the whole chain: curriculum item → hours → working item → workload → timetable
   * entries. The backend batches each relation level, so this is four round-trip-free joins rather
   * than an N+1 walk — see the service README's *Relation batching*.
   */
  private load() {
    this.loading.set(true);
    const courseQuery = `{ courses { course(id: "${this.courseId}") {
      id name courseType
      faculty { id name }
      department { id name faculty { id name } }
      parentCourse { id name tags { tag } }
      childCourses { id name courseType tags { id tag } }
      specialties { id name code }
      tags { id tag }
    } } }`;

    // `curriculumItemConnection` gained a `courseId` filter for this page — the connection is the
    // only way in, since Course carries no `curriculumItems` relation of its own.
    const itemsQuery = `{ curriculumItems { curriculumItemConnection(limit: 500, offset: 0, courseId: "${this.courseId}") { nodes {
      id semester controlForm ectsCredits
      specialty { id name code degree }
      hours {
        id hourType hours
        workingCurriculumItems {
          id lecturerCount teachingFormat
          combinedWorkingCurriculumItems { id workloads { id durationHours
            classStartTimeSet { id name }
            lecturers { id firstName lastName position }
            academicGroups { id name }
            combinedGroups { id name }
            rooms { id number name }
            roomGroups { id name }
            timetableEntries { id dayOfWeek weekParity classStartTime { id ordinal startTime } room { id number name } } } }
          department { id name faculty { id } }
          course { id name tags { tag } }
          academicGroups { id name }
          workloads {
            id durationHours
            classStartTimeSet { id name }
            lecturers { id firstName lastName position }
            academicGroups { id name }
            combinedGroups { id name }
            rooms { id number name }
            roomGroups { id name }
            timetableEntries { id dayOfWeek weekParity classStartTime { id ordinal startTime } room { id number name } }
          }
        }
      }
    } } } }`;

    // Every response is checked against the id that is current when it arrives: navigating between
    // two courses leaves two sets of requests in flight, and they do not come back in order.
    const id = this.courseId;
    this.gql.request(courseQuery).subscribe({
      next: (d: any) => { if (id === this.courseId) this.course.set(d.courses.course); },
      error: (e) => { if (id === this.courseId) this.error.set(e.message); }
    });

    // Everything delivering this discipline in either sense — see `deliveries` for why the tree
    // alone is not enough on an elective's page.
    const deliveriesQuery = `{ workingCurriculumItems { workingCurriculumItemConnection(limit: 500, offset: 0, courseId: "${this.courseId}") { nodes {
      id lecturerCount teachingFormat
      combinedWorkingCurriculumItems { id workloads { id durationHours
        classStartTimeSet { id name }
        lecturers { id firstName lastName position }
        academicGroups { id name }
        combinedGroups { id name }
        rooms { id number name }
        roomGroups { id name }
        timetableEntries { id dayOfWeek weekParity classStartTime { id ordinal startTime } room { id number name } } } }
      department { id name faculty { id } }
      course { id name tags { tag } }
      academicGroups { id name }
      curriculumItemHours {
        id hourType hours
        curriculumItem { id semester ectsCredits specialty { id name } course { id name courseType tags { tag } } }
      }
      workloads {
        id durationHours
        classStartTimeSet { id name }
        lecturers { id firstName lastName position }
        academicGroups { id name }
        combinedGroups { id name }
        rooms { id number name }
        roomGroups { id name }
        timetableEntries { id dayOfWeek weekParity classStartTime { id ordinal startTime } room { id number name } }
      }
    } } } }`;

    this.gql.request(itemsQuery).subscribe({
      next: (d: any) => {
        if (id !== this.courseId) return;
        this.curricula.set(
          (d.curriculumItems.curriculumItemConnection.nodes ?? []) as CurriculumRow[]);
        this.loading.set(false);
        this.loadRowPermissions();
      },
      error: (e) => { if (id === this.courseId) { this.error.set(e.message); this.loading.set(false); } }
    });

    this.gql.request(deliveriesQuery).subscribe({
      next: (d: any) => {
        if (id !== this.courseId) return;
        this.extraWorkingItems.set(
          (d.workingCurriculumItems.workingCurriculumItemConnection.nodes ?? []) as ExtraWorkingItem[]);
        this.loadRowPermissions();
      },
      error: () => { if (id === this.courseId) this.extraWorkingItems.set([]); }
    });
  }

  // ── Option lists for the edit form ────────────────────────────────────────

  private loadFormOptions() {
    const q = `{
      faculties { facultyConnection(limit: 200) { nodes { id name } } }
      departments { departmentConnection(limit: 1000) { nodes { id name } } }
      specialties { specialtyConnection(limit: 1000) { nodes { id code name } } }
      courses { courseConnection(limit: 1000) { nodes { id name courseType tags { tag } } } }
    }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        this.facultyOptions.set(
          d.faculties.facultyConnection.nodes.map((f: any) => ({ id: f.id, label: f.name })));
        this.departmentOptions.set(
          d.departments.departmentConnection.nodes.map((x: any) => ({ id: x.id, label: x.name })));
        this.specialtyOptions.set(
          d.specialties.specialtyConnection.nodes.map((sp: any) => ({
            id: sp.id, label: `${sp.code ?? ''} ${sp.name}`.trim()
          })));
        this.allCourses.set(d.courses.courseConnection.nodes ?? []);
      },
      error: () => {}
    });
  }

  // ── Edit ──────────────────────────────────────────────────────────────────

  /** tag text → stored `course_tags` row id for this course's own tags — see `saveEdit`. */
  private ownTagIds = new Map<string, string>();

  openEdit() {
    const c = this.course();
    if (!c) return;
    this.ownTagIds = new Map((c.tags ?? [])
      .filter((t) => t.tag && t.id)
      .map((t) => [t.tag, String(t.id)]));
    this.editForm = {
      name: c.name ?? '',
      courseType: c.courseType ?? '',
      facultyId: c.faculty?.id ?? '',
      departmentId: c.department?.id ?? '',
      parentCourseId: c.parentCourse?.id ?? '',
      specialtyIds: (c.specialties ?? []).map((sp) => String(sp.id)),
      tags: (c.tags ?? []).map((t) => t.tag).filter(Boolean).join(', '),
    };
    this.editError.set('');
    this.showEditForm.set(true);
  }

  closeEdit() { this.showEditForm.set(false); this.editError.set(''); }

  /**
   * Follows `BaseEntity#buildInput` on all three counts, because the same backend rules apply:
   * a cleared optional scalar/FK is sent as an explicit `null` so the column is actually cleared;
   * `specialtyIds` is always sent in full, since omitting a many-to-many field leaves the join
   * table untouched rather than emptying it; and `tags` — a nested list — is likewise always sent,
   * so a removed tag is deleted by not being in the list.
   */
  saveEdit() {
    const required = new Set(['name', 'courseType']);
    const input: Record<string, any> = {
      specialtyIds: Array.isArray(this.editForm['specialtyIds']) ? this.editForm['specialtyIds'] : [],
      // Each tag carries the id it was loaded with, so an unchanged tag is updated in place. Without
      // it the nested list inserts a duplicate beside the row it is about to delete, and
      // `UNIQUE (course_id, tag)` rejects the save.
      tags: String(this.editForm['tags'] ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((tag) => {
          const existing = this.ownTagIds.get(tag);
          return existing ? { id: existing, tag } : { tag };
        }),
    };
    for (const f of ['name', 'courseType', 'facultyId', 'departmentId', 'parentCourseId']) {
      const v = this.editForm[f];
      if (v === undefined || v === null || v === '') {
        if (!required.has(f)) input[f] = null;
        continue;
      }
      input[f] = v;
    }
    const q = `mutation($id: ID!, $input: CourseInputPayload!) { courses { updateCourse(id: $id, course: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.courseId, input }).subscribe({
      next: (d: any) => {
        const res = d.courses.updateCourse;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }

  // ── Child electives (ELECTIVE_GROUP only) ─────────────────────────────────

  showChildForm = signal(false);
  childEditingId = signal<string | null>(null);
  /** tag text → stored `course_tags` row id, so re-saving an unchanged tag updates rather than
   *  inserting a duplicate `UNIQUE (course_id, tag)` alongside the row it is about to delete. */
  private childTagIds = new Map<string, string>();
  childError = signal('');
  childForm: Record<string, any> = {};

  /**
   * A new elective inherits the umbrella's кафедра and факультет, because that is nearly always
   * right — an elective block is offered by the department that owns the block — and because a
   * course with neither is unreachable from any department or faculty page afterwards. Both stay
   * editable.
   */
  openChildCreate() {
    const c = this.course();
    this.childEditingId.set(null);
    this.childTagIds = new Map();
    this.childForm = {
      name: '',
      courseType: 'ELECTIVE',
      departmentId: c?.department?.id ?? '',
      facultyId: c?.faculty?.id ?? c?.department?.faculty?.id ?? '',
      tags: ''
    };
    this.childError.set('');
    this.showChildForm.set(true);
  }

  openChildEdit(child: { id: string; name: string; courseType: string; tags?: CourseTagRef[] | null }) {
    this.childTagIds = new Map((child.tags ?? [])
      .filter((t) => t.tag && t.id)
      .map((t) => [t.tag, String(t.id)]));
    this.childEditingId.set(child.id);
    this.childForm = {
      name: child.name ?? '',
      courseType: child.courseType ?? 'ELECTIVE',
      tags: courseTagNames(child.tags).join(', ')
    };
    this.childError.set('');
    this.showChildForm.set(true);
  }

  closeChildForm() { this.showChildForm.set(false); this.childError.set(''); }

  /**
   * Creating sends `parentCourseId` — that is what makes the row one of this group's electives.
   * Editing does *not*: an edit here is a rename or a retag, and sending the parent again would be
   * the one field this form has no business restating. `tags` is a nested list and is always sent
   * in full, so removing a tag deletes it.
   */
  saveChild() {
    const name = String(this.childForm['name'] ?? '').trim();
    if (!name) { this.childError.set('Вкажіть назву дисципліни.'); return; }

    const id = this.childEditingId();
    const input: Record<string, any> = {
      name,
      courseType: this.childForm['courseType'] || 'ELECTIVE',
      tags: String(this.childForm['tags'] ?? '')
        .split(',').map((t) => t.trim()).filter(Boolean)
        .map((tag) => {
          const existing = this.childTagIds.get(tag);
          return existing ? { id: existing, tag } : { tag };
        })
    };
    if (!id) {
      input['parentCourseId'] = this.courseId;
      input['departmentId'] = this.childForm['departmentId'] || null;
      input['facultyId'] = this.childForm['facultyId'] || null;
    }

    const q = id
      ? `mutation($id: ID!, $input: CourseInputPayload!) { courses { updateCourse(id: $id, course: $input) { isSuccess errorStatus } } }`
      : `mutation($input: CourseInputPayload!) { courses { createCourse(course: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = id ? d.courses.updateCourse : d.courses.createCourse;
        if (!res.isSuccess) { this.childError.set(res.errorStatus || 'Помилка операції'); return; }
        this.closeChildForm();
        this.load();
      },
      error: (e) => this.childError.set(e.message)
    });
  }

  /**
   * Detaches an elective from this group by clearing its `parentCourseId`. Deliberately *not* a
   * delete: `courses.parent_course_id` cascades, so deleting the umbrella would take its electives
   * with it, and a course that has already been chosen by a group and timetabled must not vanish
   * because someone reorganised a block. The course survives, on its own page.
   */
  detachChild(child: { id: string; name: string; courseType: string }) {
    // `name` and `courseType` are `String!` on CourseInputPayload, so an input carrying only the
    // field being cleared is rejected by GraphQL before the resolver sees it. They are echoed back
    // exactly as loaded; every other field is absent, and absent means untouched.
    const q = `mutation($id: ID!, $input: CourseInputPayload!) { courses { updateCourse(id: $id, course: $input) { isSuccess errorStatus } } }`;
    const input = { name: child.name, courseType: child.courseType, parentCourseId: null };
    this.gql.request(q, { id: child.id, input }).subscribe({
      next: (d: any) => {
        const res = d.courses.updateCourse;
        if (!res.isSuccess) { this.childError.set(res.errorStatus || 'Помилка операції'); return; }
        this.load();
      },
      error: (e) => this.childError.set(e.message)
    });
  }

  // ── Curriculum items ──────────────────────────────────────────────────────

  showItemForm = signal(false);
  itemEditingId = signal<string | null>(null);
  itemError = signal('');
  itemForm: Record<string, any> = {};
  /**
   * The hours block of the item being edited: one row per hour type, blank meaning "not taught".
   *
   * Each row keeps the `curriculum_item_hours` id it came from. A nested list is reconciled by id —
   * a row without one is an INSERT and any stored row not named is a DELETE — so dropping the ids
   * would try to insert a second ЛЕКЦІЇ row beside the existing one, which `UNIQUE (curriculum_item_id,
   * hour_type)` rejects, and would delete-then-recreate the rest. `curriculum_item_hours` cascades
   * to working items, workloads and timetable entries, so that delete is not recoverable.
   */
  itemHourRows = signal<{ id: string; hourType: string; hours: string }[]>([]);

  readonly controlFormOptions = toOptions(CONTROL_FORM_OPTIONS);

  openItemCreate() {
    this.itemEditingId.set(null);
    this.itemForm = { specialtyId: '', semester: '1', controlForm: 'EXAM', ectsCredits: '' };
    this.itemHourRows.set(HOUR_TYPE_OPTIONS.map((o) => ({ id: '', hourType: o.value, hours: '' })));
    this.itemError.set('');
    this.showItemForm.set(true);
  }

  openItemEdit(item: CurriculumRow) {
    this.itemEditingId.set(item.id);
    this.itemForm = {
      specialtyId: item.specialty?.id ?? '',
      semester: String(item.semester ?? ''),
      controlForm: item.controlForm ?? '',
      ectsCredits: item.ectsCredits != null ? String(item.ectsCredits) : ''
    };
    const byType = new Map((item.hours ?? []).map((h) => [h.hourType, h]));
    this.itemHourRows.set(HOUR_TYPE_OPTIONS.map((o) => {
      const existing = byType.get(o.value);
      return { id: existing?.id ?? '', hourType: o.value, hours: existing ? String(existing.hours) : '' };
    }));
    this.itemError.set('');
    this.showItemForm.set(true);
  }

  closeItemForm() { this.showItemForm.set(false); this.itemError.set(''); }

  /** `null` and not `''` is what Angular's number accessor emits for an emptied box, and "" is what
   *  the save path reads as "no such class" — so it is normalised here rather than at every read. */
  setItemHours(hourType: string, value: string | number | null) {
    const next = value === null || value === undefined ? '' : String(value);
    this.itemHourRows.update((rows) =>
      rows.map((r) => (r.hourType === hourType ? { ...r, hours: next } : r)));
  }

  /**
   * `hours` is a nested list, so it is always sent in full: a blank row is *absent* from the input
   * and the framework deletes it, which is how "this discipline no longer has lectures here" is
   * expressed. `courseId` is this page's course — a curriculum item created here is by definition
   * a place this discipline is taught.
   */
  saveItem() {
    const specialtyId = this.itemForm['specialtyId'];
    if (!specialtyId) { this.itemError.set('Оберіть спеціальність.'); return; }
    const semester = Number(this.itemForm['semester']);
    if (!Number.isFinite(semester) || semester < 1) { this.itemError.set('Вкажіть семестр.'); return; }

    const controlForm = this.itemForm['controlForm'];
    if (!controlForm) { this.itemError.set('Оберіть форму контролю.'); return; }

    const ectsRaw = String(this.itemForm['ectsCredits'] ?? '').trim();
    if (ectsRaw === '') { this.itemError.set('Вкажіть кількість кредитів ECTS.'); return; }
    const ects = Number(ectsRaw);
    if (!Number.isInteger(ects) || ects < 0) {
      this.itemError.set('Кредити ECTS мають бути цілим невід\'ємним числом.');
      return;
    }

    // Rows keep their id so the backend updates in place — see `itemHourRows`. A blank row is left
    // out entirely, which is how the nested list is told to delete it.
    const hours = this.itemHourRows()
      .filter((r) => String(r.hours).trim() !== '')
      .map((r) => (r.id ? { id: r.id, hourType: r.hourType, hours: Number(r.hours) }
                        : { hourType: r.hourType, hours: Number(r.hours) }));
    if (hours.some((h) => !Number.isFinite(h.hours) || h.hours < 0)) {
      this.itemError.set('Години мають бути невід\'ємним числом.');
      return;
    }

    // `controlForm` is `String!` and `ectsCredits` is a NOT NULL column: both are always sent with
    // a real value rather than an explicit null, which the one would reject at coercion and the
    // other at the database.
    const input: Record<string, any> = {
      courseId: this.courseId,
      specialtyId,
      semester,
      controlForm,
      ectsCredits: ects,
      hours
    };

    const id = this.itemEditingId();
    const q = id
      ? `mutation($id: ID!, $input: CurriculumItemInputPayload!) { curriculumItems { updateCurriculumItem(id: $id, curriculumItem: $input) { isSuccess errorStatus } } }`
      : `mutation($input: CurriculumItemInputPayload!) { curriculumItems { createCurriculumItem(curriculumItem: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = id ? d.curriculumItems.updateCurriculumItem : d.curriculumItems.createCurriculumItem;
        if (!res.isSuccess) { this.itemError.set(res.errorStatus || 'Помилка операції'); return; }
        this.closeItemForm();
        this.load();
      },
      error: (e) => this.itemError.set(e.message)
    });
  }

  /** What «Видалити» is about to remove, and what it drags with it — see the confirm modal. */
  pendingItemDelete = signal<CurriculumRow | null>(null);

  askRemoveItem(item: CurriculumRow) { this.itemError.set(''); this.pendingItemDelete.set(item); }
  cancelRemoveItem() { this.pendingItemDelete.set(null); }

  /** How much hangs off one plan position, so the confirmation can say it rather than imply it. */
  itemCascade(item: CurriculumRow | null) {
    let working = 0, workloads = 0, entries = 0;
    for (const block of item?.hours ?? []) {
      for (const wci of block.workingCurriculumItems ?? []) {
        working++;
        for (const w of wci.workloads ?? []) { workloads++; entries += (w.timetableEntries ?? []).length; }
      }
    }
    return { working, workloads, entries };
  }

  confirmRemoveItem() {
    const item = this.pendingItemDelete();
    if (!item) return;
    this.pendingItemDelete.set(null);
    this.removeItem(item);
  }

  private removeItem(item: CurriculumRow) {
    const q = `mutation($id: ID!) { curriculumItems { deleteCurriculumItem(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: item.id }).subscribe({
      next: (d: any) => {
        const res = d.curriculumItems.deleteCurriculumItem;
        if (!res.isSuccess) { this.itemError.set(res.errorStatus || 'Помилка видалення'); return; }
        this.load();
      },
      error: (e) => this.itemError.set(e.message)
    });
  }

  // ── Lecturer workloads ────────────────────────────────────────────────────

  /**
   * Every `lecturer_workloads` row of this discipline, from both sources `deliveries` uses.
   *
   * A workload is where the discipline stops being a plan and becomes somebody's teaching: who
   * delivers it, to which groups, on which bells, and — through `lecturer_workload_rooms` — where it
   * may be held. All of that is editable here, so a кафедра's assignment can be corrected from the
   * discipline rather than by finding it again on the department page.
   */
  workloadCards = computed<WorkloadCard[]>(() => {
    const cards: WorkloadCard[] = [];
    const seen = new Set<string>();

    const push = (
      w: WorkloadRow,
      wci: { id: string; teachingFormat: string;
             department?: { id: string; name: string; faculty?: { id: string } | null } | null;
             academicGroups?: { id: string; name: string }[] },
      ctx: { specialtyName: string; semester: number; hourType: string; hours: number }
    ) => {
      if (seen.has(String(w.id))) return;
      seen.add(String(w.id));
      cards.push({
        id: w.id,
        workingCurriculumItemId: wci.id,
        specialtyName: ctx.specialtyName,
        semester: ctx.semester,
        hourType: ctx.hourType,
        departmentId: wci.department?.id ?? '',
        departmentName: wci.department?.name ?? '—',
        facultyId: wci.department?.faculty?.id ?? '',
        teachingFormat: wci.teachingFormat,
        durationHours: w.durationHours ?? 0,
        startTimeSetId: w.classStartTimeSet?.id ?? '',
        startTimeSetName: w.classStartTimeSet?.name ?? '—',
        lecturerIds: (w.lecturers ?? []).map((l) => String(l.id)),
        lecturerNames: (w.lecturers ?? [])
          .map((l) => {
            const post = POSITION_SHORT[l.position ?? ''] ?? '';
            const name = `${(l.lastName ?? '').trim()} ${(l.firstName ?? '').trim().charAt(0)}.`.trim();
            return post ? `${post} ${name}` : name;
          })
          .sort(compareUk).join(', '),
        groupIds: (w.academicGroups ?? []).map((g) => String(g.id)),
        groupNames: (w.academicGroups ?? []).map((g) => g.name).sort(compareUk).join(', '),
        combinedGroupIds: (w.combinedGroups ?? []).map((g) => String(g.id)),
        combinedGroupNames: (w.combinedGroups ?? []).map((g) => g.name).sort(compareUk).join(', '),
        roomIds: (w.rooms ?? []).map((r) => String(r.id)),
        roomGroupIds: (w.roomGroups ?? []).map((g) => String(g.id)),
        roomLabel: [
          ...(w.rooms ?? []).map((r) => r.number),
          ...(w.roomGroups ?? []).map((g) => `${g.name} (група)`)
        ].join(', ') || 'будь-яка',
        scheduledClasses: (w.timetableEntries ?? []).length,
        hours: ctx.hours,
        availableGroups: (wci.academicGroups ?? [])
          .map((g) => ({ id: String(g.id), label: g.name }))
          .sort((a, b) => compareUk(a.label, b.label)),
        heldLecturers: (w.lecturers ?? []).map((l) => ({
          id: String(l.id),
          label: [l.lastName, l.firstName].filter(Boolean).join(' ').trim() || String(l.id)
        })),
        heldGroups: (w.academicGroups ?? []).map((g) => ({ id: String(g.id), label: g.name })),
        entries: [...(w.timetableEntries ?? [])].sort((a, b) =>
          (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0)
          || (a.classStartTime?.ordinal ?? 0) - (b.classStartTime?.ordinal ?? 0))
      });
    };

    // A workload hangs off *exactly one* of a working item or a combined item
    // (`lecturer_workloads_target_check`), so both have to be walked. Once a position is merged, its
    // teaching is carried by the combined item's workloads, reached here through the member's own
    // `combinedWorkingCurriculumItems` relation — no second connection, and `push` dedupes the
    // several members that share one combined item.
    const walk = (
      wci: any,
      ctx: { specialtyName: string; semester: number; hourType: string; hours: number }
    ) => {
      for (const w of wci.workloads ?? []) push(w, wci, ctx);
      for (const combined of wci.combinedWorkingCurriculumItems ?? []) {
        for (const w of combined.workloads ?? []) push(w, wci, ctx);
      }
    };

    for (const item of this.curricula()) {
      for (const block of item.hours ?? []) {
        for (const wci of block.workingCurriculumItems ?? []) {
          walk(wci, {
            specialtyName: item.specialty?.name ?? '—',
            semester: item.semester,
            hourType: block.hourType,
            hours: block.hours ?? 0
          });
        }
      }
    }

    for (const wci of this.extraWorkingItems()) {
      const ci = wci.curriculumItemHours?.curriculumItem;
      walk(wci, {
        specialtyName: ci?.specialty?.name ?? '—',
        semester: ci?.semester ?? 0,
        hourType: wci.curriculumItemHours?.hourType ?? '',
        hours: wci.curriculumItemHours?.hours ?? 0
      });
    }

    return cards.sort((a, b) => a.semester - b.semester
      || compareUk(a.specialtyName, b.specialtyName)
      || compareUk(a.departmentName, b.departmentName)
      || compareUk(a.lecturerNames, b.lecturerNames));
  });

  /**
   * What the workloads tab counts. `summary()` walks only `curricula()`, which an ELECTIVE chosen
   * out of a group has none of — so on its page that header read «0 викладачів» directly above a
   * table of real workloads.
   */
  workloadTotals = computed(() => {
    const lecturers = new Set<string>();
    let scheduled = 0;
    let unassigned = 0;
    for (const card of this.workloadCards()) {
      for (const id of card.lecturerIds) lecturers.add(id);
      scheduled += card.scheduledClasses;
      if (!card.lecturerIds.length) unassigned++;
    }
    return { workloads: this.workloadCards().length, lecturers: lecturers.size, scheduled, unassigned };
  });

  showWorkloadForm = signal(false);
  workloadEditingId = signal<string | null>(null);
  workloadError = signal('');
  workloadForm: Record<string, any> = {};
  wlLecturerIds: string[] = [];
  wlGroupIds: string[] = [];
  wlCombinedGroupIds: string[] = [];
  wlRoomIds: string[] = [];
  wlRoomGroupIds: string[] = [];

  /** The row being edited, kept so the modal can scope its own pickers. */
  private activeWorkload = signal<WorkloadCard | null>(null);

  /** Lecturers of the row's кафедра, with anyone already assigned merged in — see `mergeHeld`. */
  lecturerOptions = computed<Option[]>(() =>
    this.mergeHeld(this.deptLecturerOptions(), this.activeWorkload()?.heldLecturers ?? []));
  private deptLecturerOptions = signal<Option[]>([]);

  /**
   * Adds values the row already holds but the scoped list does not offer — a co-teaching lecturer
   * from another кафедра, a group since removed from the position. A multi-select renders an id it
   * has no option for as nothing at all, so the modal would read «nobody assigned» over a row whose
   * table cell names two people.
   */
  private mergeHeld(scoped: Option[], held: Option[]): Option[] {
    const byId = new Map(scoped.map((o) => [o.id, o]));
    for (const o of held) if (!byId.has(o.id)) byId.set(o.id, o);
    return [...byId.values()].sort((a, b) => compareUk(a.label, b.label));
  }
  combinedGroupOptions = signal<Option[]>([]);
  /** Cached per кафедра: the lecturer list is a round trip and rows here span many departments. */
  private lecturersByDept = new Map<string, Option[]>();

  /** Loaded once, unfiltered, and narrowed per row — see `startTimeSetOptions`. */
  private allStartTimeSets = signal<{ id: string; name: string; isDefault?: boolean; faculty?: { id: string } | null }[]>([]);
  private allRooms = signal<{ id: string; number: string; name?: string | null; faculty?: { id: string } | null }[]>([]);
  private allRoomGroups = signal<{
    id: string; name: string;
    faculty?: { id: string } | null;
    department?: { id: string; faculty?: { id: string } | null } | null;
    /** Members — the other half of the eligible-room union a class may be placed in. */
    rooms?: { id: string }[];
  }[]>([]);

  /**
   * Bells, rooms and room groups usable by the row being edited.
   *
   * All three are fetched unfiltered and narrowed here, for the reason the department and faculty
   * pages give: `facultyId` is an equality filter, so asking the backend for this faculty's rows
   * would drop precisely the university-wide ones (`faculty_id IS NULL`) that most workloads use.
   * Anything already stored is merged back in, so a value from another faculty is not rendered as
   * an unchecked blank and silently dropped by the first save.
   */
  startTimeSetOptions = computed<Option[]>(() => {
    const facultyId = this.activeWorkload()?.facultyId ?? '';
    const current = this.activeWorkload()?.startTimeSetId ?? '';
    return this.allStartTimeSets()
      .filter((n) => !n.faculty || n.faculty.id === facultyId || n.id === current)
      .map((n) => ({ id: String(n.id), label: n.name }))
      .sort((a, b) => compareUk(a.label, b.label));
  });

  workloadRoomOptions = computed<Option[]>(() => {
    const facultyId = this.activeWorkload()?.facultyId ?? '';
    const held = new Set(this.activeWorkload()?.roomIds ?? []);
    return this.allRooms()
      .filter((r) => !r.faculty || r.faculty.id === facultyId || held.has(String(r.id)))
      .map((r) => ({ id: String(r.id), label: r.name ? `${r.number} — ${r.name}` : r.number }))
      .sort((a, b) => compareUk(a.label, b.label));
  });

  workloadRoomGroupOptions = computed<Option[]>(() => {
    const facultyId = this.activeWorkload()?.facultyId ?? '';
    const held = new Set(this.activeWorkload()?.roomGroupIds ?? []);
    return this.allRoomGroups()
      .filter((g) => (!g.faculty && !g.department)
        || g.faculty?.id === facultyId
        || g.department?.faculty?.id === facultyId
        || held.has(String(g.id)))
      .map((g) => ({ id: String(g.id), label: g.name }))
      .sort((a, b) => compareUk(a.label, b.label));
  });

  /** Groups this workload may be given — its own РНП position's, never the whole specialty's. */
  workloadGroupOptions = computed<Option[]>(() =>
    this.mergeHeld(this.activeWorkload()?.availableGroups ?? [], this.activeWorkload()?.heldGroups ?? []));

  /**
   * Individual work is supervised per student, not taught to a group: the department page derives
   * `lecturerIds` from the student roster and pins the duration at one academic hour. This editor
   * does not touch the roster, so it must not touch either of those two either — a lecturer list
   * edited here would stop matching who supervises whom, and a duration edited here would silently
   * double every consultation in the hours reports.
   */
  isIndividualWorkload = computed(() => this.activeWorkload()?.teachingFormat === 'INDIVIDUALLY');

  /**
   * «Об'єднані групи» apply only to a position taught SEPARATELY — they are how separately-taught
   * subgroups are bundled back together for one class. The department page force-clears them for
   * every other format, so offering them here would let this page store a value that page deletes
   * on its next save.
   */
  canUseCombinedGroups = computed(() => this.activeWorkload()?.teachingFormat === 'SEPARATELY');

  private workloadOptionsLoaded = false;

  private loadWorkloadOptions() {
    if (this.workloadOptionsLoaded) return;
    const q = `{
      classStartTimeSets { classStartTimeSetConnection(limit: 200, offset: 0) { nodes { id name isDefault faculty { id } } } }
      combinedGroups { combinedGroupConnection(limit: 1000, offset: 0) { nodes { id name } } }
      rooms { roomConnection(limit: 1000, offset: 0) { nodes { id number name faculty { id } } } }
      roomGroups { roomGroupConnection(limit: 500, offset: 0) { nodes {
        id name faculty { id } department { id faculty { id } } rooms { id }
      } } }
    }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        this.allStartTimeSets.set(d.classStartTimeSets.classStartTimeSetConnection.nodes ?? []);
        this.allRooms.set(d.rooms.roomConnection.nodes ?? []);
        this.allRoomGroups.set(d.roomGroups.roomGroupConnection.nodes ?? []);
        this.combinedGroupOptions.set((d.combinedGroups.combinedGroupConnection.nodes ?? [])
          .map((g: any) => ({ id: String(g.id), label: g.name }))
          .sort((a: Option, b: Option) => compareUk(a.label, b.label)));
        this.workloadOptionsLoaded = true;   // see loadClassStartTimes for why this is not set early
      },
      error: (e) => this.workloadError.set('Не вдалося завантажити довідники: ' + e.message)
    });
  }

  private loadLecturersFor(departmentId: string) {
    if (!departmentId) { this.deptLecturerOptions.set([]); return; }
    const cached = this.lecturersByDept.get(departmentId);
    if (cached) { this.deptLecturerOptions.set(cached); return; }
    const q = `{ lecturers { lecturerConnection(limit: 500, offset: 0, departmentId: "${departmentId}") { nodes { id firstName middleName lastName } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const opts: Option[] = (d.lecturers.lecturerConnection.nodes ?? [])
          .map((l: any) => ({
            id: String(l.id),
            label: [l.lastName, l.firstName, l.middleName].filter(Boolean).join(' ')
          }))
          .sort((a: Option, b: Option) => compareUk(a.label, b.label));
        this.lecturersByDept.set(departmentId, opts);
        if (this.activeWorkload()?.departmentId === departmentId) this.deptLecturerOptions.set(opts);
      },
      error: () => this.deptLecturerOptions.set([])
    });
  }

  openWorkloadEdit(card: WorkloadCard) {
    this.workloadEditingId.set(card.id);
    this.activeWorkload.set(card);
    this.workloadForm = {
      durationHours: String(card.durationHours || 2),
      classStartTimeSetId: card.startTimeSetId
    };
    this.wlLecturerIds = [...card.lecturerIds];
    this.wlGroupIds = [...card.groupIds];
    this.wlCombinedGroupIds = [...card.combinedGroupIds];
    this.wlRoomIds = [...card.roomIds];
    this.wlRoomGroupIds = [...card.roomGroupIds];
    this.deptLecturerOptions.set([]);
    this.loadLecturersFor(card.departmentId);
    this.workloadError.set('');
    this.showWorkloadForm.set(true);
  }

  /** A new workload for an existing РНП position — the row supplies every scope the form needs. */
  openWorkloadCreate(row: DeliveryRow) {
    // Individual work is a distribution of students among supervisors, and `lecturer_workload_students`
    // is the department page's to write — this editor deliberately never touches it. Creating the
    // row here would leave a workload with no lecturers, no groups and no pairings, completable
    // nowhere on this page.
    if (row.teachingFormat === 'INDIVIDUALLY') {
      this.workloadError.set(
        'Навантаження для індивідуальної роботи створюється на сторінці кафедри — воно будується '
        + 'з розподілу студентів між керівниками.');
      return;
    }
    if (row.merged) {
      this.workloadError.set(
        'Цю позицію об’єднано з іншими — навантаження за нею ведеться через об’єднану позицію.');
      return;
    }
    const defaultSet = this.allStartTimeSets().find((n) => n.isDefault)?.id ?? '';
    const card: WorkloadCard = {
      id: '', workingCurriculumItemId: row.id,
      specialtyName: row.specialtyName, semester: row.semester, hourType: row.hourType,
      departmentId: row.departmentId, departmentName: row.departmentName,
      facultyId: this.facultyOfDelivery(row),
      teachingFormat: row.teachingFormat,
      durationHours: 2, startTimeSetId: defaultSet, startTimeSetName: '',
      lecturerIds: [], lecturerNames: '', groupIds: [], groupNames: '',
      combinedGroupIds: [], combinedGroupNames: '', roomIds: [], roomGroupIds: [],
      roomLabel: '', scheduledClasses: 0, hours: row.hours ?? 0,
      availableGroups: this.groupsOfDelivery(row),
      heldLecturers: [], heldGroups: [], entries: []
    };
    this.workloadEditingId.set(null);
    this.activeWorkload.set(card);
    this.workloadForm = { durationHours: '2', classStartTimeSetId: defaultSet };
    this.wlLecturerIds = [];
    this.wlGroupIds = [];
    this.wlCombinedGroupIds = [];
    this.wlRoomIds = [];
    this.wlRoomGroupIds = [];
    this.deptLecturerOptions.set([]);
    this.loadLecturersFor(row.departmentId);
    this.workloadError.set('');
    this.showWorkloadForm.set(true);
  }

  private facultyOfDelivery(row: DeliveryRow): string {
    for (const item of this.curricula()) {
      for (const block of item.hours ?? []) {
        for (const wci of block.workingCurriculumItems ?? []) {
          if (wci.id === row.id) return wci.department?.faculty?.id ?? '';
        }
      }
    }
    return this.extraWorkingItems().find((w) => w.id === row.id)?.department?.faculty?.id ?? '';
  }

  private groupsOfDelivery(row: DeliveryRow): Option[] {
    const toOpts = (gs?: { id: string; name: string }[]) => (gs ?? [])
      .map((g) => ({ id: String(g.id), label: g.name }))
      .sort((a, b) => compareUk(a.label, b.label));
    for (const item of this.curricula()) {
      for (const block of item.hours ?? []) {
        for (const wci of block.workingCurriculumItems ?? []) {
          if (wci.id === row.id) return toOpts(wci.academicGroups);
        }
      }
    }
    return toOpts(this.extraWorkingItems().find((w) => w.id === row.id)?.academicGroups);
  }

  closeWorkloadForm() {
    this.showWorkloadForm.set(false);
    this.workloadError.set('');
    this.activeWorkload.set(null);
  }

  /**
   * Sends only what this editor owns. `studentAssignments` is deliberately absent: a nested list
   * left out of the input is left alone, and the student roster of an INDIVIDUALLY workload is the
   * department page's business — sending `[]` from here, as that page does, would wipe it.
   */
  saveWorkload() {
    const card = this.activeWorkload();
    if (!card) return;
    const setId = this.workloadForm['classStartTimeSetId'];
    if (!setId) { this.workloadError.set('Оберіть розклад дзвінків.'); return; }

    const individual = this.isIndividualWorkload();
    const duration = individual ? card.durationHours : Number(this.workloadForm['durationHours']);
    if (!Number.isInteger(duration) || duration < 1 || duration > 4) {
      // The individual branch echoes a value the form never showed, so if it did not load there is
      // nothing on screen to correct — say that rather than pointing at an absent field.
      this.workloadError.set(individual
        ? 'Не вдалося визначити тривалість заняття — оновіть сторінку.'
        : 'Тривалість заняття має бути від 1 до 4 академічних годин.');
      return;
    }

    const input: Record<string, any> = {
      durationHours: duration,
      classStartTimeSetId: setId,
      academicGroupIds: individual ? [] : this.wlGroupIds,
      combinedGroupIds: this.canUseCombinedGroups() ? this.wlCombinedGroupIds : [],
      roomIds: this.wlRoomIds,
      roomGroupIds: this.wlRoomGroupIds
    };
    // Left out entirely for individual work, where the department page derives it from the roster.
    if (!individual) input['lecturerIds'] = this.wlLecturerIds;

    const id = this.workloadEditingId();
    if (!id) input['workingCurriculumItemId'] = card.workingCurriculumItemId;

    const q = id
      ? `mutation($id: ID!, $input: LecturerWorkloadInputPayload!) { lecturerWorkloads { updateLecturerWorkload(id: $id, lecturerWorkload: $input) { isSuccess errorStatus } } }`
      : `mutation($input: LecturerWorkloadInputPayload!) { lecturerWorkloads { createLecturerWorkload(lecturerWorkload: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = id ? d.lecturerWorkloads.updateLecturerWorkload : d.lecturerWorkloads.createLecturerWorkload;
        if (!res.isSuccess) { this.workloadError.set(res.errorStatus || 'Помилка операції'); return; }
        this.closeWorkloadForm();
        this.load();
      },
      error: (e) => this.workloadError.set(e.message)
    });
  }

  pendingWorkloadDelete = signal<WorkloadCard | null>(null);
  askRemoveWorkload(card: WorkloadCard) { this.workloadError.set(''); this.pendingWorkloadDelete.set(card); }
  cancelRemoveWorkload() { this.pendingWorkloadDelete.set(null); }

  confirmRemoveWorkload() {
    const card = this.pendingWorkloadDelete();
    if (!card) return;
    this.pendingWorkloadDelete.set(null);
    const q = `mutation($id: ID!) { lecturerWorkloads { deleteLecturerWorkload(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: card.id }).subscribe({
      next: (d: any) => {
        const res = d.lecturerWorkloads.deleteLecturerWorkload;
        if (!res.isSuccess) { this.workloadError.set(res.errorStatus || 'Помилка видалення'); return; }
        this.load();
      },
      error: (e) => this.workloadError.set(e.message)
    });
  }

  /** The кафедра the open workload modal is scoped to, for its lecturer picker's hint. */
  activeWorkloadDepartment = computed(() => this.activeWorkload()?.departmentName ?? '');

  /** May this workload be edited: through the discipline, or through the кафедра holding it. */
  canModifyWorkload(card: WorkloadCard): boolean {
    return this.canModifyCourse() || this.modifiableDepartments().has(card.departmentId);
  }

  // ── Timetable entries ─────────────────────────────────────────────────────

  readonly DAY_OF_WEEK_OPTIONS = toOptions(DAY_OF_WEEK_OPTIONS);
  readonly WEEK_PARITY_OPTIONS = toOptions(WEEK_PARITY_OPTIONS);

  private classStartTimes = signal<{ id: string; setId: string; ordinal: number; startTime: string }[]>([]);
  private classStartTimesLoaded = false;

  private loadClassStartTimes() {
    if (this.classStartTimesLoaded) return;
    const q = `{ classStartTimes { classStartTimeConnection(limit: 500) { nodes {
      id ordinal startTime classStartTimeSet { id }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        this.classStartTimes.set((d.classStartTimes.classStartTimeConnection.nodes ?? [])
          .map((t: any) => ({
            id: String(t.id), setId: String(t.classStartTimeSet?.id ?? ''),
            ordinal: t.ordinal, startTime: t.startTime
          }))
          .sort((a: any, b: any) => a.ordinal - b.ordinal));
        // Marked loaded only on success: a flag set before the request turns one transient failure
        // into two permanently empty pickers, with reopening the tab unable to retry.
        this.classStartTimesLoaded = true;
      },
      error: (e) => this.entryError.set('Не вдалося завантажити розклад дзвінків: ' + e.message)
    });
  }

  /**
   * How many classes this workload's hours come to, on the same arithmetic «Формування розкладу»
   * uses: total hours ÷ (weeks × hours per class). Reported rather than enforced — classes are
   * placed by hand here and there are legitimate reasons to differ — but a workload reading «3 з 2»
   * is delivering more than its plan says, which is worth being able to see.
   */
  expectedClasses(card: WorkloadCard): number {
    const weeks = this.settings.numberValue('semester_duration_weeks') ?? 16;
    const perClass = weeks * (card.durationHours || 0);
    if (!perClass || !card.hours) return 0;
    return Math.round(card.hours / perClass);
  }

  dayLabel(v: number | string): string {
    return DAY_OF_WEEK_OPTIONS.find((o) => o.value === String(v))?.label ?? String(v);
  }

  weekParityLabel(v: string): string {
    return WEEK_PARITY_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  entryLabel(e: EntryRow): string {
    const time = e.classStartTime ? `${e.classStartTime.ordinal} пара, ${e.classStartTime.startTime}` : '—';
    const room = e.room ? e.room.number : '—';
    return `${this.dayLabel(e.dayOfWeek)}, ${time}, ауд. ${room}`;
  }

  // ── The entry editor ──────────────────────────────────────────────────────

  showEntryForm = signal(false);
  entryEditingId = signal<string | null>(null);
  entryError = signal('');
  entryForm: Record<string, any> = {};
  private entryWorkload = signal<WorkloadCard | null>(null);

  /**
   * The slots of the workload's own grid of bells.
   *
   * `timetable_entries.class_start_time_id` is not constrained to the workload's
   * `class_start_time_set_id` by the database — it is a rule the client keeps (see the note in
   * schema.sql). Offering only that set's slots is how it is kept here, so a class cannot be put on
   * a bell its own grid does not have.
   */
  entryTimeOptions = computed<Option[]>(() => {
    const setId = this.entryWorkload()?.startTimeSetId ?? '';
    const held = this.editingEntry()?.classStartTime?.id ?? '';
    return this.classStartTimes()
      .filter((t) => t.setId === setId || t.id === held)
      .map((t) => ({ id: t.id, label: `${t.ordinal} пара · ${t.startTime}` }));
  });

  /** True when the entry being edited sits on a bell outside its workload's own grid — which
   *  happens when the grid was changed after the class was placed. Worth saying, not hiding. */
  entryTimeOutOfSet = computed(() => {
    const held = this.editingEntry()?.classStartTime?.id;
    if (!held) return false;
    const setId = this.entryWorkload()?.startTimeSetId ?? '';
    return !this.classStartTimes().some((t) => t.id === held && t.setId === setId);
  });

  /** The row open in the modal, so its own stored values can be offered even when out of policy. */
  private editingEntry = signal<EntryRow | null>(null);

  /**
   * The rooms this class may go in: the workload's own rooms together with the rooms of its room
   * groups, which is the union `lecturer_workload_rooms` and `lecturer_workload_room_groups` are
   * read as. Naming nothing means no restriction, and the picker then offers the faculty's rooms —
   * the same fallback the timetable generator uses.
   */
  entryRoomOptions = computed<Option[]>(() => {
    const card = this.entryWorkload();
    if (!card) return [];
    const allowed = new Set<string>(card.roomIds);
    for (const g of this.allRoomGroups()) {
      if (card.roomGroupIds.includes(String(g.id))) {
        for (const r of g.rooms ?? []) allowed.add(String(r.id));
      }
    }
    // Only the row being edited widens the list. Taking every entry's room would let one
    // out-of-policy placement permanently enlarge what the next class may be put in.
    const held = new Set([this.editingEntry()?.room?.id].filter(Boolean).map(String));
    return this.allRooms()
      .filter((r) => allowed.size
        ? allowed.has(String(r.id)) || held.has(String(r.id))
        : (!r.faculty || r.faculty.id === card.facultyId || held.has(String(r.id))))
      .map((r) => ({ id: String(r.id), label: r.name ? `${r.number} — ${r.name}` : r.number }))
      .sort((a, b) => compareUk(a.label, b.label));
  });

  /** Whether the room list is the workload's own restriction or the faculty-wide fallback. */
  entryRoomsRestricted = computed(() => {
    const card = this.entryWorkload();
    if (!card) return false;
    // The union, not the intent: a workload restricted to a room group that has no members has no
    // usable restriction, and the picker falls back to the faculty — saying otherwise would
    // describe a list the reader is not looking at.
    const allowed = new Set(card.roomIds);
    for (const g of this.allRoomGroups()) {
      if (card.roomGroupIds.includes(String(g.id))) for (const r of g.rooms ?? []) allowed.add(String(r.id));
    }
    return allowed.size > 0;
  });

  openEntryCreate(card: WorkloadCard) {
    if (!card.startTimeSetId) {
      this.entryError.set('Спочатку оберіть розклад дзвінків для цього навантаження.');
      return;
    }
    this.entryWorkload.set(card);
    this.editingEntry.set(null);
    if (!this.entryTimeOptions().length) {
      // Either the bells are still in flight or their grid has no slots; opening the modal on two
      // empty required pickers would look like the form was broken.
      this.entryWorkload.set(null);
      this.entryError.set(this.classStartTimesLoaded
        ? 'У цьому розкладі дзвінків немає жодної пари.'
        : 'Розклад дзвінків ще завантажується — спробуйте за мить.');
      return;
    }
    this.entryEditingId.set(null);
    this.entryForm = {
      dayOfWeek: '1',
      weekParity: 'WEEKLY',
      classStartTimeId: this.entryTimeOptions()[0]?.id ?? '',
      roomId: this.entryRoomOptions()[0]?.id ?? ''
    };
    this.entryError.set('');
    this.showEntryForm.set(true);
  }

  openEntryEdit(card: WorkloadCard, entry: EntryRow) {
    this.entryWorkload.set(card);
    this.editingEntry.set(entry);
    this.entryEditingId.set(entry.id);
    this.entryForm = {
      dayOfWeek: String(entry.dayOfWeek ?? 1),
      weekParity: entry.weekParity || 'WEEKLY',
      classStartTimeId: entry.classStartTime?.id ?? '',
      roomId: entry.room?.id ?? ''
    };
    this.entryError.set('');
    this.showEntryForm.set(true);
  }

  closeEntryForm() {
    this.showEntryForm.set(false);
    this.entryError.set('');
    this.entryWorkload.set(null);
    this.editingEntry.set(null);
    this.entryChecking.set(false);
  }

  /**
   * `dayOfWeek` and `weekParity` are the only NON-NULL fields of the input, but `workload_id`,
   * `class_start_time_id` and `room_id` are all NOT NULL columns with no default — so a create has
   * to carry all five, and an update sends them rather than omitting them because they are exactly
   * what this form edits.
   */
  /** True while the pre-save clash query is in flight, so the button can say so. */
  entryChecking = signal(false);

  /**
   * Two classes collide when they share a day and a bell and their weeks overlap: a WEEKLY class
   * meets both halves of a fortnight, so it clashes with everything, while NUMERATOR and
   * DENOMINATOR pass each other.
   */
  private weeksOverlap(a: string, b: string): boolean {
    return a === 'WEEKLY' || b === 'WEEKLY' || a === b;
  }

  /**
   * Refuses to place a class on top of another.
   *
   * `timetable_entries` carries no unique index — the database cannot tell a double-booking from a
   * legitimate row, and says so in schema.sql, handing the rule to whoever writes. «Формування
   * розкладу» keeps it by giving the solver every competing class as a hard obstacle; this editor
   * places classes by hand, so it asks the same question directly: is this room, any of these
   * lecturers, or any of these groups already busy in that slot?
   *
   * The three connection filters do the matching server-side. The reply is narrowed here to the
   * chosen day and bell, and to the entry's own id, so re-saving an unchanged class is not a clash
   * with itself.
   */
  private findConflicts(card: WorkloadCard, input: { dayOfWeek: number; weekParity: string;
                                                     classStartTimeId: string; roomId: string }) {
    const list = (name: string, ids: string[]) =>
      ids.length ? `${name}: [${ids.map((id) => `"${id}"`).join(', ')}]` : '';
    const selection = `nodes {
      id dayOfWeek weekParity
      classStartTime { id }
      room { id number }
      workload { id lecturers { lastName firstName } academicGroups { name } }
    }`;
    const parts = [
      `byRoom: timetableEntryConnection(limit: 500, ${list('roomIds', [input.roomId])}) { ${selection} }`
    ];
    if (card.lecturerIds.length) {
      parts.push(`byLecturer: timetableEntryConnection(limit: 500, ${list('lecturerIds', card.lecturerIds)}) { ${selection} }`);
    }
    if (card.groupIds.length) {
      parts.push(`byGroup: timetableEntryConnection(limit: 500, ${list('academicGroupIds', card.groupIds)}) { ${selection} }`);
    }
    return this.gql.request(`{ timetableEntries { ${parts.join(' ')} } }`);
  }

  private describeConflicts(d: any, input: { dayOfWeek: number; weekParity: string; classStartTimeId: string },
                            ownId: string | null): string {
    const clashes = (key: string): any[] => (d.timetableEntries?.[key]?.nodes ?? []).filter((e: any) =>
      String(e.id) !== String(ownId ?? '')
      && e.dayOfWeek === input.dayOfWeek
      && String(e.classStartTime?.id ?? '') === input.classStartTimeId
      && this.weeksOverlap(e.weekParity, input.weekParity));

    const names = (e: any) => (e.workload?.lecturers ?? [])
      .map((l: any) => `${l.lastName ?? ''} ${(l.firstName ?? '').charAt(0)}.`.trim())
      .join(', ');
    const groups = (e: any) => (e.workload?.academicGroups ?? []).map((g: any) => g.name).join(', ');

    const room = clashes('byRoom');
    if (room.length) {
      return `Аудиторія ${room[0].room?.number ?? ''} у цей час уже зайнята`
        + (names(room[0]) ? ` (${names(room[0])})` : '') + '.';
    }
    const lecturer = clashes('byLecturer');
    if (lecturer.length) {
      return `Викладач у цей час уже має заняття${names(lecturer[0]) ? ` (${names(lecturer[0])})` : ''}`
        + `${lecturer[0].room?.number ? `, ауд. ${lecturer[0].room.number}` : ''}.`;
    }
    const group = clashes('byGroup');
    if (group.length) {
      return `Група у цей час уже має заняття${groups(group[0]) ? ` (${groups(group[0])})` : ''}`
        + `${group[0].room?.number ? `, ауд. ${group[0].room.number}` : ''}.`;
    }
    return '';
  }

  saveEntry() {
    const card = this.entryWorkload();
    if (!card) return;
    const classStartTimeId = this.entryForm['classStartTimeId'];
    if (!classStartTimeId) { this.entryError.set('Оберіть пару.'); return; }
    const roomId = this.entryForm['roomId'];
    if (!roomId) { this.entryError.set('Оберіть аудиторію.'); return; }
    const dayOfWeek = Number(this.entryForm['dayOfWeek']);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 6) {
      this.entryError.set('Оберіть день тижня.');
      return;
    }

    // The bell must belong to the workload's own grid — the database does not enforce it, and the
    // picker can be showing a value that was legal when the class was placed and no longer is.
    const inSet = this.classStartTimes()
      .some((t) => t.id === classStartTimeId && t.setId === card.startTimeSetId);
    if (!inSet) {
      this.entryError.set('Ця пара не належить до розкладу дзвінків цього навантаження — оберіть іншу.');
      return;
    }

    const weekParity = this.entryForm['weekParity'] || 'WEEKLY';
    const input: Record<string, any> = { dayOfWeek, weekParity, classStartTimeId, roomId };
    const id = this.entryEditingId();
    if (!id) input['workloadId'] = card.id;

    this.entryChecking.set(true);
    this.entryError.set('');
    this.findConflicts(card, { dayOfWeek, weekParity, classStartTimeId, roomId }).subscribe({
      next: (d: any) => {
        const clash = this.describeConflicts(d, { dayOfWeek, weekParity, classStartTimeId }, id);
        if (clash) { this.entryChecking.set(false); this.entryError.set(clash); return; }
        this.writeEntry(id, input);
      },
      error: (e) => { this.entryChecking.set(false); this.entryError.set(e.message); }
    });
  }

  private writeEntry(id: string | null, input: Record<string, any>) {
    const q = id
      ? `mutation($id: ID!, $input: TimetableEntryInputPayload!) { timetableEntries { updateTimetableEntry(id: $id, timetableEntry: $input) { isSuccess errorStatus } } }`
      : `mutation($input: TimetableEntryInputPayload!) { timetableEntries { createTimetableEntry(timetableEntry: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        this.entryChecking.set(false);
        const res = id ? d.timetableEntries.updateTimetableEntry : d.timetableEntries.createTimetableEntry;
        if (!res.isSuccess) { this.entryError.set(res.errorStatus || 'Помилка операції'); return; }
        this.closeEntryForm();
        this.load();
      },
      error: (e) => { this.entryChecking.set(false); this.entryError.set(e.message); }
    });
  }

  /**
   * Nothing FKs to a timetable entry, so deleting one destroys no other data — but it does destroy
   * a decision (day, bell, week, room) that has to be remembered to undo, so it is confirmed like
   * every other delete on this page.
   */
  pendingEntryDelete = signal<EntryRow | null>(null);
  askRemoveEntry(entry: EntryRow) { this.entryError.set(''); this.pendingEntryDelete.set(entry); }
  cancelRemoveEntry() { this.pendingEntryDelete.set(null); }

  confirmRemoveEntry() {
    const entry = this.pendingEntryDelete();
    if (!entry) return;
    this.pendingEntryDelete.set(null);
    this.removeEntry(entry);
  }

  private removeEntry(entry: EntryRow) {
    const q = `mutation($id: ID!) { timetableEntries { deleteTimetableEntry(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: entry.id }).subscribe({
      next: (d: any) => {
        const res = d.timetableEntries.deleteTimetableEntry;
        if (!res.isSuccess) { this.entryError.set(res.errorStatus || 'Помилка видалення'); return; }
        this.load();
      },
      error: (e) => this.entryError.set(e.message)
    });
  }

  // ── Working curriculum items ──────────────────────────────────────────────

  showWciForm = signal(false);
  wciEditingId = signal<string | null>(null);
  wciError = signal('');
  wciForm: Record<string, any> = {};
  wciGroupIds: string[] = [];
  /** Academic groups of the specialty behind the row being edited — loaded when the modal opens. */
  wciGroupOptions = signal<Option[]>([]);

  readonly teachingFormatOptions = toOptions(TEACHING_FORMAT_OPTIONS);

  /**
   * The hour blocks this course offers, as the picker for "what is this position delivering?".
   * A working curriculum item hangs off one `curriculum_item_hours` row, so choosing the block is
   * choosing the specialty, the semester and the kind of class all at once.
   */
  hoursBlockOptions = computed<Option[]>(() => {
    const out: Option[] = [];
    for (const item of this.curricula()) {
      for (const block of item.hours ?? []) {
        out.push({
          id: block.id,
          label: `${item.specialty?.name ?? '—'} · ${item.semester} сем. · `
               + `${this.hourTypeLabel(block.hourType)} (${block.hours} год.)`
        });
      }
    }
    return out;
  });

  /** The electives a group may be given, when this page's course is the umbrella. */
  electiveOptions = computed<Option[]>(() =>
    this.childCourses().map((c) => ({ id: c.id, label: courseLabel(c.name, c.tags) })));

  openWciCreate() {
    this.wciEditingId.set(null);
    this.wciForm = {
      curriculumItemHoursId: this.hoursBlockOptions()[0]?.id ?? '',
      departmentId: this.course()?.department?.id ?? '',
      teachingFormat: 'TOGETHER',
      lecturerCount: '1',
      courseId: ''
    };
    this.wciGroupIds = [];
    this.wciError.set('');
    this.loadWciGroupOptions(this.specialtyOfHoursBlock(this.wciForm['curriculumItemHoursId']));
    this.showWciForm.set(true);
  }

  openWciEdit(row: DeliveryRow) {
    this.wciEditingId.set(row.id);
    this.wciForm = {
      curriculumItemHoursId: row.hoursId,
      departmentId: row.departmentId,
      teachingFormat: row.teachingFormat,
      lecturerCount: String(row.lecturerCount ?? 1),
      courseId: row.electiveCourseId
    };
    this.wciGroupIds = [...row.groupIds];
    this.wciError.set('');
    this.loadWciGroupOptions(row.specialtyId);
    this.showWciForm.set(true);
  }

  closeWciForm() { this.showWciForm.set(false); this.wciError.set(''); }

  /** Changing the block changes the specialty, and with it which groups may be assigned. */
  onWciBlockChange(hoursId: string) {
    this.wciForm['curriculumItemHoursId'] = hoursId;
    this.wciGroupIds = [];
    this.loadWciGroupOptions(this.specialtyOfHoursBlock(hoursId));
  }

  private specialtyOfHoursBlock(hoursId: string): string {
    for (const item of this.curricula()) {
      if ((item.hours ?? []).some((h) => h.id === hoursId)) return item.specialty?.id ?? '';
    }
    return '';
  }

  private loadWciGroupOptions(specialtyId: string) {
    if (!specialtyId) { this.wciGroupOptions.set([]); return; }
    const q = `{ academicGroups { academicGroupConnection(limit: 500, offset: 0, specialtyId: "${specialtyId}") { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.wciGroupOptions.set(
        (d.academicGroups.academicGroupConnection.nodes ?? [])
          .map((g: any) => ({ id: String(g.id), label: g.name }))
          .sort((a: Option, b: Option) => compareUk(a.label, b.label))),
      error: () => this.wciGroupOptions.set([])
    });
  }

  /**
   * `courseId` here is the *chosen elective*, not this page's discipline — the one field on a
   * working curriculum item that names a course other than the one it delivers. It is sent only
   * when this page is an umbrella; on an ordinary discipline it is explicitly `null`, so a course
   * that stops being an ELECTIVE_GROUP cannot leave a stale choice behind.
   */
  saveWci() {
    const hoursId = this.wciForm['curriculumItemHoursId'];
    if (!hoursId) { this.wciError.set('Оберіть позицію навчального плану.'); return; }
    const departmentId = this.wciForm['departmentId'];
    if (!departmentId) { this.wciError.set('Оберіть кафедру.'); return; }
    const lecturerCount = Number(this.wciForm['lecturerCount']);
    if (!Number.isFinite(lecturerCount) || lecturerCount < 1) {
      this.wciError.set('Кількість викладачів має бути додатним числом.');
      return;
    }

    const input: Record<string, any> = {
      curriculumItemHoursId: hoursId,
      departmentId,
      teachingFormat: this.wciForm['teachingFormat'] || 'TOGETHER',
      lecturerCount,
      courseId: this.isElectiveGroup() ? (this.wciForm['courseId'] || null) : null,
      academicGroupIds: this.wciGroupIds
    };

    const id = this.wciEditingId();
    const q = id
      ? `mutation($id: ID!, $input: WorkingCurriculumItemInputPayload!) { workingCurriculumItems { updateWorkingCurriculumItem(id: $id, workingCurriculumItem: $input) { isSuccess errorStatus } } }`
      : `mutation($input: WorkingCurriculumItemInputPayload!) { workingCurriculumItems { createWorkingCurriculumItem(workingCurriculumItem: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = id ? d.workingCurriculumItems.updateWorkingCurriculumItem
                       : d.workingCurriculumItems.createWorkingCurriculumItem;
        if (!res.isSuccess) { this.wciError.set(res.errorStatus || 'Помилка операції'); return; }
        this.closeWciForm();
        this.load();
      },
      error: (e) => this.wciError.set(e.message)
    });
  }

  pendingWciDelete = signal<DeliveryRow | null>(null);

  askRemoveWci(row: DeliveryRow) { this.wciError.set(''); this.pendingWciDelete.set(row); }
  cancelRemoveWci() { this.pendingWciDelete.set(null); }

  confirmRemoveWci() {
    const row = this.pendingWciDelete();
    if (!row) return;
    this.pendingWciDelete.set(null);
    this.removeWci(row);
  }

  private removeWci(row: DeliveryRow) {
    const q = `mutation($id: ID!) { workingCurriculumItems { deleteWorkingCurriculumItem(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: row.id }).subscribe({
      next: (d: any) => {
        const res = d.workingCurriculumItems.deleteWorkingCurriculumItem;
        if (!res.isSuccess) { this.wciError.set(res.errorStatus || 'Помилка видалення'); return; }
        this.load();
      },
      error: (e) => this.wciError.set(e.message)
    });
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  openDelete() { this.deleteError.set(''); this.showDeleteConfirm.set(true); }
  closeDelete() { this.showDeleteConfirm.set(false); this.deleteError.set(''); }

  /** Back where the discipline was reached from — its кафедра, its факультет, or the plain table. */
  private afterDeleteRoute(): any[] {
    const c = this.course();
    if (c?.department) return ['/department', c.department.id];
    const fac = c?.faculty ?? c?.department?.faculty;
    if (fac) return ['/faculty', fac.id];
    return ['/e/course'];
  }

  confirmDelete() {
    const back = this.afterDeleteRoute();
    const q = `mutation($id: ID!) { courses { deleteCourse(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.courseId }).subscribe({
      next: (d: any) => {
        const res = d.courses.deleteCourse;
        if (res.isSuccess) this.router.navigate(back);
        else this.deleteError.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.deleteError.set(e.message)
    });
  }
}
