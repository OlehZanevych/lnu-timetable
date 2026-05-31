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
}

const ref = (name: string, label: string, ref: string, relation: string, refLabel: string, required = false): FieldMeta =>
  ({ name, label, type: 'ref', ref, relation, refLabel, required });

export const ENTITIES: EntityMeta[] = [
  {
    name: 'Faculty', label: 'Faculties', single: 'faculty', namespace: 'faculties', list: 'facultyConnection',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'abbreviation', label: 'Abbreviation', type: 'text' },
      { name: 'website', label: 'Website', type: 'text' },
      { name: 'email', label: 'Email', type: 'text' },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'address', label: 'Address', type: 'text' },
      { name: 'info', label: 'Info', type: 'textarea' }
    ]
  },
  {
    name: 'Department', label: 'Departments', single: 'department', namespace: 'departments', list: 'departmentConnection',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'abbreviation', label: 'Abbreviation', type: 'text' },
      { name: 'email', label: 'Email', type: 'text' },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'info', label: 'Info', type: 'textarea' },
      ref('facultyId', 'Faculty', 'faculty', 'faculty', 'name', true)
    ]
  },
  {
    name: 'Specialty', label: 'Specialties', single: 'specialty', namespace: 'specialties', list: 'specialtyConnection',
    fields: [
      { name: 'code', label: 'Code', type: 'text', required: true },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'degree', label: 'Degree', type: 'text', required: true },
      { name: 'qualification', label: 'Qualification', type: 'text' },
      ref('facultyId', 'Faculty', 'faculty', 'faculty', 'name', true)
    ]
  },
  {
    name: 'Course', label: 'Courses', single: 'course', namespace: 'courses', list: 'courseConnection',
    fields: [
      { name: 'code', label: 'Code', type: 'text' },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'ectsCredits', label: 'ECTS', type: 'number' },
      ref('departmentId', 'Department', 'department', 'department', 'name', true)
    ]
  },
  {
    name: 'Curriculum', label: 'Curricula', single: 'curriculum', namespace: 'curriculums', list: 'curriculumConnection',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'admissionYear', label: 'Admission year', type: 'number', required: true },
      { name: 'degree', label: 'Degree', type: 'text', required: true },
      ref('specialtyId', 'Specialty', 'specialty', 'specialty', 'name', true)
    ]
  },
  {
    name: 'CurriculumItem', label: 'Curriculum items', single: 'curriculumItem', namespace: 'curriculumItems', list: 'curriculumItemConnection',
    fields: [
      { name: 'semester', label: 'Semester', type: 'number', required: true },
      { name: 'controlForm', label: 'Control form', type: 'text', required: true },
      { name: 'ectsCredits', label: 'ECTS', type: 'number' },
      ref('curriculumId', 'Curriculum', 'curriculum', 'curriculum', 'name', true),
      ref('courseId', 'Course', 'course', 'course', 'name', true)
    ]
  },
  {
    name: 'WorkingCurriculum', label: 'Working curricula', single: 'workingCurriculum', namespace: 'workingCurriculums', list: 'workingCurriculumConnection',
    fields: [
      { name: 'academicYear', label: 'Academic year', type: 'text', required: true },
      { name: 'semester', label: 'Semester', type: 'number', required: true },
      ref('curriculumId', 'Curriculum', 'curriculum', 'curriculum', 'name', true)
    ]
  },
  {
    name: 'WorkingCurriculumItem', label: 'Working curriculum items', single: 'workingCurriculumItem', namespace: 'workingCurriculumItems', list: 'workingCurriculumItemConnection',
    fields: [
      { name: 'lectureHours', label: 'Lecture h', type: 'number' },
      { name: 'practicalHours', label: 'Practical h', type: 'number' },
      { name: 'labHours', label: 'Lab h', type: 'number' },
      { name: 'seminarHours', label: 'Seminar h', type: 'number' },
      ref('workingCurriculumId', 'Working curriculum', 'workingCurriculum', 'workingCurriculum', 'academicYear', true),
      ref('courseId', 'Course', 'course', 'course', 'name', true)
    ]
  },
  {
    name: 'Lecturer', label: 'Lecturers', single: 'lecturer', namespace: 'lecturers', list: 'lecturerConnection',
    fields: [
      { name: 'firstName', label: 'First name', type: 'text', required: true },
      { name: 'lastName', label: 'Last name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'text' },
      { name: 'position', label: 'Position', type: 'text' },
      { name: 'academicDegree', label: 'Degree', type: 'text' },
      { name: 'maxHoursPerWeek', label: 'Max h/week', type: 'number' },
      ref('departmentId', 'Department', 'department', 'department', 'name', true)
    ]
  },
  {
    name: 'LecturerWorkload', label: 'Workloads', single: 'lecturerWorkload', namespace: 'lecturerWorkloads', list: 'lecturerWorkloadConnection',
    fields: [
      { name: 'classType', label: 'Class type', type: 'text', required: true },
      { name: 'periodicity', label: 'Periodicity', type: 'text', required: true },
      { name: 'hoursPerWeek', label: 'h/week', type: 'number' },
      ref('lecturerId', 'Lecturer', 'lecturer', 'lecturer', 'lastName', true),
      ref('courseId', 'Course', 'course', 'course', 'name', true),
      ref('academicGroupId', 'Academic group', 'academicGroup', 'academicGroup', 'name'),
      ref('combinedGroupId', 'Combined group', 'combinedGroup', 'combinedGroup', 'name'),
      ref('workingCurriculumId', 'Working curriculum', 'workingCurriculum', 'workingCurriculum', 'academicYear')
    ]
  },
  {
    name: 'Student', label: 'Students', single: 'student', namespace: 'students', list: 'studentConnection',
    fields: [
      { name: 'firstName', label: 'First name', type: 'text', required: true },
      { name: 'lastName', label: 'Last name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'text' },
      { name: 'recordBookNumber', label: 'Record book #', type: 'text' },
      ref('academicGroupId', 'Academic group', 'academicGroup', 'academicGroup', 'name', true)
    ]
  },
  {
    name: 'AcademicGroup', label: 'Academic groups', single: 'academicGroup', namespace: 'academicGroups', list: 'academicGroupConnection',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'courseYear', label: 'Year', type: 'number', required: true },
      { name: 'studyForm', label: 'Study form', type: 'text', required: true },
      { name: 'studentsCount', label: 'Students', type: 'number' },
      ref('specialtyId', 'Specialty', 'specialty', 'specialty', 'name', true)
    ]
  },
  {
    name: 'CombinedGroup', label: 'Combined groups', single: 'combinedGroup', namespace: 'combinedGroups', list: 'combinedGroupConnection',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'purpose', label: 'Purpose', type: 'text' }
    ]
  },
  {
    name: 'Room', label: 'Rooms', single: 'room', namespace: 'rooms', list: 'roomConnection',
    fields: [
      { name: 'number', label: 'Number', type: 'text', required: true },
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'building', label: 'Building', type: 'text' },
      { name: 'capacity', label: 'Capacity', type: 'number' },
      { name: 'kind', label: 'Kind', type: 'text' },
      ref('facultyId', 'Faculty', 'faculty', 'faculty', 'name')
    ]
  },
  {
    name: 'TimeSlot', label: 'Time slots', single: 'timeSlot', namespace: 'timeSlots', list: 'timeSlotConnection',
    fields: [
      { name: 'ordinal', label: 'Ordinal', type: 'number', required: true },
      { name: 'startTime', label: 'Start', type: 'text', required: true },
      { name: 'endTime', label: 'End', type: 'text', required: true }
    ]
  },
  {
    name: 'TimetableEntry', label: 'Timetable entries', single: 'timetableEntry', namespace: 'timetableEntries', list: 'timetableEntryConnection',
    fields: [
      { name: 'dayOfWeek', label: 'Day (1-6)', type: 'number', required: true },
      { name: 'weekParity', label: 'Week parity', type: 'text', required: true },
      ref('workloadId', 'Workload', 'workload', 'workload', 'classType', true),
      ref('timeSlotId', 'Time slot', 'timeSlot', 'timeSlot', 'startTime', true),
      ref('roomId', 'Room', 'room', 'room', 'number', true)
    ]
  }
];

export const entityBySingle = (key: string): EntityMeta | undefined =>
  ENTITIES.find((e) => e.single === key);
