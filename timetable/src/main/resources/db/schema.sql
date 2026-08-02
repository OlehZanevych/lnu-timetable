DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

-- ============================ Collation ============================

-- The database itself is very likely C.UTF-8 (the default on most installs), which sorts text by
-- raw byte value. For Cyrillic that is wrong in a way that is immediately visible: 'І' is U+0406
-- and 'А' is U+0410, so every surname starting with І/Ї/Є sorts *before* А. Declaring the columns
-- people actually read as COLLATE ukrainian fixes ORDER BY everywhere at once, without needing the
-- database to be recreated with a Ukrainian locale and without any application-side sorting hints.
--
-- Requires a Postgres built with ICU (standard from v15 on). If ICU is unavailable, substitute
--     CREATE COLLATION ukrainian (provider = libc, locale = 'uk_UA.utf8');
-- which needs that locale generated on the host.
CREATE COLLATION ukrainian (provider = icu, locale = 'uk-UA');

-- ============================ Global properties ============================

CREATE TYPE property_type AS ENUM ('INTEGER', 'DECIMAL', 'STRING', 'BOOLEAN', 'ENUM');

-- Generic system-wide configuration store (name/type/value triples). `value` is always stored as
-- text; `type` tells consumers how to parse it.
CREATE TABLE global_properties
(
    name  VARCHAR(100) PRIMARY KEY,
    type  property_type NOT NULL,
    value VARCHAR(255)  NOT NULL
);

-- ============================ Infrastructure: Buildings ============================

CREATE TABLE buildings
(
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(120) COLLATE ukrainian NOT NULL UNIQUE,
    address     VARCHAR(160) COLLATE ukrainian,
    city        VARCHAR(64)  COLLATE ukrainian,
    postal_code VARCHAR(10)
);

-- ============================ Organisational structure ============================

CREATE TABLE faculties
(
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(160) COLLATE ukrainian NOT NULL UNIQUE,
    abbreviation VARCHAR(32)  COLLATE ukrainian UNIQUE,
    website      VARCHAR(128),
    email        VARCHAR(64),
    phone        VARCHAR(128),
    building_id  BIGINT REFERENCES buildings (id) ON DELETE SET NULL
);

CREATE TABLE departments
(
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(160) COLLATE ukrainian NOT NULL UNIQUE,
    abbreviation VARCHAR(32)  COLLATE ukrainian UNIQUE,
    faculty_id   BIGINT NOT NULL REFERENCES faculties (id) ON DELETE CASCADE,
    email        VARCHAR(64),
    phone        VARCHAR(64)
);

CREATE TYPE degree AS ENUM ('JUNIOR_BACHELOR', 'BACHELOR', 'MASTER', 'PHD', 'DOCTOR_OF_SCIENCE');

CREATE TABLE specialties
(
    id            BIGSERIAL PRIMARY KEY,
    code          VARCHAR(16)  COLLATE ukrainian NOT NULL,
    name          VARCHAR(160) COLLATE ukrainian NOT NULL,
    degree        degree       NOT NULL,
    faculty_id    BIGINT NOT NULL REFERENCES faculties (id) ON DELETE CASCADE,
    UNIQUE (name, degree)
);

-- ============================ People & groups ============================

CREATE TABLE academic_degrees
(
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(100) COLLATE ukrainian NOT NULL UNIQUE,
    abbreviation VARCHAR(20)  COLLATE ukrainian,
    level        INTEGER      NOT NULL
);

CREATE TYPE lecturer_position AS ENUM ('ASSISTANT', 'TEACHER', 'SENIOR_LECTURER', 'DOCENT', 'PROFESSOR', 'HEAD_OF_DEPARTMENT');

CREATE TABLE lecturers
(
    id                   BIGSERIAL PRIMARY KEY,
    first_name           VARCHAR(64)  COLLATE ukrainian NOT NULL,
    middle_name          VARCHAR(64)  COLLATE ukrainian,
    last_name            VARCHAR(64)  COLLATE ukrainian NOT NULL,
    email                VARCHAR(64) UNIQUE,
    position             lecturer_position,
    academic_degree_id   BIGINT REFERENCES academic_degrees (id) ON DELETE SET NULL,
    department_id        BIGINT NOT NULL REFERENCES departments (id) ON DELETE CASCADE
);

-- Workload restrictions for a lecturer, one row per constraint that is actually set. Replaces the
-- former lecturers.min_hours_per_week / max_hours_per_week pair: the rules a real workload plan has
-- to satisfy are per-year rather than per-week, and most of them bound a *count of distinct
-- courses* rather than hours, so a fixed column per rule would mean two dozen mostly-NULL columns.
--
-- A lecturer with no row for a given constraint is unconstrained by it, except for
-- MAX_HOURS_PER_YEAR, which falls back to the `default_max_hours_per_year` global property.
--
-- Naming: <MIN|MAX>_[MANDATORY|ELECTIVE]_[LECTURE|PRACTICAL|LAB]_COURSES counts *distinct courses*
-- in which the lecturer runs classes of that hour type; MANDATORY/ELECTIVE narrow it to
-- courses.course_type. MAX_COURSES bounds the distinct courses taught across all three taught hour
-- types together. The remaining two are academic-hour totals for the whole academic year.
CREATE TYPE lecturer_workload_constraint_type AS ENUM (
    -- academic hours per academic year, across everything the lecturer teaches
    'MIN_HOURS_PER_YEAR',
    'MAX_HOURS_PER_YEAR',
    -- distinct courses with any taught hour type (LECTURE, PRACTICAL or LAB)
    'MAX_COURSES',
    -- distinct courses, by hour type
    'MIN_LECTURE_COURSES',
    'MAX_LECTURE_COURSES',
    'MIN_PRACTICAL_COURSES',
    'MAX_PRACTICAL_COURSES',
    'MIN_LAB_COURSES',
    'MAX_LAB_COURSES',
    -- distinct mandatory courses, by hour type
    'MIN_MANDATORY_LECTURE_COURSES',
    'MAX_MANDATORY_LECTURE_COURSES',
    'MIN_MANDATORY_PRACTICAL_COURSES',
    'MAX_MANDATORY_PRACTICAL_COURSES',
    'MIN_MANDATORY_LAB_COURSES',
    'MAX_MANDATORY_LAB_COURSES',
    -- distinct elective courses, by hour type
    'MIN_ELECTIVE_LECTURE_COURSES',
    'MAX_ELECTIVE_LECTURE_COURSES',
    'MIN_ELECTIVE_PRACTICAL_COURSES',
    'MAX_ELECTIVE_PRACTICAL_COURSES',
    'MIN_ELECTIVE_LAB_COURSES',
    'MAX_ELECTIVE_LAB_COURSES'
);

CREATE TABLE lecturer_workload_constraints
(
    id              BIGSERIAL PRIMARY KEY,
    lecturer_id     BIGINT NOT NULL REFERENCES lecturers (id) ON DELETE CASCADE,
    constraint_type lecturer_workload_constraint_type NOT NULL,
    value           INTEGER NOT NULL CHECK (value >= 0),
    -- A constraint is set at most once per lecturer; re-setting it updates the existing row.
    UNIQUE (lecturer_id, constraint_type)
);

CREATE TYPE study_form AS ENUM ('FULL_TIME', 'PART_TIME');

CREATE TABLE academic_groups
(
    id             BIGSERIAL PRIMARY KEY,
    name           VARCHAR(32) COLLATE ukrainian NOT NULL UNIQUE,
    course_year    INTEGER     NOT NULL,
    study_form     study_form  NOT NULL,
    students_count INTEGER,
    specialty_id   BIGINT NOT NULL REFERENCES specialties (id) ON DELETE CASCADE
);

CREATE TABLE combined_groups
(
    id      BIGSERIAL PRIMARY KEY,
    name    VARCHAR(64)  COLLATE ukrainian NOT NULL UNIQUE,
    purpose VARCHAR(200) COLLATE ukrainian
);

CREATE TABLE combined_group_academic_groups
(
    combined_group_id BIGINT NOT NULL REFERENCES combined_groups (id) ON DELETE CASCADE,
    academic_group_id BIGINT NOT NULL REFERENCES academic_groups (id) ON DELETE CASCADE,
    PRIMARY KEY (combined_group_id, academic_group_id)
);

CREATE TABLE students
(
    id                 BIGSERIAL PRIMARY KEY,
    first_name         VARCHAR(64) COLLATE ukrainian NOT NULL,
    middle_name        VARCHAR(64) COLLATE ukrainian,
    last_name          VARCHAR(64) COLLATE ukrainian NOT NULL,
    email              VARCHAR(64),
    record_book_number VARCHAR(32),
    academic_group_id  BIGINT NOT NULL REFERENCES academic_groups (id) ON DELETE CASCADE
);

-- ============================ Disciplines & curricula ============================

CREATE TYPE course_type AS ENUM (
    'MANDATORY',
    'ELECTIVE_GROUP',
    'ELECTIVE',
    'OPTIONAL',
    'INTERNSHIP',
    'COURSE_PROJECT',
    'COURSE_WORK',
    'QUALIFICATION_WORK'
);

CREATE TABLE courses
(
    id               BIGSERIAL PRIMARY KEY,
    name             VARCHAR(200) COLLATE ukrainian NOT NULL,
    course_type      course_type  NOT NULL DEFAULT 'MANDATORY',
    faculty_id       BIGINT REFERENCES faculties (id) ON DELETE SET NULL,
    department_id    BIGINT REFERENCES departments (id) ON DELETE CASCADE,
    parent_course_id BIGINT REFERENCES courses (id) ON DELETE CASCADE
);

-- Specialties a course is allowed to be taught for; scopes which courses can be picked when
-- adding a curriculum item to a specialty's curriculum (see curriculum_items below).
CREATE TABLE course_specialties
(
    course_id    BIGINT NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
    specialty_id BIGINT NOT NULL REFERENCES specialties (id) ON DELETE CASCADE,
    PRIMARY KEY (course_id, specialty_id)
);

-- Free-form labels shown after a course's name (e.g. "English-taught"), one row per tag.
CREATE TABLE course_tags
(
    id        BIGSERIAL PRIMARY KEY,
    course_id BIGINT NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
    tag       VARCHAR(64) COLLATE ukrainian NOT NULL,
    UNIQUE (course_id, tag)
);

CREATE TYPE control_form AS ENUM ('EXAM', 'CREDIT', 'GRADED_CREDIT');

CREATE TABLE curriculum_items
(
    id           BIGSERIAL PRIMARY KEY,
    semester     INTEGER      NOT NULL,
    control_form control_form NOT NULL,
    ects_credits INTEGER      NOT NULL,
    specialty_id BIGINT NOT NULL REFERENCES specialties (id) ON DELETE CASCADE,
    course_id    BIGINT NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
    UNIQUE (course_id, specialty_id, semester)
);

-- Ordered as they should appear in a plan: contact teaching, then the contact work around it
-- (consultations, assessment), then the student's own work. Enum order is also sort order —
-- curriculumItemHoursConnection sorts by hour_type, which Postgres orders by declaration.
CREATE TYPE hour_type AS ENUM ('LECTURE', 'PRACTICAL', 'LAB', 'CONSULTATION', 'ASSESSMENT', 'INDEPENDENT_WORK');

CREATE TABLE curriculum_item_hours
(
    id                 BIGSERIAL PRIMARY KEY,
    curriculum_item_id BIGINT NOT NULL REFERENCES curriculum_items (id) ON DELETE CASCADE,
    hour_type          hour_type NOT NULL,
    hours              INTEGER   NOT NULL,
    UNIQUE (curriculum_item_id, hour_type)
);

-- TOGETHER    - one lecturer takes all the item's groups at once (a shared lecture stream)
-- SEPARATELY  - the item's groups are split between lecturers, each taking whole groups
-- INDIVIDUALLY - a lecturer works one-to-one with each student (e.g. coursework consultations),
--               so the workload scales with student count rather than with group count
CREATE TYPE teaching_format AS ENUM ('TOGETHER', 'SEPARATELY', 'INDIVIDUALLY');

CREATE TABLE working_curriculum_items
(
    id                       BIGSERIAL PRIMARY KEY,
    curriculum_item_hours_id BIGINT NOT NULL REFERENCES curriculum_item_hours (id) ON DELETE CASCADE,
    lecturer_count           INTEGER        NOT NULL DEFAULT 1,
    teaching_format          teaching_format NOT NULL DEFAULT 'TOGETHER',
    department_id            BIGINT NOT NULL REFERENCES departments (id) ON DELETE CASCADE,
    course_id                BIGINT REFERENCES courses (id) ON DELETE SET NULL
);

CREATE TABLE working_curriculum_item_groups
(
    working_curriculum_item_id BIGINT NOT NULL REFERENCES working_curriculum_items (id) ON DELETE CASCADE,
    academic_group_id          BIGINT NOT NULL REFERENCES academic_groups (id) ON DELETE CASCADE,
    PRIMARY KEY (working_curriculum_item_id, academic_group_id)
);

-- A "combined" working curriculum item bundles several working_curriculum_items that relate to
-- the same course, semester, and hour type (e.g. groups from different specialties attending one
-- shared lecture), so a single lecturer_workloads assignment can cover all of them at once.
CREATE TABLE combined_working_curriculum_items
(
    id BIGSERIAL PRIMARY KEY
);

CREATE TABLE combined_working_curriculum_item_members
(
    combined_working_curriculum_item_id BIGINT NOT NULL REFERENCES combined_working_curriculum_items (id) ON DELETE CASCADE,
    working_curriculum_item_id          BIGINT NOT NULL REFERENCES working_curriculum_items (id) ON DELETE CASCADE,
    PRIMARY KEY (combined_working_curriculum_item_id, working_curriculum_item_id)
);

-- ============================ Infrastructure: Rooms ============================

CREATE TYPE room_kind AS ENUM ('LECTURE_HALL', 'COMPUTER_LAB', 'SEMINAR_ROOM');

CREATE TABLE rooms
(
    id          BIGSERIAL PRIMARY KEY,
    building_id BIGINT REFERENCES buildings (id) ON DELETE SET NULL,
    number      VARCHAR(32) COLLATE ukrainian NOT NULL,
    name        VARCHAR(96) COLLATE ukrainian,
    capacity    INTEGER,
    kind        room_kind,
    faculty_id  BIGINT REFERENCES faculties (id) ON DELETE SET NULL
);

-- A named, reusable set of rooms — "Комп'ютерні класи (2 корпус)", "Спортивні зали", "Потокові
-- аудиторії ФПМІ". Its purpose is reuse: the same handful of rooms is eligible for dozens of
-- workloads, and naming that set once is better than re-picking the rooms every time.
--
-- Modelled on combined_groups, which does the same job for academic groups, down to the optional
-- `purpose` note explaining what the set is for.
--
-- A group may be scoped, so that it is only offered where it makes sense:
--
--   both NULL     university-wide — any workload may use it;
--   faculty_id    only workloads of that faculty's departments;
--   department_id only that one department's workloads.
--
-- The two are mutually exclusive rather than combinable: a department already determines its
-- faculty, so setting both could only ever be redundant or contradictory. Note the rooms in a
-- group are *not* constrained by its scope — a department's group routinely contains rooms owned
-- by the faculty, or by nobody; the scope says who may reach for the group, not what is in it.
CREATE TABLE room_groups
(
    id            BIGSERIAL PRIMARY KEY,
    name          VARCHAR(64)  COLLATE ukrainian NOT NULL,
    purpose       VARCHAR(200) COLLATE ukrainian,
    -- ON DELETE CASCADE for the same reason as class_start_time_sets.faculty_id: a group that
    -- exists *for* one faculty or department is meaningless once its owner is gone. Nothing is lost
    -- beyond the group itself — lecturer_workload_room_groups only loses the link, and the rooms,
    -- which are physical and shared, are untouched.
    faculty_id    BIGINT REFERENCES faculties (id)   ON DELETE CASCADE,
    department_id BIGINT REFERENCES departments (id) ON DELETE CASCADE,
    CONSTRAINT room_groups_scope_check CHECK (
        faculty_id IS NULL OR department_id IS NULL
    )
);

-- Unique within its scope, so a faculty and one of its departments can each keep a group called
-- "Комп'ютерні класи" without one blocking the other. COALESCE rather than NULLS NOT DISTINCT,
-- matching class_start_time_sets_unique_name and permissions_unique_grant.
CREATE UNIQUE INDEX room_groups_unique_name
    ON room_groups (name, COALESCE(faculty_id, 0), COALESCE(department_id, 0));

CREATE INDEX room_groups_faculty_idx    ON room_groups (faculty_id)    WHERE faculty_id IS NOT NULL;
CREATE INDEX room_groups_department_idx ON room_groups (department_id) WHERE department_id IS NOT NULL;

CREATE TABLE room_group_rooms
(
    room_group_id BIGINT NOT NULL REFERENCES room_groups (id) ON DELETE CASCADE,
    room_id       BIGINT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    PRIMARY KEY (room_group_id, room_id)
);

-- ============================ Infrastructure: Class start times ============================
--
-- Not every kind of class runs on the same bells. Physical education, for instance, usually starts
-- on its own grid so students have time to reach a sports hall and back; an evening or part-time
-- programme may shift the whole day later. So the start times are grouped into *named sets*, and a
-- timetable entry picks a time out of one of them.
--
-- Exactly one set is the default: the one that applies wherever nothing more specific does. A set
-- may instead be scoped to a single faculty, which restricts it to that faculty — and such a set
-- can never be the default, because a default is by definition university-wide.

CREATE TABLE class_start_time_sets
(
    id         BIGSERIAL PRIMARY KEY,
    name       VARCHAR(120) COLLATE ukrainian NOT NULL,
    -- The university-wide set used when nothing more specific applies. At most one row in the whole
    -- table may have this set — see class_start_time_sets_single_default below.
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    -- NULL = available to every faculty; set = usable only in that faculty's timetables.
    --
    -- ON DELETE CASCADE rather than the SET NULL that rooms.faculty_id and courses.faculty_id use:
    -- a room outlives its faculty because it is a physical thing, but a set that exists *for* one
    -- faculty has no meaning once that faculty is gone. Widening it instead would silently promote
    -- a private grid to a university-wide one, and — where a university-wide set already carries
    -- the same name — make deleting the faculty fail on the name index below.
    faculty_id BIGINT REFERENCES faculties (id) ON DELETE CASCADE,
    -- Scoping and defaulting are mutually exclusive: "the default" means "for the whole university".
    CONSTRAINT class_start_time_sets_default_scope_check CHECK (
        NOT (is_default AND faculty_id IS NOT NULL)
    )
);

-- At most one default across the whole table. A *partial* unique index is what expresses that: it
-- only indexes the rows where is_default is true, so they collide with each other while the
-- non-default rows are left alone. A plain UNIQUE (is_default) would wrongly allow just one
-- non-default set as well.
--
-- The index is checked per statement, not deferred to commit, so moving the default has to clear
-- the old row before (or in the same statement as) setting the new one:
--     UPDATE class_start_time_sets SET is_default = (id = :newId) WHERE is_default OR id = :newId;
-- Inserting a new default and only then clearing the old one fails, even inside one transaction.
CREATE UNIQUE INDEX class_start_time_sets_single_default
    ON class_start_time_sets (is_default) WHERE is_default;

-- Names are unique within their scope, so two faculties can each keep their own "Фізичне
-- виховання" while the university-wide sets stay distinguishable from one another. COALESCE
-- rather than NULLS NOT DISTINCT, matching permissions_unique_grant below.
CREATE UNIQUE INDEX class_start_time_sets_unique_name
    ON class_start_time_sets (name, COALESCE(faculty_id, 0));

CREATE INDEX class_start_time_sets_faculty_idx
    ON class_start_time_sets (faculty_id) WHERE faculty_id IS NOT NULL;

-- Stores only the possible start times a class can begin at; the end of a class is derived from
-- the workload's duration_hours and the academic_hour_duration_minutes global property.
--
-- ordinal is unique *within a set* rather than globally, so every set numbers its own periods
-- 1..N independently — "друга пара" of the PE set is a different row from "друга пара" of the
-- main one, and both are legitimately number 2.
CREATE TABLE class_start_times
(
    id                      BIGSERIAL PRIMARY KEY,
    class_start_time_set_id BIGINT      NOT NULL REFERENCES class_start_time_sets (id) ON DELETE CASCADE,
    ordinal                 INTEGER     NOT NULL,
    start_time              VARCHAR(8)  NOT NULL,
    UNIQUE (class_start_time_set_id, ordinal),
    -- A set never lists the same clock time twice, whatever ordinal it is given.
    UNIQUE (class_start_time_set_id, start_time)
);

-- ============================ Workload (class requirements) & timetable ============================

CREATE TABLE lecturer_workloads
(
    id                                   BIGSERIAL PRIMARY KEY,
    -- Exactly one of these two is set: either a single working_curriculum_item, or a
    -- combined_working_curriculum_item for lecturers who simultaneously teach several
    -- working_curriculum_items (e.g. groups from different specialties) at once.
    working_curriculum_item_id          BIGINT REFERENCES working_curriculum_items (id) ON DELETE CASCADE,
    combined_working_curriculum_item_id BIGINT REFERENCES combined_working_curriculum_items (id) ON DELETE CASCADE,
    -- Duration of each class for this workload, in academic hours (1 lesson = 1-4 academic hours).
    duration_hours                      INTEGER NOT NULL DEFAULT 2 CHECK (duration_hours BETWEEN 1 AND 4),
    -- Which grid of start times this workload's classes are scheduled on. Carried per workload
    -- rather than per timetable entry because it is a property of the *class*, not of one of its
    -- weekly occurrences: physical education runs on its own bells for every one of its classes.
    -- timetable_entries.class_start_time_id must therefore point at a time belonging to this set.
    --
    -- ON DELETE RESTRICT: a set in use cannot simply vanish. CASCADE would delete the workloads
    -- scheduled on it — losing an entire discipline's assignment because someone tidied up a list
    -- of bells — and the column is NOT NULL, so SET NULL is not available either.
    class_start_time_set_id             BIGINT  NOT NULL REFERENCES class_start_time_sets (id) ON DELETE RESTRICT,
    CONSTRAINT lecturer_workloads_target_check CHECK (
        (working_curriculum_item_id IS NOT NULL) <> (combined_working_curriculum_item_id IS NOT NULL)
    )
);

CREATE TABLE lecturer_workload_lecturers
(
    lecturer_workload_id BIGINT NOT NULL REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    lecturer_id           BIGINT NOT NULL REFERENCES lecturers (id) ON DELETE CASCADE,
    PRIMARY KEY (lecturer_workload_id, lecturer_id)
);

CREATE TABLE lecturer_workload_academic_groups
(
    lecturer_workload_id BIGINT NOT NULL REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    academic_group_id    BIGINT NOT NULL REFERENCES academic_groups (id) ON DELETE CASCADE,
    PRIMARY KEY (lecturer_workload_id, academic_group_id)
);

CREATE TABLE lecturer_workload_combined_groups
(
    lecturer_workload_id BIGINT NOT NULL REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    combined_group_id    BIGINT NOT NULL REFERENCES combined_groups (id) ON DELETE CASCADE,
    PRIMARY KEY (lecturer_workload_id, combined_group_id)
);

-- Which rooms this workload's classes may be held in, said two ways: individually named rooms, and
-- whole reusable room groups. Both exist because both are natural — a lecture that must happen in
-- the one hall large enough for it names that hall directly, while a lab that can run in any
-- computer class points at the group and stays correct when a room is later added to it.
--
-- The eligible rooms are the **union** of the two lists, and an empty union means *unrestricted*:
-- a workload that names neither may be scheduled anywhere, which is the right default for the many
-- ordinary classes with no particular requirement. Restricting is opt-in.
--
-- Nothing here forces timetable_entries.room_id to fall within that union. It is a condition two
-- joins away (and expands through room_group_rooms), so it belongs to the scheduler, alongside the
-- matching rule for class start times — see the note on timetable_entries below.
CREATE TABLE lecturer_workload_rooms
(
    lecturer_workload_id BIGINT NOT NULL REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    room_id              BIGINT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    PRIMARY KEY (lecturer_workload_id, room_id)
);

CREATE TABLE lecturer_workload_room_groups
(
    lecturer_workload_id BIGINT NOT NULL REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    room_group_id        BIGINT NOT NULL REFERENCES room_groups (id) ON DELETE CASCADE,
    PRIMARY KEY (lecturer_workload_id, room_group_id)
);

-- Lecturer<->student pairings for a workload whose working curriculum item is taught
-- INDIVIDUALLY (e.g. coursework consultations): instead of assigning academic groups, each
-- student is paired with the lecturer supervising them.
--
-- Unlike the join tables above this needs its own surrogate id: the two foreign keys are only
-- meaningful together, so it is written as a nested child list on LecturerWorkload's mutations,
-- and that reconciliation matches and deletes child rows by id.
CREATE TABLE lecturer_workload_students
(
    id                   BIGSERIAL PRIMARY KEY,
    lecturer_workload_id BIGINT NOT NULL REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    lecturer_id          BIGINT NOT NULL REFERENCES lecturers (id) ON DELETE CASCADE,
    student_id           BIGINT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
    -- Within one workload a student has exactly one supervising lecturer.
    UNIQUE (lecturer_workload_id, student_id)
);

-- Lecturers who *could* deliver a workload, each with how desirable that assignment is: 100 is
-- ideal, 1 is a last resort. Input for automatic workload generation — the generator picks from
-- these rather than from every lecturer of the department, and prefers higher scores.
--
-- Distinct from lecturer_workload_lecturers, which records who was actually assigned: a workload
-- may list many candidates and end up with one of them (or, before generation runs, none).
CREATE TABLE lecturer_workload_candidates
(
    id                   BIGSERIAL PRIMARY KEY,
    lecturer_workload_id BIGINT NOT NULL REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    lecturer_id          BIGINT NOT NULL REFERENCES lecturers (id) ON DELETE CASCADE,
    desirability         INTEGER NOT NULL CHECK (desirability BETWEEN 1 AND 100),
    -- A lecturer is a candidate for a given workload at most once.
    UNIQUE (lecturer_workload_id, lecturer_id)
);

-- Per-candidate student-count limits, meaningful only when the underlying working curriculum item
-- is taught INDIVIDUALLY (coursework consultations and the like), where the workload is measured
-- in students rather than in groups. Shaped like lecturer_workload_constraints: one row per limit
-- actually set, rather than two mostly-NULL columns on every candidate.
--
--   MIN_STUDENTS  the *desired* number of students for this lecturer — generation tries to give
--                 them at least this many.
--   MAX_STUDENTS  the hard ceiling. Students beyond the desired number are handed out among the
--                 candidates that still have headroom, in order of desirability, up to this value.
CREATE TYPE lecturer_workload_candidate_constraint_type AS ENUM ('MIN_STUDENTS', 'MAX_STUDENTS');

CREATE TABLE lecturer_workload_candidate_constraints
(
    id                             BIGSERIAL PRIMARY KEY,
    lecturer_workload_candidate_id BIGINT NOT NULL
        REFERENCES lecturer_workload_candidates (id) ON DELETE CASCADE,
    constraint_type                lecturer_workload_candidate_constraint_type NOT NULL,
    value                          INTEGER NOT NULL CHECK (value >= 0),
    -- A limit is set at most once per candidate.
    UNIQUE (lecturer_workload_candidate_id, constraint_type)
);

CREATE TYPE week_parity AS ENUM ('WEEKLY', 'NUMERATOR', 'DENOMINATOR');

CREATE TABLE timetable_entries
(
    id           BIGSERIAL PRIMARY KEY,
    day_of_week  INTEGER     NOT NULL,
    week_parity  week_parity NOT NULL,
    workload_id  BIGINT NOT NULL REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    -- The chosen time carries its set with it (class_start_times.class_start_time_set_id), so no
    -- separate set column is stored here — one would only be able to disagree with this one.
    -- Whether that set is *allowed* for the entry's faculty is a question about
    -- class_start_time_sets.faculty_id and the workload's groups, two joins away, so it is enforced
    -- in the application rather than by a constraint here.
    class_start_time_id BIGINT NOT NULL REFERENCES class_start_times (id) ON DELETE CASCADE,
    -- Likewise: the room must be one the workload allows — the union of lecturer_workload_rooms and
    -- the rooms of its lecturer_workload_room_groups, or any room at all when both are empty. That
    -- is a set-membership test across two join tables, so the scheduler enforces it, not a CHECK.
    room_id      BIGINT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE
);

-- ============================ Scheduling constraints ============================
--
-- When and how densely a lecturer, an academic group or a room may be given classes. These do not
-- describe a timetable; they restrict the ones the scheduler is allowed to build, and are checked
-- against a candidate timetable_entries row rather than stored on it.
--
-- The eight rules the faculty asks for are four kinds of restriction, each of which either applies
-- to every day or to one named day — so `day_of_week NULL` means "every day" and a value means
-- "that day only".
--
-- The payload is a single `constraint_value` string whose meaning depends on `constraint_type`,
-- the same arrangement global_properties uses (value always text, type says how to read it):
--
--   constraint_type      constraint_value    example  meaning
--   -------------------  ------------------  -------  --------------------------------------------
--   MAX_CLASSES_PER_DAY  N                   '3'      at most N classes
--   NOT_BEFORE           HH:MM               '12:30'  nothing may *start* before this
--   NOT_AFTER            HH:MM               '17:00'  nothing may *end* after this
--   UNAVAILABLE          HH:MM-HH:MM         '13:10-14:00'  nothing may overlap [from, to)
--
-- Each form is pinned by timetable_constraints_value_check on every table, so the column can only
-- ever hold a string the matching type knows how to read: a count is canonical decimal with no
-- leading zeros or sign, times are zero-padded 24-hour, and a window's two halves are separated by
-- one '-' and run forwards. Reading it back is `constraint_value::int` for a count,
-- `left(constraint_value, 5)` and `right(constraint_value, 5)` for a window's ends — and because
-- the times are zero-padded, plain string comparison against class_start_times.start_time
-- (VARCHAR(8), but only ever HH:MM) is chronological comparison, with no cast either way.
--
-- day_of_week is deliberately *not* folded into the string: it selects which rows apply and has to
-- stay a column the scheduler can filter and index on.
--
-- The last three types are one idea — a forbidden interval — and a scheduler is expected to
-- normalise them into intervals: NOT_BEFORE is [00:00, from), NOT_AFTER is [to, 24:00), and
-- UNAVAILABLE is the closed-open span between the two. They are kept as separate types anyway
-- because the intent is what the user typed and what an editing UI has to show back; collapsing
-- them would turn "закінчувати о 17:00" into "не займати 17:00–24:00" the next time the row is read.
--
-- **More specific wins.** A day-specific row overrides the every-day row of the same type for that
-- day rather than adding to it: NOT_BEFORE 12:30 every day together with NOT_BEFORE 09:00 on
-- Monday means Monday starts at 09:00 and the rest of the week at 12:30. Without that rule the two
-- could only ever contradict each other, since a lecturer who wants a later start on one day has no
-- way to say so. UNAVAILABLE is the exception: its windows accumulate, because several disjoint
-- gaps in one day are a normal thing to want and none of them contradicts another. The unique
-- indexes on each table below say exactly this — one row per (subject, type, day) for the three
-- single-valued types, and only exact duplicates rejected for windows.
--
-- Evaluating the time rules needs the *end* of a class, which is not stored anywhere: it is
-- class_start_times.start_time + lecturer_workloads.duration_hours × the
-- academic_hour_duration_minutes global property. Only NOT_BEFORE can be answered from the start
-- time alone.
--
-- Counting for MAX_CLASSES_PER_DAY is per *calendar week*, not per row: an entry with week_parity
-- WEEKLY falls in both weeks, NUMERATOR and DENOMINATOR in one each, so the cap has to hold for
-- (WEEKLY + NUMERATOR) and for (WEEKLY + DENOMINATOR) separately. Counting all three together
-- would reject a legal timetable that merely alternates two classes in one slot.
--
-- Nothing here is a preference: every row is a hard restriction. Soft constraints would need a
-- weight alongside, in the shape of lecturer_workload_candidates.desirability, and are deliberately
-- left out until there is a scheduler that can trade them off.
--
-- One table per subject rather than one shared table with a nullable lecturer/group/room triple:
-- each subject then has a plain NOT NULL foreign key instead of an "exactly one of three is set"
-- CHECK, the unique indexes lose their COALESCE over the subject columns, and each table is
-- indexed and queried on its own. The cost is that the value rule below is written out three
-- times — the enum is shared, but adding a constraint type means touching all three tables.

CREATE TYPE timetable_constraint_type AS ENUM (
    'MAX_CLASSES_PER_DAY',
    'NOT_BEFORE',
    'NOT_AFTER',
    'UNAVAILABLE'
);

-- ------------------------------------------------------------------ lecturers

CREATE TABLE lecturer_timetable_constraints
(
    id               BIGSERIAL PRIMARY KEY,
    lecturer_id      BIGINT NOT NULL REFERENCES lecturers (id) ON DELETE CASCADE,
    constraint_type  timetable_constraint_type NOT NULL,
    -- NULL = every day. Otherwise 1..7 with Monday = 1, the same convention as
    -- timetable_entries.day_of_week.
    day_of_week      INTEGER,
    -- Serialized per constraint_type — see the table of forms above.
    constraint_value VARCHAR(32) NOT NULL,

    CONSTRAINT lecturer_timetable_constraints_day_check CHECK (
        day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7
    ),
    -- The value is only ever a string the matching type can read. '0' is a meaningful count —
    -- "no classes at all on Friday" — so it is allowed, while '007', '-1' and '9:00' are not, and
    -- an UNAVAILABLE window must run forwards (equal ends would be an empty window, a row that
    -- restricts nothing).
    CONSTRAINT lecturer_timetable_constraints_value_check CHECK (
        CASE constraint_type
            WHEN 'MAX_CLASSES_PER_DAY' THEN
                constraint_value ~ '^(0|[1-9][0-9]{0,2})$'
            WHEN 'NOT_BEFORE' THEN
                constraint_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            WHEN 'NOT_AFTER' THEN
                constraint_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            WHEN 'UNAVAILABLE' THEN
                constraint_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$'
                AND left(constraint_value, 5) < right(constraint_value, 5)
        END
    )
);

-- The three single-valued types are set at most once per lecturer and day — re-setting one updates
-- the existing row, as lecturer_workload_constraints does. COALESCE rather than NULLS NOT DISTINCT
-- so that the every-day row (day_of_week NULL) collides with another every-day row of the same
-- type, matching room_groups_unique_name and permissions_unique_grant.
CREATE UNIQUE INDEX lecturer_timetable_constraints_unique_single
    ON lecturer_timetable_constraints (lecturer_id, constraint_type, COALESCE(day_of_week, 0))
    WHERE constraint_type <> 'UNAVAILABLE';

-- Windows may repeat across a lecturer's days but not within one: the same span entered twice is a
-- duplicate, not a second restriction.
CREATE UNIQUE INDEX lecturer_timetable_constraints_unique_window
    ON lecturer_timetable_constraints (lecturer_id, COALESCE(day_of_week, 0), constraint_value)
    WHERE constraint_type = 'UNAVAILABLE';

-- Reading every constraint of one lecturer spans both partial indexes above, so it needs one of
-- its own. Same for the two tables that follow.
CREATE INDEX lecturer_timetable_constraints_lecturer_idx
    ON lecturer_timetable_constraints (lecturer_id);

-- ------------------------------------------------------------------ academic groups

CREATE TABLE academic_group_timetable_constraints
(
    id                BIGSERIAL PRIMARY KEY,
    academic_group_id BIGINT NOT NULL REFERENCES academic_groups (id) ON DELETE CASCADE,
    constraint_type   timetable_constraint_type NOT NULL,
    day_of_week       INTEGER,
    constraint_value  VARCHAR(32) NOT NULL,

    CONSTRAINT academic_group_timetable_constraints_day_check CHECK (
        day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7
    ),
    CONSTRAINT academic_group_timetable_constraints_value_check CHECK (
        CASE constraint_type
            WHEN 'MAX_CLASSES_PER_DAY' THEN
                constraint_value ~ '^(0|[1-9][0-9]{0,2})$'
            WHEN 'NOT_BEFORE' THEN
                constraint_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            WHEN 'NOT_AFTER' THEN
                constraint_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            WHEN 'UNAVAILABLE' THEN
                constraint_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$'
                AND left(constraint_value, 5) < right(constraint_value, 5)
        END
    )
);

CREATE UNIQUE INDEX academic_group_timetable_constraints_unique_single
    ON academic_group_timetable_constraints (academic_group_id, constraint_type,
                                             COALESCE(day_of_week, 0))
    WHERE constraint_type <> 'UNAVAILABLE';

CREATE UNIQUE INDEX academic_group_timetable_constraints_unique_window
    ON academic_group_timetable_constraints (academic_group_id, COALESCE(day_of_week, 0),
                                             constraint_value)
    WHERE constraint_type = 'UNAVAILABLE';

CREATE INDEX academic_group_timetable_constraints_group_idx
    ON academic_group_timetable_constraints (academic_group_id);

-- ------------------------------------------------------------------ rooms

CREATE TABLE room_timetable_constraints
(
    id               BIGSERIAL PRIMARY KEY,
    room_id          BIGINT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    constraint_type  timetable_constraint_type NOT NULL,
    day_of_week      INTEGER,
    constraint_value VARCHAR(32) NOT NULL,

    CONSTRAINT room_timetable_constraints_day_check CHECK (
        day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7
    ),
    CONSTRAINT room_timetable_constraints_value_check CHECK (
        CASE constraint_type
            WHEN 'MAX_CLASSES_PER_DAY' THEN
                constraint_value ~ '^(0|[1-9][0-9]{0,2})$'
            WHEN 'NOT_BEFORE' THEN
                constraint_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            WHEN 'NOT_AFTER' THEN
                constraint_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            WHEN 'UNAVAILABLE' THEN
                constraint_value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$'
                AND left(constraint_value, 5) < right(constraint_value, 5)
        END
    )
);

CREATE UNIQUE INDEX room_timetable_constraints_unique_single
    ON room_timetable_constraints (room_id, constraint_type, COALESCE(day_of_week, 0))
    WHERE constraint_type <> 'UNAVAILABLE';

CREATE UNIQUE INDEX room_timetable_constraints_unique_window
    ON room_timetable_constraints (room_id, COALESCE(day_of_week, 0), constraint_value)
    WHERE constraint_type = 'UNAVAILABLE';

CREATE INDEX room_timetable_constraints_room_idx
    ON room_timetable_constraints (room_id);

-- ============================ Authentication & authorization ============================
--
-- Users never self-register: an admin creates an account with a temporary password
-- (must_change_password = TRUE), and the user is forced to set a real password on first login.
--
-- Permissions are entity-scoped: a grant names a resource_type (the securable entity's simple
-- class name in UPPER_SNAKE_CASE, e.g. 'FACULTY', 'DEPARTMENT', 'WORKING_CURRICULUM_ITEM' — this
-- mirrors org.lnu.timetable.framework.metadata.EntityMetadata#resourceType, so any entity newly
-- annotated with @GraphQLEntity automatically becomes a valid grant target with no schema change
-- here) plus a resource_id, OR the special resource_type 'GLOBAL' (resource_id NULL) for
-- full-access admin grants. Modify permission on a resource cascades to its descendants along the
-- edges declared via @PermissionParent/@PermissionJoinParent on the domain classes (see
-- org.lnu.timetable.security.PermissionService) — this table only stores the grants themselves,
-- not the cascade rules.
--
-- A grant is made either to a single user or to a group (never both); a user can belong to
-- multiple groups, and effective permissions are the union of a user's direct grants and all of
-- their groups' grants.

CREATE TABLE users
(
    id                   BIGSERIAL PRIMARY KEY,
    email                VARCHAR(255) NOT NULL UNIQUE,
    first_name           VARCHAR(100) NOT NULL,
    last_name            VARCHAR(100) NOT NULL,
    password_hash        VARCHAR(255) NOT NULL,
    must_change_password BOOLEAN      NOT NULL DEFAULT TRUE,
    is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMP    NOT NULL DEFAULT now(),
    updated_at           TIMESTAMP    NOT NULL DEFAULT now()
);

CREATE TABLE groups
(
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(160) NOT NULL UNIQUE,
    description VARCHAR(500)
);

CREATE TABLE user_groups
(
    user_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    group_id BIGINT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
);

CREATE TYPE grantee_type AS ENUM ('USER', 'GROUP');

CREATE TABLE permissions
(
    id            BIGSERIAL PRIMARY KEY,
    grantee_type  grantee_type NOT NULL,
    user_id       BIGINT REFERENCES users (id) ON DELETE CASCADE,
    group_id      BIGINT REFERENCES groups (id) ON DELETE CASCADE,
    -- Entity simple name in UPPER_SNAKE_CASE (e.g. 'FACULTY'), or 'GLOBAL' for full-access admin.
    resource_type VARCHAR(64)  NOT NULL,
    -- NULL only when resource_type = 'GLOBAL'.
    resource_id   BIGINT,
    granted_by    BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at    TIMESTAMP    NOT NULL DEFAULT now(),
    CONSTRAINT permissions_grantee_check CHECK (
        (grantee_type = 'USER' AND user_id IS NOT NULL AND group_id IS NULL) OR
        (grantee_type = 'GROUP' AND group_id IS NOT NULL AND user_id IS NULL)
    ),
    CONSTRAINT permissions_resource_check CHECK (
        (resource_type = 'GLOBAL' AND resource_id IS NULL) OR
        (resource_type <> 'GLOBAL' AND resource_id IS NOT NULL)
    )
);

-- A given grantee can only hold one grant per exact resource (NULLS NOT DISTINCT so the two
-- GLOBAL rows, which both have resource_id = NULL, are still treated as duplicates of each other).
CREATE UNIQUE INDEX permissions_unique_grant
    ON permissions (grantee_type, COALESCE(user_id, 0), COALESCE(group_id, 0), resource_type, COALESCE(resource_id, 0));

CREATE INDEX permissions_user_idx ON permissions (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX permissions_group_idx ON permissions (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX permissions_resource_idx ON permissions (resource_type, resource_id);
