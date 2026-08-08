import { Observable, forkJoin, map } from 'rxjs';
import { GraphqlService } from './graphql.service';
import { StatWorkload } from './workload-stats';
import { courseLabel } from './course-label';

/**
 * Loads a department's whole delivered workload — every working curriculum item plus every combined
 * item — and flattens it into the shape {@link computeStats} wants.
 *
 * Shared by the statistics table on "Обмеження навантаження" and the per-lecturer drill-down, so the
 * two can never disagree about what a lecturer carries. `LecturerWorkloadList` keeps its own richer
 * query because it needs candidate pools and student pairings for editing, not just totals.
 */

const ITEMS_QUERY = (departmentId: string) => `{
  workingCurriculumItems { workingCurriculumItemConnection(limit: 1000, offset: 0, departmentId: "${departmentId}") { nodes {
    id teachingFormat
    course { id name courseType tags { tag } }
    academicGroups { id name }
    combinedWorkingCurriculumItems { id }
    curriculumItemHours {
      hourType hours
      curriculumItem { semester specialty { id name } course { id name courseType tags { tag } } }
    }
    workloads {
      id
      lecturers { id }
      studentAssignments { lecturer { id } }
    }
  } } }
}`;

const COMBINED_QUERY = (departmentId: string) => `{
  combinedWorkingCurriculumItems { combinedWorkingCurriculumItemConnection(limit: 1000, offset: 0, departmentIds: ["${departmentId}"]) { nodes {
    id
    workingCurriculumItems {
      academicGroups { id name }
      curriculumItemHours {
        hourType hours
        curriculumItem { semester specialty { id name } course { id name courseType tags { tag } } }
      }
    }
    workloads { id lecturers { id } }
  } } }
}`;

export function loadDepartmentWorkloads(gql: GraphqlService, departmentId: string): Observable<StatWorkload[]> {
  return forkJoin({
    items: gql.request(ITEMS_QUERY(departmentId)),
    combined: gql.request(COMBINED_QUERY(departmentId))
  }).pipe(map(({ items, combined }: any) => {
    const out: StatWorkload[] = [];

    for (const wci of items.workingCurriculumItems.workingCurriculumItemConnection.nodes) {
      // Items merged into a combined item are delivered through that item's workloads instead;
      // counting both would double every hour.
      if ((wci.combinedWorkingCurriculumItems ?? []).length > 0) continue;

      const cih = wci.curriculumItemHours;
      const ci = cih.curriculumItem;
      // An elective group's real discipline is the chosen elective, not the container course.
      const course = wci.course ?? ci.course;
      const groupNames = (wci.academicGroups ?? []).map((g: any) => g.name);

      for (const w of wci.workloads ?? []) {
        const studentsByLecturer: Record<string, number> = {};
        for (const a of w.studentAssignments ?? []) {
          const id = a.lecturer?.id;
          if (id) studentsByLecturer[id] = (studentsByLecturer[id] ?? 0) + 1;
        }
        out.push({
          workloadId: w.id,
          hours: cih.hours ?? 0,
          hourType: cih.hourType,
          courseId: course.id,
          courseName: course.name,
          courseLabel: courseLabel(course.name, course.tags),
          courseType: course.courseType ?? ci.course.courseType,
          semester: ci.semester,
          specialtyName: ci.specialty?.name ?? '',
          teachingFormat: wci.teachingFormat,
          lecturerIds: (w.lecturers ?? []).map((l: any) => l.id),
          studentsByLecturer,
          groupNames
        });
      }
    }

    for (const c of combined.combinedWorkingCurriculumItems.combinedWorkingCurriculumItemConnection.nodes) {
      const first = c.workingCurriculumItems?.[0];
      if (!first) continue;
      const cih = first.curriculumItemHours;
      const ci = cih.curriculumItem;
      // A combined item is taught once for all its members, so it is counted once, at its own hours.
      const groupNames = (c.workingCurriculumItems ?? [])
        .flatMap((m: any) => (m.academicGroups ?? []).map((g: any) => g.name));

      for (const w of c.workloads ?? []) {
        out.push({
          workloadId: w.id,
          hours: cih.hours ?? 0,
          hourType: cih.hourType,
          courseId: ci.course.id,
          courseName: ci.course.name,
          courseLabel: courseLabel(ci.course.name, ci.course.tags),
          courseType: ci.course.courseType,
          semester: ci.semester,
          specialtyName: (c.workingCurriculumItems ?? [])
            .map((m: any) => m.curriculumItemHours.curriculumItem.specialty?.name)
            .filter(Boolean).join(', '),
          teachingFormat: 'TOGETHER',
          lecturerIds: (w.lecturers ?? []).map((l: any) => l.id),
          groupNames,
          combined: true
        });
      }
    }

    return out;
  }));
}
