/**
 * Turns a flat list of `timetable_entries` into the grid every timetable view and the printed
 * «Розклад занять» read from: distinct пари down the side, a chosen dimension across the top, and
 * the classes that fall in each cell.
 *
 * Framework-free, like the plan modules: plain objects in, plain objects out, so the faculty,
 * department, lecturer and room views, the printed sheet and a Node test all agree. This is also
 * where the three pieces of denormalisation every consumer needs live — the discipline behind a
 * workload, the groups it is taught to, and the class's end time — each of which `timetable.ts`
 * used to work out for itself.
 *
 * ── What a розклад занять is, legally ───────────────────────────────────────────────────────────
 *
 * **Nothing.** Unlike the навчальний план (named once in ст. 36 ч. 2 п. 8) the розклад занять is not
 * mentioned in the Закон України «Про вищу освіту» at all, is absent from the list of documents
 * ст. 30 ч. 2 Закону «Про освіту» requires a заклад to publish, and does not appear in the
 * Ліцензійні умови (ПКМУ № 1187). Every rule about it — who approves it, how long before the
 * semester it must be published, how long a пара lasts, how many a day a student may have — is
 * institutional. The numbers that feel canonical (академічна година 45 хв, пара = дві академічні
 * години, ≤ 9 годин на день) come from п. 3.2 and п. 4.1–4.2 of наказ МО України № 161 від
 * 02.06.1993, **repealed** by наказ МОН № 1310 від 13.11.2014 and since re-adopted verbatim by ЗВО
 * into their own положення. Nothing here cites it.
 *
 * That is why the one number this module needs — how long an academic hour is — is read from
 * `global_properties` rather than assumed: ЗВО genuinely differ (ЛНУ and ЗНУ use 40 minutes, КПІ
 * and Грінченка 45), and so do their пари (80 minutes at ЛНУ, 95 at КПІ).
 */

import { compareUk } from './sort';

/** 1 = Monday … 6 = Saturday, matching `timetable_entries.day_of_week`. */
export const TIMETABLE_DAYS = [1, 2, 3, 4, 5, 6] as const;

export const DAY_NAMES: Record<number, string> = {
  1: 'Понеділок', 2: 'Вівторок', 3: 'Середа', 4: 'Четвер', 5: "П'ятниця", 6: 'Субота'
};

export const DAY_NAMES_SHORT: Record<number, string> = {
  1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб'
};

/** Roman numerals, the way ЛНУ numbers пари in its published розклад. */
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * How a kind of work is abbreviated in a timetable cell. There is **no standard**: ЛНУ writes
 * «лекція / практ. / лаб. / сем.», ХНУ ім. Каразіна «(Л) / (Пр) / (Сем)», КПІ «Лек / Прак / Лаб».
 * ЛНУ's own forms are used, since this is its system.
 */
export const HOUR_TYPE_SHORT: Record<string, string> = {
  LECTURE: 'лекція', PRACTICAL: 'практ.', LAB: 'лаб.',
  CONSULTATION: 'консульт.', ASSESSMENT: 'контр. захід'
};

/** Abbreviated academic posts, as printed beside a lecturer's name in a ЛНУ розклад. */
export const POSITION_SHORT: Record<string, string> = {
  ASSISTANT: 'ас.', TEACHER: 'викл.', SENIOR_LECTURER: 'ст. викл.',
  DOCENT: 'доц.', PROFESSOR: 'проф.', HEAD_OF_DEPARTMENT: 'зав. каф.'
};

export type ColumnMode = 'group' | 'lecturer' | 'room' | 'single';

// ── Input, as the GraphQL query returns it ──────────────────────────────────

export interface RawCourseRef {
  course?: { id: string; name: string } | null;
  curriculumItemHours?: {
    hourType?: string;
    curriculumItem?: {
      semester?: number;
      course?: { id: string; name: string; courseType?: string } | null;
      specialty?: { id: string; name: string } | null;
    } | null;
  } | null;
  department?: { id: string; name: string } | null;
}

export interface RawEntry {
  id: string;
  dayOfWeek: number;
  weekParity: string;
  classStartTime?: { id?: string; ordinal: number; startTime: string } | null;
  room?: { id: string; number: string; name?: string | null } | null;
  workload?: {
    id?: string;
    durationHours?: number;
    lecturers?: { id: string; firstName?: string; lastName?: string; position?: string }[];
    academicGroups?: { id: string; name: string }[];
    combinedGroups?: { name?: string; academicGroups?: { id: string; name: string }[] }[];
    workingCurriculumItem?: RawCourseRef | null;
    combinedWorkingCurriculumItem?: { workingCurriculumItems?: RawCourseRef[] } | null;
  } | null;
}

// ── Output ──────────────────────────────────────────────────────────────────

export interface GridLecturer {
  id: string;
  /** «Музичук А. О.» — surname plus initials, which is what fits a timetable cell. */
  name: string;
  /** «доц. Музичук А. О.» */
  withPosition: string;
}

export interface GridEntry {
  id: string;
  dayOfWeek: number;
  /** Raw `timetable_entries.week_parity`: WEEKLY / NUMERATOR / DENOMINATOR. */
  weekParity: string;
  ordinal: number;
  startTime: string;
  endTime: string;
  roomId: string;
  /** «265» or «265 (Універсальна)». */
  roomLabel: string;
  courseName: string;
  /** Raw `curriculum_item_hours.hour_type` of the block this class delivers. */
  hourType: string;
  hourTypeShort: string;
  lecturers: GridLecturer[];
  groups: { id: string; name: string }[];
  groupNames: string;
  specialtyName: string;
  semester: number | null;
  departmentId: string;
  departmentName: string;
}

export interface GridSlot {
  ordinal: number;
  startTime: string;
  /** Longest end time among the classes in this slot; blank when nothing is scheduled in it. */
  endTime: string;
  /** «I», «II», … */
  roman: string;
}

export interface GridColumn {
  id: string;
  label: string;
}

export interface TimetableGrid {
  days: number[];
  slots: GridSlot[];
  columns: GridColumn[];
  entries: GridEntry[];
  /** `${day}|${ordinal}|${columnId}` → the classes in that cell. */
  cells: Map<string, GridEntry[]>;
  /** Classes that could not be placed — no start time, or no column of their own. */
  unplaced: GridEntry[];
  /** Distinct rooms used, for the address legend a printed розклад carries. */
  rooms: { id: string; label: string }[];
}

export const cellKey = (day: number, ordinal: number, columnId: string): string =>
  `${day}|${ordinal}|${columnId}`;

// ── Building it ─────────────────────────────────────────────────────────────

/** «Музичук А. О.» — a timetable cell has no room for a full given name. */
const shortName = (firstName?: string, lastName?: string): string => {
  const surname = (lastName ?? '').trim();
  const initial = (firstName ?? '').trim().charAt(0);
  return initial ? `${surname} ${initial}.` : surname;
};

/** Start time plus the class's length, in minutes of one academic hour. */
const addMinutes = (startTime: string, minutes: number): string => {
  const [h, m] = String(startTime ?? '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * The discipline a working curriculum item delivers. Normally its curriculum item's course — but
 * when that course is an `ELECTIVE_GROUP` (an umbrella students choose within), the discipline
 * actually taught is the elective on the working item itself.
 */
const courseOf = (ref: RawCourseRef | null | undefined): { name: string; hourType: string;
                                                           semester: number | null;
                                                           specialtyName: string;
                                                           departmentId: string;
                                                           departmentName: string } => {
  const ci = ref?.curriculumItemHours?.curriculumItem;
  const umbrella = ci?.course;
  const name = umbrella?.courseType === 'ELECTIVE_GROUP' && ref?.course
    ? ref.course.name
    : (umbrella?.name ?? '');
  return {
    name,
    hourType: ref?.curriculumItemHours?.hourType ?? '',
    semester: ci?.semester ?? null,
    specialtyName: ci?.specialty?.name ?? '',
    departmentId: ref?.department?.id ?? '',
    departmentName: ref?.department?.name ?? ''
  };
};

/** Flattens one entry into the shape every view renders. */
export function toGridEntry(entry: RawEntry, academicHourMinutes: number): GridEntry {
  const w = entry.workload;
  const ref = w?.workingCurriculumItem ?? w?.combinedWorkingCurriculumItem?.workingCurriculumItems?.[0] ?? null;
  const course = courseOf(ref);

  const groupsById = new Map<string, { id: string; name: string }>();
  for (const g of w?.academicGroups ?? []) groupsById.set(g.id, g);
  // A combined group is a bundle of academic groups taught together; the cell names its members,
  // because that is what a student looks for.
  for (const cg of w?.combinedGroups ?? []) {
    for (const g of cg.academicGroups ?? []) groupsById.set(g.id, g);
  }
  const groups = [...groupsById.values()].sort((a, b) => compareUk(a.name, b.name));

  const startTime = entry.classStartTime?.startTime ?? '';
  const duration = w?.durationHours ?? 0;

  return {
    id: entry.id,
    dayOfWeek: entry.dayOfWeek,
    weekParity: entry.weekParity,
    ordinal: entry.classStartTime?.ordinal ?? 0,
    startTime,
    endTime: duration > 0 ? addMinutes(startTime, duration * academicHourMinutes) : '',
    roomId: entry.room?.id ?? '',
    roomLabel: entry.room
      ? (entry.room.name ? `${entry.room.number} (${entry.room.name})` : entry.room.number)
      : '',
    courseName: course.name,
    hourType: course.hourType,
    hourTypeShort: HOUR_TYPE_SHORT[course.hourType] ?? '',
    lecturers: (w?.lecturers ?? []).map((l) => {
      const name = shortName(l.firstName, l.lastName);
      const post = POSITION_SHORT[l.position ?? ''] ?? '';
      return { id: l.id, name, withPosition: post ? `${post} ${name}` : name };
    }),
    groups,
    groupNames: groups.map((g) => g.name).join(', '),
    specialtyName: course.specialtyName,
    semester: course.semester,
    departmentId: course.departmentId,
    departmentName: course.departmentName
  };
}

/**
 * Builds the grid.
 *
 * `columnMode` chooses what runs across the top, and with it which of the four documents this is:
 * **group** is the розклад a faculty publishes (ЛНУ prints exactly this — day and пара down the
 * side, academic groups across), **lecturer** is the викладацький розклад a кафедра works from,
 * **room** the аудиторний розклад a диспетчерська keeps, and **single** one flat column for a view
 * that is already scoped to one subject.
 *
 * An entry appears once per column it belongs to: a lecture given to three groups occupies three
 * cells of a group-column grid, which is what makes the printed sheet readable down a group's
 * column and is exactly how the published ones look.
 */
export function buildTimetableGrid(
  raw: RawEntry[],
  options: { columnMode: ColumnMode; academicHourMinutes: number;
             columnFilter?: (id: string) => boolean }): TimetableGrid {

  const { columnMode, academicHourMinutes } = options;
  const entries = raw.map((e) => toGridEntry(e, academicHourMinutes));

  const slotsByOrdinal = new Map<number, GridSlot>();
  const columnsById = new Map<string, GridColumn>();
  const roomsById = new Map<string, { id: string; label: string }>();
  const cells = new Map<string, GridEntry[]>();
  const unplaced: GridEntry[] = [];

  const columnsOf = (entry: GridEntry): GridColumn[] => {
    switch (columnMode) {
      case 'group':    return entry.groups.map((g) => ({ id: g.id, label: g.name }));
      case 'lecturer': return entry.lecturers.map((l) => ({ id: l.id, label: l.name }));
      case 'room':     return entry.roomId ? [{ id: entry.roomId, label: entry.roomLabel }] : [];
      default:         return [{ id: 'all', label: '' }];
    }
  };

  for (const entry of entries) {
    if (entry.roomId) roomsById.set(entry.roomId, { id: entry.roomId, label: entry.roomLabel });

    if (!entry.ordinal || !entry.startTime) { unplaced.push(entry); continue; }

    const slot = slotsByOrdinal.get(entry.ordinal);
    if (!slot) {
      slotsByOrdinal.set(entry.ordinal, {
        ordinal: entry.ordinal, startTime: entry.startTime, endTime: entry.endTime,
        roman: ROMAN[entry.ordinal - 1] ?? String(entry.ordinal)
      });
    } else if (entry.endTime > slot.endTime) {
      // Classes of different lengths can share a start; the row shows the longest, so the printed
      // «I 08:30–09:50» never claims a class ends earlier than one of them does.
      slot.endTime = entry.endTime;
    }

    const placed = columnsOf(entry).filter((c) => !options.columnFilter || options.columnFilter(c.id));
    if (!placed.length) { unplaced.push(entry); continue; }

    for (const column of placed) {
      columnsById.set(column.id, column);
      const key = cellKey(entry.dayOfWeek, entry.ordinal, column.id);
      const bucket = cells.get(key);
      if (bucket) bucket.push(entry);
      else cells.set(key, [entry]);
    }
  }

  // Within a cell, the two halves of a biweekly slot read in a fixed order — чисельник before
  // знаменник — so a reader comparing two weeks always finds them the same way round.
  const parityOrder = (p: string) => (p === 'NUMERATOR' ? 0 : p === 'DENOMINATOR' ? 1 : -1);
  for (const bucket of cells.values()) {
    bucket.sort((a, b) => parityOrder(a.weekParity) - parityOrder(b.weekParity)
      || compareUk(a.courseName, b.courseName));
  }

  return {
    days: [...TIMETABLE_DAYS],
    slots: [...slotsByOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal),
    columns: [...columnsById.values()].sort((a, b) => compareUk(a.label, b.label)),
    entries,
    cells,
    unplaced,
    rooms: [...roomsById.values()].sort((a, b) => compareUk(a.label, b.label))
  };
}

/** The classes in one cell, or an empty array. */
export const gridCell = (grid: TimetableGrid, day: number, ordinal: number, columnId: string): GridEntry[] =>
  grid.cells.get(cellKey(day, ordinal, columnId)) ?? [];

/** True when nothing at all is scheduled on a day — the column is then dropped from the sheet. */
export const dayIsEmpty = (grid: TimetableGrid, day: number): boolean =>
  !grid.entries.some((e) => e.dayOfWeek === day && e.ordinal > 0);
