/** Client-side metadata mirroring the backend's config-driven GraphQL schema. */

export interface FieldMeta {
  name: string;            // scalar field name, or FK input field (e.g. "facultyId") for refs
  label: string;
  type: 'text' | 'number' | 'textarea' | 'ref' | 'enum';
  required?: boolean;
  // enum-only:
  enumOptions?: { value: string; label: string }[];
  // ref-only:
  ref?: string;            // referenced entity key (single name), used to load options
  relation?: string;       // relation field name in GraphQL (e.g. "faculty")
  refLabel?: string;       // scalar field on the referenced entity used as a label
  // optional parent filter (e.g. filter departments by faculty when selecting for lecturer)
  parentFilter?: { namespace: string; list: string; label: string };
}

export interface EntityMeta {
  name: string;            // GraphQL type name, e.g. "Faculty"
  label: string;           // menu label
  single: string;          // query field + create/update arg name, e.g. "faculty"
  namespace: string;       // grouping field, e.g. "faculties"
  list: string;            // connection query field, e.g. "facultyConnection"
  fields: FieldMeta[];
  filterParam?: string;    // GraphQL arg name for optional scoping (e.g. "facultyId", "departmentId")
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

const COURSE_TYPE_OPTIONS = [
  { value: 'MANDATORY',          label: "Обов'язкова" },
  { value: 'ELECTIVE_GROUP',     label: 'Група вибіркових' },
  { value: 'ELECTIVE',           label: 'Вибіркова' },
  { value: 'OPTIONAL',           label: 'Факультатив' },
  { value: 'INTERNSHIP',         label: 'Практика' },
  { value: 'COURSE_PROJECT',     label: 'Курсовий проєкт' },
  { value: 'COURSE_WORK',        label: 'Курсова робота' },
  { value: 'QUALIFICATION_WORK', label: 'Кваліфікаційна робота' }
];

export const CONTROL_FORM_OPTIONS = [
  { value: 'EXAM',          label: 'Екзамен' },
  { value: 'CREDIT',        label: 'Залік' },
  { value: 'GRADED_CREDIT', label: 'Диф. залік' }
];

export const HOUR_TYPE_OPTIONS = [
  { value: 'LECTURE',          label: 'Лекції' },
  { value: 'PRACTICAL',        label: 'Практичні' },
  { value: 'LAB',              label: 'Лабораторні' },
  { value: 'INDEPENDENT_WORK', label: 'Самостійна робота' }
];

export const TEACHING_FORMAT_OPTIONS = [
  { value: 'TOGETHER',   label: 'Разом' },
  { value: 'SEPARATELY', label: 'Окремо' }
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
    name: 'Building', label: 'Корпуси', single: 'building', namespace: 'buildings', list: 'buildingConnection',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'address', label: 'Адреса', type: 'text' },
      { name: 'city', label: 'Місто', type: 'text' },
      { name: 'postalCode', label: 'Поштовий індекс', type: 'text' }
    ]
  },
  {
    name: 'Faculty', label: 'Факультети', single: 'faculty', namespace: 'faculties', list: 'facultyConnection',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'abbreviation', label: 'Абревіатура', type: 'text' },
      { name: 'website', label: 'Веб-сайт', type: 'text' },
      { name: 'email', label: 'Ел. пошта', type: 'text' },
      { name: 'phone', label: 'Телефон', type: 'text' },
      { name: 'info', label: 'Інформація', type: 'textarea' },
      ref('buildingId', 'Корпус', 'building', 'building', 'name')
    ]
  },
  {
    name: 'Department', label: 'Кафедри', single: 'department', namespace: 'departments', list: 'departmentConnection', filterParam: 'facultyId',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'abbreviation', label: 'Абревіатура', type: 'text' },
      { name: 'email', label: 'Ел. пошта', type: 'text' },
      { name: 'phone', label: 'Телефон', type: 'text' },
      { name: 'info', label: 'Інформація', type: 'textarea' },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name', true)
    ]
  },
  {
    name: 'Specialty', label: 'Спеціальності', single: 'specialty', namespace: 'specialties', list: 'specialtyConnection', filterParam: 'facultyId',
    fields: [
      { name: 'code', label: 'Код', type: 'text', required: true },
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'degree', label: 'Ступінь', type: 'enum', required: true, enumOptions: DEGREE_OPTIONS },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name', true)
    ]
  },
  {
    name: 'Course', label: 'Дисципліни', single: 'course', namespace: 'courses', list: 'courseConnection', filterParam: 'departmentId',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'courseType', label: 'Тип', type: 'enum', required: true, enumOptions: COURSE_TYPE_OPTIONS },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name'),
      ref('departmentId', 'Кафедра', 'department', 'department', 'name'),
      ref('parentCourseId', 'Група вибіркових', 'course', 'parentCourse', 'name')
    ]
  },
  {
    name: 'CurriculumItem', label: 'Позиції навч. плану', single: 'curriculumItem', namespace: 'curriculumItems', list: 'curriculumItemConnection', filterParam: 'specialtyId',
    fields: [
      { name: 'semester', label: 'Семестр', type: 'number', required: true },
      { name: 'controlForm', label: 'Форма контролю', type: 'enum', required: true, enumOptions: CONTROL_FORM_OPTIONS },
      { name: 'ectsCredits', label: 'ECTS', type: 'number' },
      ref('specialtyId', 'Спеціальність', 'specialty', 'specialty', 'name', true),
      ref('courseId', 'Дисципліна', 'course', 'course', 'name', true)
    ]
  },
  {
    name: 'CurriculumItemHours', label: 'Год. позиції навч. плану', single: 'curriculumItemHours', namespace: 'curriculumItemHourss', list: 'curriculumItemHoursConnection', filterParam: 'curriculumItemId',
    fields: [
      { name: 'hourType', label: 'Тип годин', type: 'enum', required: true, enumOptions: HOUR_TYPE_OPTIONS },
      { name: 'hours', label: 'Годин', type: 'number', required: true },
      ref('curriculumItemId', 'Позиція навч. плану', 'curriculumItem', 'curriculumItem', 'semester', true)
    ]
  },
  {
    name: 'WorkingCurriculumItem', label: 'Позиції РНП', single: 'workingCurriculumItem', namespace: 'workingCurriculumItems', list: 'workingCurriculumItemConnection', filterParam: 'departmentId',
    fields: [
      { name: 'lecturerCount', label: 'К-сть викладачів', type: 'number', required: true },
      { name: 'teachingFormat', label: 'Формат викладання', type: 'enum', required: true, enumOptions: TEACHING_FORMAT_OPTIONS },
      ref('curriculumItemHoursId', 'Год. позиції', 'curriculumItemHours', 'curriculumItemHours', 'hourType', true),
      ref('departmentId', 'Кафедра', 'department', 'department', 'name', true),
      ref('courseId', 'Вибіркова дисципліна', 'course', 'course', 'name')
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
    name: 'Lecturer', label: 'Викладачі', single: 'lecturer', namespace: 'lecturers', list: 'lecturerConnection', filterParam: 'departmentId',
    fields: [
      { name: 'firstName', label: "Ім'я", type: 'text', required: true },
      { name: 'middleName', label: 'По батькові', type: 'text' },
      { name: 'lastName', label: 'Прізвище', type: 'text', required: true },
      { name: 'email', label: 'Ел. пошта', type: 'text' },
      { name: 'position', label: 'Посада', type: 'enum',
        enumOptions: [
          { value: 'ASSISTANT',          label: 'Асистент' },
          { value: 'TEACHER',            label: 'Викладач' },
          { value: 'SENIOR_LECTURER',    label: 'Старший викладач' },
          { value: 'DOCENT',             label: 'Доцент' },
          { value: 'PROFESSOR',          label: 'Професор' },
          { value: 'HEAD_OF_DEPARTMENT', label: 'Завідувач кафедри' }
        ]
      },
      ref('academicDegreeId', 'Наук. ступінь', 'academicDegree', 'academicDegree', 'name'),
      { name: 'maxHoursPerWeek', label: 'Макс. год./тижд.', type: 'number' },
      { name: 'departmentId', label: 'Кафедра', type: 'ref', ref: 'department', relation: 'department', refLabel: 'name', required: true,
        parentFilter: { namespace: 'faculties', list: 'facultyConnection', label: 'Факультет' } }
    ]
  },
  {
    name: 'LecturerWorkload', label: 'Навантаження', single: 'lecturerWorkload', namespace: 'lecturerWorkloads', list: 'lecturerWorkloadConnection',
    fields: [
      ref('workingCurriculumItemId', 'Позиція РНП', 'workingCurriculumItem', 'workingCurriculumItem', 'teachingFormat', true),
      { name: 'durationHours', label: 'Тривалість заняття (акад. год.)', type: 'number', required: true }
      // Викладачі / Академічні групи / Об'єднані групи are many-to-many now (lecturerIds/
      // academicGroupIds/combinedGroupIds) and are managed on the department's "Навантаження
      // викладачів" subpage instead — the generic single-select ref field here can't represent
      // a multi-valued relation.
    ]
  },
  {
    name: 'Student', label: 'Студенти', single: 'student', namespace: 'students', list: 'studentConnection', filterParam: 'academicGroupId',
    fields: [
      { name: 'firstName', label: "Ім'я", type: 'text', required: true },
      { name: 'lastName', label: 'Прізвище', type: 'text', required: true },
      { name: 'email', label: 'Ел. пошта', type: 'text' },
      { name: 'recordBookNumber', label: '№ залік. книжки', type: 'text' },
      ref('academicGroupId', 'Академічна група', 'academicGroup', 'academicGroup', 'name', true)
    ]
  },
  {
    name: 'AcademicGroup', label: 'Академічні групи', single: 'academicGroup', namespace: 'academicGroups', list: 'academicGroupConnection', filterParam: 'specialtyId',
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
    name: 'Room', label: 'Аудиторії', single: 'room', namespace: 'rooms', list: 'roomConnection', filterParam: 'facultyId',
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
    name: 'ClassStartTime', label: 'Часи початку занять', single: 'classStartTime', namespace: 'classStartTimes', list: 'classStartTimeConnection',
    fields: [
      { name: 'ordinal', label: 'Порядковий №', type: 'number', required: true },
      { name: 'startTime', label: 'Початок', type: 'text', required: true }
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
