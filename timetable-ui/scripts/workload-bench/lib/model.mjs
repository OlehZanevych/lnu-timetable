/**
 * The shape of a Ukrainian department's teaching year, as parameters.
 *
 * Every number here is a modelling decision, and each is stated once so that it can be argued with
 * rather than discovered by reading generator code. The justification for each is in
 * `scripts/workload-bench/README.md` §2; the short version is that the load figures come from the
 * statutory ceiling (ст. 56 Закону України «Про вищу освіту» — 600 academic hours per full post per
 * year) and the structural figures from the shape of the real ЛНУ data imported into `data.sql`.
 */

/** ст. 56: the annual ceiling per full post. Used as `defaultMaxHoursPerYear`. */
export const STATUTORY_MAX_HOURS_PER_YEAR = 600;

/**
 * Academic-staff positions, in the proportions a Ukrainian department actually has them. Ratios
 * follow the ЛНУ establishment: a department is mostly доценти, with a couple of професори and a
 * tail of assistants.
 */
export const POSITIONS = {
  PROFESSOR: 0.10,
  DOCENT: 0.44,
  SENIOR_LECTURER: 0.20,
  LECTURER: 0.16,
  ASSISTANT: 0.10
};

/**
 * What each position is realistically asked to do. `lectureAffinity` is the probability that this
 * lecturer is considered a candidate for a *lecture* position at all — in Ukrainian practice
 * lectures are read by професори and доценти, and assistants run practicals and labs. This is the
 * single most important structural constraint in the problem, because it is what makes lecture
 * slots scarce while practical slots are plentiful.
 */
export const POSITION_PROFILE = {
  PROFESSOR:        { lectureAffinity: 1.00, practicalAffinity: 0.35, labAffinity: 0.20, maxHours: 550, desirabilityBonus: 18 },
  DOCENT:           { lectureAffinity: 0.85, practicalAffinity: 0.75, labAffinity: 0.55, maxHours: 600, desirabilityBonus: 10 },
  SENIOR_LECTURER:  { lectureAffinity: 0.35, practicalAffinity: 0.95, labAffinity: 0.85, maxHours: 600, desirabilityBonus: 2 },
  LECTURER:         { lectureAffinity: 0.10, practicalAffinity: 1.00, labAffinity: 0.95, maxHours: 600, desirabilityBonus: 0 },
  ASSISTANT:        { lectureAffinity: 0.02, practicalAffinity: 0.95, labAffinity: 1.00, maxHours: 600, desirabilityBonus: -5 }
};

/**
 * `courses.course_type`, in the mix a curriculum has them. Only MANDATORY and ELECTIVE/
 * ELECTIVE_GROUP carry distinct-course constraints in the generator; the other four are included
 * precisely because they must *not* — a dataset made only of mandatory courses would never exercise
 * the branch that ignores them.
 */
export const COURSE_TYPES = {
  MANDATORY: 0.60,
  ELECTIVE: 0.18,
  ELECTIVE_GROUP: 0.06,
  COURSE_WORK: 0.06,
  INTERNSHIP: 0.04,
  OPTIONAL: 0.04,
  ATTESTATION: 0.02
};

/**
 * How many academic groups take a given course. Mean ≈ 3.0. This is the multiplier that turns a
 * 32-hour practical into three delivery positions, and it is the main reason a department of twenty
 * people has hundreds of positions rather than dozens.
 */
export const GROUPS_PER_COURSE = { 1: 0.15, 2: 0.25, 3: 0.25, 4: 0.18, 5: 0.10, 6: 0.07 };

/**
 * Hour types a course carries, with the academic hours of each. `p` is the probability the course
 * has that row at all; not every discipline has labs, and consultations and assessments are often
 * folded into other rows in practice.
 *
 * `perGroup` says whether the row produces one position per academic group (SEPARATELY) or a single
 * position covering all of them (TOGETHER) — the distinction the generator reads off
 * `teachingFormat`.
 */
export const HOUR_ROWS = [
  { hourType: 'LECTURE',      p: 0.90, lo: 16, hi: 48, mode: 32, perGroup: false, format: 'TOGETHER' },
  { hourType: 'PRACTICAL',    p: 0.85, lo: 16, hi: 48, mode: 32, perGroup: true,  format: 'SEPARATELY' },
  { hourType: 'LAB',          p: 0.55, lo: 16, hi: 32, mode: 24, perGroup: true,  format: 'SEPARATELY' },
  { hourType: 'CONSULTATION', p: 0.60, lo: 2,  hi: 10, mode: 4,  perGroup: false, format: 'TOGETHER' },
  { hourType: 'ASSESSMENT',   p: 0.50, lo: 2,  hi: 6,  mode: 4,  perGroup: false, format: 'TOGETHER' }
];

/** Students per academic group. Ukrainian groups run 15–30; електив groups are smaller. */
export const GROUP_SIZE = { lo: 12, hi: 30, mode: 22 };

/** Probability a LAB position needs two lecturers (parallel subgroups) rather than one. */
export const TWO_LECTURER_LAB = 0.22;

/**
 * Every constraint type the schema defines. The dataset generator guarantees that each of these
 * appears at least once somewhere in the matrix, because an algorithm study that never exercises
 * `MAX_ELECTIVE_LAB_COURSES` has not measured the code that handles it.
 */
export const ALL_CONSTRAINT_TYPES = [
  'MIN_HOURS_PER_YEAR', 'MAX_HOURS_PER_YEAR',
  'MAX_COURSES',
  'MIN_LECTURE_COURSES', 'MAX_LECTURE_COURSES',
  'MIN_PRACTICAL_COURSES', 'MAX_PRACTICAL_COURSES',
  'MIN_LAB_COURSES', 'MAX_LAB_COURSES',
  'MIN_MANDATORY_LECTURE_COURSES', 'MAX_MANDATORY_LECTURE_COURSES',
  'MIN_MANDATORY_PRACTICAL_COURSES', 'MAX_MANDATORY_PRACTICAL_COURSES',
  'MIN_MANDATORY_LAB_COURSES', 'MAX_MANDATORY_LAB_COURSES',
  'MIN_ELECTIVE_LECTURE_COURSES', 'MAX_ELECTIVE_LECTURE_COURSES',
  'MIN_ELECTIVE_PRACTICAL_COURSES', 'MAX_ELECTIVE_PRACTICAL_COURSES',
  'MIN_ELECTIVE_LAB_COURSES', 'MAX_ELECTIVE_LAB_COURSES'
];

/** The two candidate-level constraints, which only INDIVIDUALLY positions read. */
export const CANDIDATE_CONSTRAINT_TYPES = ['MIN_STUDENTS', 'MAX_STUDENTS'];

/** Ukrainian discipline names, cycled with a suffix so labels look like a real curriculum. */
export const COURSE_STEMS = [
  'Алгоритми та структури даних', 'Дискретна математика', 'Математичний аналіз',
  'Лінійна алгебра', 'Теорія ймовірностей', 'Математична статистика',
  'Бази даних', "Комп'ютерні мережі", 'Операційні системи', 'Веб-технології',
  'Штучний інтелект', 'Машинне навчання', 'Методи оптимізації', 'Чисельні методи',
  'Функціональний аналіз', 'Диференціальні рівняння', 'Теорія графів',
  'Криптографія', 'Паралельні обчислення', 'Хмарні технології',
  'Проєктування інформаційних систем', 'Аналіз даних', 'Технології програмування',
  'Системне програмування', 'Комп’ютерна графіка', 'Обчислювальна геометрія',
  'Моделювання складних систем', 'Теорія керування', 'Дослідження операцій',
  'Основи кібербезпеки', 'Мова програмування Java', 'Мова програмування Python',
  'Розподілені системи', 'Мікросервісна архітектура', 'Тестування програмного забезпечення',
  'Управління ІТ-проєктами', 'Обробка природної мови', 'Комп’ютерний зір',
  'Big Data та аналітика', 'Блокчейн-технології'
];

export const SPECIALTY_NAMES = [
  '113 Прикладна математика', '121 Інженерія програмного забезпечення',
  '122 Комп’ютерні науки', '124 Системний аналіз', '125 Кібербезпека',
  '014.09 Середня освіта (Інформатика)', '111 Математика', '126 Інформаційні системи та технології',
  '105 Прикладна фізика', '051 Економіка', '073 Менеджмент', '015 Професійна освіта'
];

export const HOUR_TYPE_UK = {
  LECTURE: 'Лекції', PRACTICAL: 'Практичні', LAB: 'Лабораторні',
  CONSULTATION: 'Консультації', ASSESSMENT: 'Контрольні заходи'
};
