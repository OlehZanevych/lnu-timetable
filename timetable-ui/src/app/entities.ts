/** Client-side metadata mirroring the backend's config-driven GraphQL schema. */

export interface FieldMeta {
  name: string;            // scalar field name, or FK input field (e.g. "facultyId") for refs
  label: string;
  type: 'text' | 'number' | 'boolean' | 'textarea' | 'ref' | 'enum' | 'multiref' | 'tags' | 'time';
  required?: boolean;
  // time-only: hour dropdown bounds and the minute dropdown's step, in minutes
  minHour?: number;
  maxHour?: number;
  minuteStep?: number;
  // enum-only:
  enumOptions?: { value: string; label: string }[];
  // ref/multiref-only:
  ref?: string;            // referenced entity key (single name), used to load options
  relation?: string;       // relation field name in GraphQL (e.g. "faculty"/"specialties"/"tags")
  refLabel?: string;       // scalar field on the referenced entity used as a label
  // optional parent filter (e.g. filter departments by faculty when selecting for lecturer)
  parentFilter?: { namespace: string; list: string; label: string };
  // tags-only: scalar field on each nested row holding the tag text (e.g. "tag")
  tagField?: string;
}

const multiref = (name: string, label: string, ref: string, relation: string, refLabel: string): FieldMeta =>
  ({ name, label, type: 'multiref', ref, relation, refLabel });

const tags = (name: string, label: string, relation: string, tagField: string): FieldMeta =>
  ({ name, label, type: 'tags', relation, tagField });

/** An "HH:mm" string edited through an hour + minute dropdown pair (see app-time-select). */
const time = (name: string, label: string, required = false, minHour = 6, maxHour = 21, minuteStep = 5): FieldMeta =>
  ({ name, label, type: 'time', required, minHour, maxHour, minuteStep });

export interface EntityMeta {
  name: string;            // GraphQL type name, e.g. "Faculty"
  label: string;           // menu label
  single: string;          // query field + create/update arg name, e.g. "faculty"
  namespace: string;       // grouping field, e.g. "faculties"
  list: string;            // connection query field, e.g. "facultyConnection"
  fields: FieldMeta[];
  filterParam?: string;    // GraphQL arg name for optional scoping (e.g. "facultyId", "departmentId")
  /**
   * Router path of this entity's own detail page, when it has one (e.g. 'course' → /course/:id).
   * Set it and every generic table of that entity — wherever it is embedded — grows an
   * «Відкрити →» link, so the drill-down pages are reachable from the places the entity is listed
   * rather than only by typing a URL.
   */
  detailRoute?: string;
}

const ref = (name: string, label: string, ref: string, relation: string, refLabel: string, required = false): FieldMeta =>
  ({ name, label, type: 'ref', ref, relation, refLabel, required });

/** Adapts a `{ value, label }` enum options list (this file's convention) to app-search-select's `{ id, label }` Option shape. */
export const toOptions = (opts: { value: string; label: string }[]): { id: string; label: string }[] =>
  opts.map((o) => ({ id: o.value, label: o.label }));

export const DEGREE_OPTIONS = [
  { value: 'JUNIOR_BACHELOR', label: 'Молодший бакалавр' },
  { value: 'BACHELOR',        label: 'Бакалавр' },
  { value: 'MASTER',          label: 'Магістр' },
  { value: 'PHD',             label: 'Доктор філософії' },
  { value: 'DOCTOR_OF_SCIENCE', label: 'Доктор наук' }
];

/** lecturers.position — the academic posts a lecturer can hold, lowest first. */
export const POSITION_OPTIONS = [
  { value: 'ASSISTANT',          label: 'Асистент' },
  { value: 'TEACHER',            label: 'Викладач' },
  { value: 'SENIOR_LECTURER',    label: 'Старший викладач' },
  { value: 'DOCENT',             label: 'Доцент' },
  { value: 'PROFESSOR',          label: 'Професор' },
  { value: 'HEAD_OF_DEPARTMENT', label: 'Завідувач кафедри' }
];

/** Ukrainian label for a lecturers.position value; falls back to the raw value if ever unknown. */
export const positionLabel = (v: string): string =>
  POSITION_OPTIONS.find((o) => o.value === v)?.label ?? v;

export const COURSE_TYPE_OPTIONS = [
  { value: 'MANDATORY',          label: "Обов'язкова" },
  { value: 'ELECTIVE_GROUP',     label: 'Група вибіркових' },
  { value: 'ELECTIVE',           label: 'Вибіркова' },
  { value: 'OPTIONAL',           label: 'Факультатив' },
  { value: 'INTERNSHIP',         label: 'Практика' },
  { value: 'COURSE_PROJECT',     label: 'Курсовий проєкт' },
  { value: 'COURSE_WORK',        label: 'Курсова робота' },
  { value: 'QUALIFICATION_WORK', label: 'Кваліфікаційна робота' }
];

/** Ukrainian label for a courses.course_type value; falls back to the raw value if ever unknown. */
export const courseTypeLabel = (v: string): string =>
  COURSE_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;

// ── Academic terms ──────────────────────────────────────────────────────────
//
// curriculum_items.semester counts semesters across the whole programme (1..11 in real data).
// People read that as a course year plus a half of it, so the UI shows "3 курс — друге півріччя"
// rather than "семестр 6". The stored value is unchanged; only its presentation is.

/** Course year a programme-wide semester falls in: semesters 1-2 → year 1, 3-4 → year 2, … */
export const courseYearOf = (semester: number): number => Math.ceil(semester / 2);

/** 1 for the first half-year of that course year (odd semesters), 2 for the second (even). */
export const halfYearOf = (semester: number): 1 | 2 => (semester % 2 === 1 ? 1 : 2);

/** Lower case, for use inside a phrase: "3 курс — друге півріччя". */
export const HALF_YEAR_LABELS: Record<number, string> = {
  1: 'перше півріччя',
  2: 'друге півріччя'
};

/** Capitalised, for use as a heading in its own right. */
export const HALF_YEAR_TITLES: Record<number, string> = {
  1: 'Перше півріччя',
  2: 'Друге півріччя'
};

/** The two halves of an academic year, in the order they are taught. */
export const HALF_YEARS: readonly (1 | 2)[] = [1, 2];

/** "3 курс — друге півріччя". */
export const termLabel = (semester: number): string =>
  `${courseYearOf(semester)} курс — ${HALF_YEAR_LABELS[halfYearOf(semester)]}`;

/** "3 курс, 2 півріччя" — the compact form, for table cells. */
export const termLabelShort = (semester: number): string =>
  `${courseYearOf(semester)} курс, ${halfYearOf(semester)} півр.`;

export const CONTROL_FORM_OPTIONS = [
  { value: 'EXAM',          label: 'Екзамен' },
  { value: 'CREDIT',        label: 'Залік' },
  { value: 'GRADED_CREDIT', label: 'Диф. залік' }
];

/** Order matches the hour_type enum in schema.sql, which is also the DB sort order. */
export const HOUR_TYPE_OPTIONS = [
  { value: 'LECTURE',          label: 'Лекції' },
  { value: 'PRACTICAL',        label: 'Практичні' },
  { value: 'LAB',              label: 'Лабораторні' },
  { value: 'CONSULTATION',     label: 'Консультації' },
  { value: 'ASSESSMENT',       label: 'Контрольні заходи' },
  { value: 'INDEPENDENT_WORK', label: 'Самостійна робота' }
];

/**
 * The two halves of the academic year, matching the parity of `curriculum_items.semester`
 * (1,3,5… vs 2,4,6…). Every screen that offers a choice of half-year offers exactly these two —
 * the timetable views, the schedule builder, «Призначення аудиторій», «Мій кабінет», and the
 * `current_semester_parity` global property editor — so they are declared once.
 *
 * There is deliberately no "whole year": a grid holding both halves overlays classes that never
 * coexist and shows rooms and lecturers as double-booked when they are not.
 */
// Typed by inference rather than annotated: `entities.ts` has no Angular or component imports, and
// naming search-select's `Option` here would be the first. The literal is structurally identical.
export const SEMESTER_PARITY_OPTIONS = [
  { id: 'ODD', label: 'Перший (непарний)' },
  { id: 'EVEN', label: 'Другий (парний)' }
];

export const TEACHING_FORMAT_OPTIONS = [
  { value: 'TOGETHER',     label: 'Разом' },
  { value: 'SEPARATELY',   label: 'Окремо' },
  { value: 'INDIVIDUALLY', label: 'Індивідуально з кожним студентом' }
];

export const STUDY_FORM_OPTIONS = [
  { value: 'FULL_TIME', label: 'Денна' },
  { value: 'PART_TIME', label: 'Заочна' }
];

export const ROOM_KIND_OPTIONS = [
  { value: 'LECTURE_HALL', label: 'Лекційна аудиторія' },
  { value: 'COMPUTER_LAB', label: "Комп'ютерний клас" },
  { value: 'SEMINAR_ROOM', label: 'Семінарська аудиторія' }
];

export const WEEK_PARITY_OPTIONS = [
  { value: 'WEEKLY',      label: 'Щотижня' },
  { value: 'NUMERATOR',   label: 'Чисельник' },
  { value: 'DENOMINATOR', label: 'Знаменник' }
];

/** Day of week values match timetable_entries.day_of_week: 1 = Monday .. 6 = Saturday. */
export const DAY_OF_WEEK_OPTIONS = [
  { value: '1', label: 'Понеділок' },
  { value: '2', label: 'Вівторок' },
  { value: '3', label: 'Середа' },
  { value: '4', label: 'Четвер' },
  { value: '5', label: "П'ятниця" },
  { value: '6', label: 'Субота' }
];

/** Duration of a class, in academic hours. Matches lecturer_workloads.duration_hours (1-4). */
export const DURATION_HOURS_OPTIONS = [
  { value: '1', label: '1 год.' },
  { value: '2', label: '2 год.' },
  { value: '3', label: '3 год.' },
  { value: '4', label: '4 год.' }
];

export const ENTITIES: EntityMeta[] = [
  {
    name: 'Building', label: 'Корпуси', single: 'building', namespace: 'buildings', list: 'buildingConnection', detailRoute: 'building',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'address', label: 'Адреса', type: 'text' },
      { name: 'city', label: 'Місто', type: 'text' },
      { name: 'postalCode', label: 'Поштовий індекс', type: 'text' }
    ]
  },
  {
    name: 'Faculty', label: 'Факультети', single: 'faculty', namespace: 'faculties', list: 'facultyConnection', detailRoute: 'faculty',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'abbreviation', label: 'Абревіатура', type: 'text' },
      { name: 'website', label: 'Веб-сайт', type: 'text' },
      { name: 'email', label: 'Ел. пошта', type: 'text' },
      { name: 'phone', label: 'Телефон', type: 'text' },
      ref('buildingId', 'Корпус', 'building', 'building', 'name')
    ]
  },
  {
    name: 'Department', label: 'Кафедри', single: 'department', namespace: 'departments', list: 'departmentConnection', filterParam: 'facultyId', detailRoute: 'department',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'abbreviation', label: 'Абревіатура', type: 'text' },
      { name: 'email', label: 'Ел. пошта', type: 'text' },
      { name: 'phone', label: 'Телефон', type: 'text' },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name', true)
    ]
  },
  {
    name: 'Specialty', label: 'Спеціальності', single: 'specialty', namespace: 'specialties', list: 'specialtyConnection', filterParam: 'facultyId', detailRoute: 'specialty',
    fields: [
      { name: 'code', label: 'Код', type: 'text', required: true },
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'degree', label: 'Ступінь', type: 'enum', required: true, enumOptions: DEGREE_OPTIONS },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name', true)
    ]
  },
  {
    name: 'Course', label: 'Дисципліни', single: 'course', namespace: 'courses', list: 'courseConnection', filterParam: 'departmentId', detailRoute: 'course',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'courseType', label: 'Тип', type: 'enum', required: true, enumOptions: COURSE_TYPE_OPTIONS },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name'),
      ref('departmentId', 'Кафедра', 'department', 'department', 'name'),
      ref('parentCourseId', 'Група вибіркових', 'course', 'parentCourse', 'name'),
      multiref('specialtyIds', 'Спеціальності', 'specialty', 'specialties', 'name'),
      tags('tags', 'Теги', 'tags', 'tag')
    ]
  },
  {
    name: 'AcademicDegree', label: 'Наукові ступені', single: 'academicDegree', namespace: 'academicDegrees', list: 'academicDegreeConnection',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'abbreviation', label: 'Абревіатура', type: 'text' },
      { name: 'level', label: 'Рівень', type: 'number', required: true }
    ]
  },
  {
    name: 'Lecturer', label: 'Викладачі', single: 'lecturer', namespace: 'lecturers', list: 'lecturerConnection', filterParam: 'departmentId', detailRoute: 'lecturer',
    fields: [
      { name: 'firstName', label: "Ім'я", type: 'text', required: true },
      { name: 'middleName', label: 'По батькові', type: 'text' },
      { name: 'lastName', label: 'Прізвище', type: 'text', required: true },
      { name: 'email', label: 'Ел. пошта', type: 'text' },
      { name: 'position', label: 'Посада', type: 'enum', enumOptions: POSITION_OPTIONS },
      ref('academicDegreeId', 'Наук. ступінь', 'academicDegree', 'academicDegree', 'name'),
      { name: 'departmentId', label: 'Кафедра', type: 'ref', ref: 'department', relation: 'department', refLabel: 'name', required: true,
        parentFilter: { namespace: 'faculties', list: 'facultyConnection', label: 'Факультет' } }
    ]
  },
  {
    name: 'Student', label: 'Студенти', single: 'student', namespace: 'students', list: 'studentConnection', filterParam: 'academicGroupId',
    fields: [
      // Surname first, matching how students are listed on paper (and how studentConnection
      // already sorts them). Field order here drives both the table columns and the form.
      { name: 'lastName', label: 'Прізвище', type: 'text', required: true },
      { name: 'firstName', label: "Ім'я", type: 'text', required: true },
      { name: 'middleName', label: 'По батькові', type: 'text' },
      { name: 'email', label: 'Ел. пошта', type: 'text' },
      { name: 'recordBookNumber', label: '№ залік. книжки', type: 'text' },
      ref('academicGroupId', 'Академічна група', 'academicGroup', 'academicGroup', 'name', true)
    ]
  },
  {
    name: 'AcademicGroup', label: 'Академічні групи', single: 'academicGroup', namespace: 'academicGroups', list: 'academicGroupConnection', filterParam: 'specialtyId', detailRoute: 'academic-group',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'courseYear', label: 'Курс', type: 'number', required: true },
      { name: 'studyForm', label: 'Форма навчання', type: 'enum', required: true, enumOptions: STUDY_FORM_OPTIONS },
      { name: 'studentsCount', label: 'Студентів', type: 'number' },
      ref('specialtyId', 'Спеціальність', 'specialty', 'specialty', 'name', true)
    ]
  },
  {
    name: 'CombinedGroup', label: "Об'єднані групи", single: 'combinedGroup', namespace: 'combinedGroups', list: 'combinedGroupConnection',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'purpose', label: 'Призначення', type: 'text' }
    ]
  },
  {
    name: 'Room', label: 'Аудиторії', single: 'room', namespace: 'rooms', list: 'roomConnection', filterParam: 'facultyId', detailRoute: 'room',
    fields: [
      { name: 'number', label: 'Номер', type: 'text', required: true },
      { name: 'name', label: 'Назва', type: 'text' },
      { name: 'capacity', label: 'Місткість', type: 'number' },
      { name: 'kind', label: 'Тип', type: 'enum', enumOptions: ROOM_KIND_OPTIONS },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name'),
      ref('buildingId', 'Корпус', 'building', 'building', 'name')
    ]
  },
  {
    // A reusable set of rooms a lecturer workload can point at instead of naming rooms one by one.
    // faculty and department scope who may use the group and are mutually exclusive — the database
    // rejects a row that sets both (room_groups_scope_check), so a form that does fails on save.
    name: 'RoomGroup', label: 'Групи аудиторій', single: 'roomGroup', namespace: 'roomGroups', list: 'roomGroupConnection', filterParam: 'facultyId',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'purpose', label: 'Призначення', type: 'text' },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name'),
      { name: 'departmentId', label: 'Кафедра', type: 'ref', ref: 'department', relation: 'department', refLabel: 'name',
        parentFilter: { namespace: 'faculties', list: 'facultyConnection', label: 'Факультет' } },
      multiref('roomIds', 'Аудиторії', 'room', 'rooms', 'number')
    ]
  },
  {
    // A named grid of bells. Exactly one set is the default (the one a new workload starts on), and
    // a set scoped to a faculty may never be the default — both rules are enforced by the database
    // (class_start_time_sets_single_default / class_start_time_sets_default_scope_check), so a form
    // that breaks them fails on save rather than being prevented here.
    name: 'ClassStartTimeSet', label: 'Набори часів початку занять', single: 'classStartTimeSet', namespace: 'classStartTimeSets', list: 'classStartTimeSetConnection', filterParam: 'facultyId',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'isDefault', label: 'Типовий', type: 'boolean' },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name')
    ]
  },
  {
    name: 'ClassStartTime', label: 'Часи початку занять', single: 'classStartTime', namespace: 'classStartTimes', list: 'classStartTimeConnection', filterParam: 'classStartTimeSetId',
    fields: [
      ref('classStartTimeSetId', 'Набір', 'classStartTimeSet', 'classStartTimeSet', 'name', true),
      { name: 'ordinal', label: 'Порядковий №', type: 'number', required: true },
      time('startTime', 'Початок', true)
    ]
  },
  {
    name: 'TimetableEntry', label: 'Записи розкладу', single: 'timetableEntry', namespace: 'timetableEntries', list: 'timetableEntryConnection',
    fields: [
      { name: 'dayOfWeek', label: 'День (1-6)', type: 'number', required: true },
      { name: 'weekParity', label: 'Тиждень', type: 'enum', required: true, enumOptions: WEEK_PARITY_OPTIONS },
      ref('workloadId', 'Навантаження', 'workload', 'workload', 'id', true),
      ref('classStartTimeId', 'Час початку', 'classStartTime', 'classStartTime', 'startTime', true),
      ref('roomId', 'Аудиторія', 'room', 'room', 'number', true)
    ]
  }
];

export const entityBySingle = (key: string): EntityMeta | undefined =>
  ENTITIES.find((e) => e.single === key);
