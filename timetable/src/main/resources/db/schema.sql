DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

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
    name        VARCHAR(120) NOT NULL UNIQUE,
    address     VARCHAR(160),
    city        VARCHAR(64),
    postal_code VARCHAR(10)
);

-- ============================ Organisational structure ============================

CREATE TABLE faculties
(
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(160) NOT NULL UNIQUE,
    abbreviation VARCHAR(32) UNIQUE,
    website      VARCHAR(128),
    email        VARCHAR(64),
    phone        VARCHAR(128),
    building_id  BIGINT REFERENCES buildings (id) ON DELETE SET NULL,
    info         TEXT
);

CREATE TABLE departments
(
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(160) NOT NULL UNIQUE,
    abbreviation VARCHAR(32) UNIQUE,
    faculty_id   BIGINT NOT NULL REFERENCES faculties (id) ON DELETE CASCADE,
    email        VARCHAR(64),
    phone        VARCHAR(64),
    info         TEXT
);

CREATE TYPE degree AS ENUM ('JUNIOR_BACHELOR', 'BACHELOR', 'MASTER', 'PHD', 'DOCTOR_OF_SCIENCE');

CREATE TABLE specialties
(
    id            BIGSERIAL PRIMARY KEY,
    code          VARCHAR(16)  NOT NULL,
    name          VARCHAR(160) NOT NULL,
    degree        degree       NOT NULL,
    faculty_id    BIGINT NOT NULL REFERENCES faculties (id) ON DELETE CASCADE,
    UNIQUE (code, degree),
    UNIQUE (name, degree)
);

-- ============================ People & groups ============================

CREATE TABLE academic_degrees
(
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(100) NOT NULL UNIQUE,
    abbreviation VARCHAR(20),
    level        INTEGER      NOT NULL
);

CREATE TYPE lecturer_position AS ENUM ('ASSISTANT', 'TEACHER', 'SENIOR_LECTURER', 'DOCENT', 'PROFESSOR', 'HEAD_OF_DEPARTMENT');

CREATE TABLE lecturers
(
    id                   BIGSERIAL PRIMARY KEY,
    first_name           VARCHAR(64)       NOT NULL,
    middle_name          VARCHAR(64),
    last_name            VARCHAR(64)       NOT NULL,
    email                VARCHAR(64) UNIQUE,
    position             lecturer_position,
    academic_degree_id   BIGINT REFERENCES academic_degrees (id) ON DELETE SET NULL,
    min_hours_per_week   INTEGER,
    max_hours_per_week   INTEGER,
    department_id        BIGINT NOT NULL REFERENCES departments (id) ON DELETE CASCADE
);

CREATE TYPE study_form AS ENUM ('FULL_TIME', 'PART_TIME');

CREATE TABLE academic_groups
(
    id             BIGSERIAL PRIMARY KEY,
    name           VARCHAR(32) NOT NULL UNIQUE,
    course_year    INTEGER     NOT NULL,
    study_form     study_form  NOT NULL,
    students_count INTEGER,
    specialty_id   BIGINT NOT NULL REFERENCES specialties (id) ON DELETE CASCADE
);

CREATE TABLE combined_groups
(
    id      BIGSERIAL PRIMARY KEY,
    name    VARCHAR(64) NOT NULL UNIQUE,
    purpose VARCHAR(200)
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
    first_name         VARCHAR(64) NOT NULL,
    last_name          VARCHAR(64) NOT NULL,
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
    name             VARCHAR(200) NOT NULL,
    course_type      course_type  NOT NULL DEFAULT 'MANDATORY',
    faculty_id       BIGINT REFERENCES faculties (id) ON DELETE SET NULL,
    department_id    BIGINT REFERENCES departments (id) ON DELETE CASCADE,
    parent_course_id BIGINT REFERENCES courses (id) ON DELETE CASCADE
);

CREATE TYPE control_form AS ENUM ('EXAM', 'CREDIT', 'GRADED_CREDIT');

CREATE TABLE curriculum_items
(
    id           BIGSERIAL PRIMARY KEY,
    semester     INTEGER      NOT NULL,
    control_form control_form NOT NULL,
    ects_credits INTEGER,
    specialty_id BIGINT NOT NULL REFERENCES specialties (id) ON DELETE CASCADE,
    course_id    BIGINT NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
    UNIQUE (course_id, specialty_id, semester)
);

CREATE TYPE hour_type AS ENUM ('LECTURE', 'PRACTICAL', 'LAB', 'INDEPENDENT_WORK');

CREATE TABLE curriculum_item_hours
(
    id                 BIGSERIAL PRIMARY KEY,
    curriculum_item_id BIGINT NOT NULL REFERENCES curriculum_items (id) ON DELETE CASCADE,
    hour_type          hour_type NOT NULL,
    hours              INTEGER   NOT NULL,
    UNIQUE (curriculum_item_id, hour_type)
);

CREATE TYPE teaching_format AS ENUM ('TOGETHER', 'SEPARATELY');

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
    number      VARCHAR(32) NOT NULL,
    name        VARCHAR(96),
    capacity    INTEGER,
    kind        room_kind,
    faculty_id  BIGINT REFERENCES faculties (id) ON DELETE SET NULL
);

-- Stores only the possible start times a class can begin at; the end of a class is derived from
-- the workload's duration_hours and the academic_hour_duration_minutes global property.
CREATE TABLE class_start_times
(
    id         BIGSERIAL PRIMARY KEY,
    ordinal    INTEGER     NOT NULL UNIQUE,
    start_time VARCHAR(8)  NOT NULL
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

CREATE TYPE week_parity AS ENUM ('WEEKLY', 'NUMERATOR', 'DENOMINATOR');

CREATE TABLE timetable_entries
(
    id           BIGSERIAL PRIMARY KEY,
    day_of_week  INTEGER     NOT NULL,
    week_parity  week_parity NOT NULL,
    workload_id  BIGINT NOT NULL REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    class_start_time_id BIGINT NOT NULL REFERENCES class_start_times (id) ON DELETE CASCADE,
    room_id      BIGINT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE
);
