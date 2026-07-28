import { Component, computed, inject, signal } from '@angular/core';
import { GraphqlService } from './graphql.service';
import { WEEK_PARITY_OPTIONS } from './entities';
import { compareUk } from './sort';

interface CourseRef {
  course?: { id: string; name: string } | null;
  curriculumItemHours: { curriculumItem: { course: { name: string; courseType: string } } };
}

interface Workload {
  durationHours: number;
  lecturers?: { lastName: string }[];
  academicGroups?: { name: string }[];
  combinedGroups?: { academicGroups: { name: string }[] }[];
  workingCurriculumItem?: CourseRef | null;
  combinedWorkingCurriculumItem?: { workingCurriculumItems: CourseRef[] } | null;
}

interface Entry {
  id: string;
  dayOfWeek: number;
  weekParity: string;
  classStartTime: { ordinal: number; startTime: string };
  room: { number: string };
  workload: Workload;
}

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

@Component({
  selector: 'app-timetable',
  templateUrl: './timetable.html'
})
export class Timetable {
  private gql = inject(GraphqlService);

  entries = signal<Entry[]>([]);
  error = signal('');
  readonly days = [1, 2, 3, 4, 5, 6];
  dayLabel = (d: number) => DAYS[d - 1] ?? `Day ${d}`;

  /** Duration of one academic hour in minutes (academic_hour_duration_minutes global property),
   *  used to compute each class's end time from its workload's durationHours. */
  private academicHourDurationMinutes = signal(40);

  /** Distinct class start times (rows), sorted by ordinal. */
  slots = computed(() => {
    const byOrdinal = new Map<number, Entry['classStartTime']>();
    for (const e of this.entries()) byOrdinal.set(e.classStartTime.ordinal, e.classStartTime);
    return [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  });

  cell(ordinal: number, day: number): Entry[] {
    return this.entries().filter((e) => e.classStartTime.ordinal === ordinal && e.dayOfWeek === day);
  }

  /**
   * The discipline course of a working curriculum item is normally its curriculum item's course.
   * But when that course is an ELECTIVE_GROUP (a group of electives students choose between), the
   * curriculum item's course is just the umbrella group — the actual discipline being taught is the
   * specific elective referenced by working_curriculum_items.course_id.
   */
  private courseNameFor(wci: CourseRef): string {
    const ci = wci.curriculumItemHours.curriculumItem;
    if (ci.course.courseType === 'ELECTIVE_GROUP' && wci.course) return wci.course.name;
    return ci.course.name;
  }

  courseName(e: Entry): string {
    const w = e.workload;
    if (w.workingCurriculumItem) return this.courseNameFor(w.workingCurriculumItem);
    const first = w.combinedWorkingCurriculumItem?.workingCurriculumItems?.[0];
    return first ? this.courseNameFor(first) : '';
  }

  audience(e: Entry): string {
    const byName = new Map<string, string>();
    for (const g of e.workload.academicGroups ?? []) byName.set(g.name, g.name);
    for (const cg of e.workload.combinedGroups ?? []) {
      for (const g of cg.academicGroups ?? []) byName.set(g.name, g.name);
    }
    return [...byName.values()].sort(compareUk).join(', ');
  }

  lecturerNames(e: Entry): string {
    return (e.workload.lecturers ?? []).map((l) => l.lastName).join(', ');
  }

  weekParityLabel(v: string): string {
    return WEEK_PARITY_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  /** End time of the class, derived from its class start time plus the workload's durationHours
   *  (in academic hours) and the academic_hour_duration_minutes global property. */
  endTime(e: Entry): string {
    const [h, m] = e.classStartTime.startTime.split(':').map(Number);
    const total = h * 60 + m + e.workload.durationHours * this.academicHourDurationMinutes();
    const hh = Math.floor(total / 60) % 24;
    const mm = total % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  constructor() {
    this.loadAcademicHourDuration();
    const q = `{ timetableEntries { timetableEntryConnection(limit: 1000) { nodes {
      id dayOfWeek weekParity
      classStartTime { ordinal startTime }
      room { number }
      workload {
        durationHours
        lecturers { lastName }
        academicGroups { name }
        combinedGroups { academicGroups { name } }
        workingCurriculumItem { course { id name } curriculumItemHours { curriculumItem { course { name courseType } } } }
        combinedWorkingCurriculumItem {
          workingCurriculumItems { course { id name } curriculumItemHours { curriculumItem { course { name courseType } } } }
        }
      }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.entries.set(d.timetableEntries.timetableEntryConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadAcademicHourDuration() {
    const q = `{ globalProperties { globalProperty(name: "academic_hour_duration_minutes") { value } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const minutes = Number(d.globalProperties.globalProperty?.value);
        if (minutes > 0) this.academicHourDurationMinutes.set(minutes);
      },
      error: () => {}
    });
  }
}
