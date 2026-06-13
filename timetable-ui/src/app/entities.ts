/** Client-side metadata mirroring the backend's config-driven GraphQL schema. */

export interface FieldMeta {
  name: string;            // scalar field name, or FK input field (e.g. "facultyId") for refs
  label: string;
  type: 'text' | 'number' | 'textarea' | 'ref';
  required?: boolean;
  // ref-only:
  ref?: string;            // referenced entity key (single name), used to load options
  relation?: string;       // relation field name in GraphQL (e.g. "faculty")
  refLabel?: string;       // scalar field on the referenced entity used as a label
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
      { name: 'degree', label: 'Ступінь', type: 'text', required: true },
      { name: 'qualification', label: 'Кваліфікація', type: 'text' },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name', true)
    ]
  },
  {
    name: 'Course', label: 'Дисципліни', single: 'course', namespace: 'courses', list: 'courseConnection', filterParam: 'departmentId',
    fields: [
      { name: 'code', label: 'Код', type: 'text' },
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'ectsCredits', label: 'ECTS', type: 'number' },
      ref('departmentId', 'Кафедра', 'department', 'department', 'name', true)
    ]
  },
  {
    name: 'Curriculum', label: 'Навчальні плани', single: 'curriculum', namespace: 'curriculums', list: 'curriculumConnection', filterParam: 'specialtyId',
    fields: [
      { name: 'name', label: 'Назва', type: 'text', required: true },
      { name: 'admissionYear', label: 'Рік вступу', type: 'number', required: true },
      { name: 'degree', label: 'Ступінь', type: 'text', required: true },
      ref('specialtyId', 'Спеціальність', 'specialty', 'specialty', 'name', true)
    ]
  },
  {
    name: 'CurriculumItem', label: 'Позиції навч. плану', single: 'curriculumItem', namespace: 'curriculumItems', list: 'curriculumItemConnection', filterParam: 'curriculumId',
    fields: [
      { name: 'semester', label: 'Семестр', type: 'number', required: true },
      { name: 'controlForm', label: 'Форма контролю', type: 'text', required: true },
      { name: 'ectsCredits', label: 'ECTS', type: 'number' },
      ref('curriculumId', 'Навчальний план', 'curriculum', 'curriculum', 'name', true),
      ref('courseId', 'Дисципліна', 'course', 'course', 'name', true)
    ]
  },
  {
    name: 'WorkingCurriculum', label: 'Робочі навч. плани', single: 'workingCurriculum', namespace: 'workingCurriculums', list: 'workingCurriculumConnection', filterParam: 'curriculumId',
    fields: [
      { name: 'academicYear', label: 'Навчальний рік', type: 'text', required: true },
      { name: 'semester', label: 'Семестр', type: 'number', required: true },
      ref('curriculumId', 'Навчальний план', 'curriculum', 'curriculum', 'name', true)
    ]
  },
  {
    name: 'WorkingCurriculumItem', label: 'Позиції РНП', single: 'workingCurriculumItem', namespace: 'workingCurriculumItems', list: 'workingCurriculumItemConnection', filterParam: 'workingCurriculumId',
    fields: [
      { name: 'lectureHours', label: 'Год. лекцій', type: 'number' },
      { name: 'practicalHours', label: 'Год. практ.', type: 'number' },
      { name: 'labHours', label: 'Год. лаб.', type: 'number' },
      { name: 'seminarHours', label: 'Год. сем.', type: 'number' },
      ref('workingCurriculumId', 'Робочий навч. план', 'workingCurriculum', 'workingCurriculum', 'academicYear', true),
      ref('courseId', 'Дисципліна', 'course', 'course', 'name', true)
    ]
  },
  {
    name: 'Lecturer', label: 'Викладачі', single: 'lecturer', namespace: 'lecturers', list: 'lecturerConnection', filterParam: 'departmentId',
    fields: [
      { name: 'firstName', label: "Ім'я", type: 'text', required: true },
      { name: 'lastName', label: 'Прізвище', type: 'text', required: true },
      { name: 'email', label: 'Ел. пошта', type: 'text' },
      { name: 'position', label: 'Посада', type: 'text' },
      { name: 'academicDegree', label: 'Ступінь', type: 'text' },
      { name: 'maxHoursPerWeek', label: 'Макс. год./тижд.', type: 'number' },
      ref('departmentId', 'Кафедра', 'department', 'department', 'name', true)
    ]
  },
  {
    name: 'LecturerWorkload', label: 'Навантаження', single: 'lecturerWorkload', namespace: 'lecturerWorkloads', list: 'lecturerWorkloadConnection', filterParam: 'lecturerId',
    fields: [
      { name: 'classType', label: 'Тип заняття', type: 'text', required: true },
      { name: 'periodicity', label: 'Periodicity', type: 'text', required: true },
      { name: 'hoursPerWeek', label: 'Год./тижд.', type: 'number' },
      ref('lecturerId', 'Викладач', 'lecturer', 'lecturer', 'lastName', true),
      ref('courseId', 'Дисципліна', 'course', 'course', 'name', true),
      ref('academicGroupId', 'Академічна група', 'academicGroup', 'academicGroup', 'name'),
      ref('combinedGroupId', "Об'єднана група", 'combinedGroup', 'combinedGroup', 'name'),
      ref('workingCurriculumId', 'Робочий навч. план', 'workingCurriculum', 'workingCurriculum', 'academicYear')
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
      { name: 'studyForm', label: 'Форма навчання', type: 'text', required: true },
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
      { name: 'kind', label: 'Тип', type: 'text' },
      ref('facultyId', 'Факультет', 'faculty', 'faculty', 'name'),
      ref('buildingId', 'Корпус', 'building', 'building', 'name')
    ]
  },
  {
    name: 'TimeSlot', label: 'Часові слоти', single: 'timeSlot', namespace: 'timeSlots', list: 'timeSlotConnection',
    fields: [
      { name: 'ordinal', label: 'Порядковий №', type: 'number', required: true },
      { name: 'startTime', label: 'Початок', type: 'text', required: true },
      { name: 'endTime', label: 'Кінець', type: 'text', required: true }
    ]
  },
  {
    name: 'TimetableEntry', label: 'Записи розкладу', single: 'timetableEntry', namespace: 'timetableEntries', list: 'timetableEntryConnection',
    fields: [
      { name: 'dayOfWeek', label: 'День (1-6)', type: 'number', required: true },
      { name: 'weekParity', label: 'Тиждень', type: 'text', required: true },
      ref('workloadId', 'Навантаження', 'workload', 'workload', 'classType', true),
      ref('timeSlotId', 'Часовий слот', 'timeSlot', 'timeSlot', 'startTime', true),
      ref('roomId', 'Аудиторія', 'room', 'room', 'number', true)
    ]
  }
];

export const entityBySingle = (key: string): EntityMeta | undefined =>
  ENTITIES.find((e) => e.single === key);
