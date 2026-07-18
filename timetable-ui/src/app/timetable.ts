import { Component, computed, inject, signal } from '@angular/core';
import { GraphqlService } from './graphql.service';

interface Entry {
  id: string;
  dayOfWeek: number;
  weekParity: string;
  timeSlot: { ordinal: number; startTime: string; endTime: string };
  room: { number: string };
  workload: {
    classType: string;
    course?: { name: string };
    lecturers?: { lastName: string }[];
    academicGroup?: { name: string };
    combinedGroup?: { name: string };
  };
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

  /** Distinct time slots (rows), sorted by ordinal. */
  slots = computed(() => {
    const byOrdinal = new Map<number, Entry['timeSlot']>();
    for (const e of this.entries()) byOrdinal.set(e.timeSlot.ordinal, e.timeSlot);
    return [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  });

  cell(ordinal: number, day: number): Entry[] {
    return this.entries().filter((e) => e.timeSlot.ordinal === ordinal && e.dayOfWeek === day);
  }

  audience(e: Entry): string {
    return e.workload.academicGroup?.name ?? e.workload.combinedGroup?.name ?? '';
  }

  lecturerNames(e: Entry): string {
    return (e.workload.lecturers ?? []).map((l) => l.lastName).join(', ');
  }

  constructor() {
    const q = `{ timetableEntries { timetableEntryConnection(limit: 1000) { nodes {
      id dayOfWeek weekParity
      timeSlot { ordinal startTime endTime }
      room { number }
      workload { classType course { name } lecturers { lastName } academicGroup { name } combinedGroup { name } }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.entries.set(d.timetableEntries.timetableEntryConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }
}
