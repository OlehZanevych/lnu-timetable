DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

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

CREATE TABLE academic_groups
(
    id             BIGSERIAL PRIMARY KEY,
    name           VARCHAR(32) NOT NULL UNIQUE,
    course_year    INTEGER     NOT NULL,
    study_form     VARCHAR(16) NOT NULL,
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

-- ============================ Infrastructure: Rooms ============================

CREATE TABLE rooms
(
    id          BIGSERIAL PRIMARY KEY,
    building_id BIGINT REFERENCES buildings (id) ON DELETE SET NULL,
    number      VARCHAR(32) NOT NULL,
    name        VARCHAR(96),
    capacity    INTEGER,
    kind        VARCHAR(32),
    faculty_id  BIGINT REFERENCES faculties (id) ON DELETE SET NULL
);

CREATE TABLE time_slots
(
    id         BIGSERIAL PRIMARY KEY,
    ordinal    INTEGER     NOT NULL UNIQUE,
    start_time VARCHAR(8)  NOT NULL,
    end_time   VARCHAR(8)  NOT NULL
);

-- ============================ Workload (class requirements) & timetable ============================

CREATE TABLE lecturer_workloads
(
    id                         BIGSERIAL PRIMARY KEY,
    working_curriculum_item_id BIGINT NOT NULL REFERENCES working_curriculum_items (id) ON DELETE CASCADE,
    lecturer_id                BIGINT NOT NULL REFERENCES lecturers (id) ON DELETE CASCADE,
    academic_group_id          BIGINT REFERENCES academic_groups (id) ON DELETE SET NULL,
    combined_group_id          BIGINT REFERENCES combined_groups (id) ON DELETE SET NULL
);

CREATE TABLE timetable_entries
(
    id           BIGSERIAL PRIMARY KEY,
    day_of_week  INTEGER     NOT NULL,
    week_parity  VARCHAR(16) NOT NULL,
    workload_id  BIGINT NOT NULL REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    time_slot_id BIGINT NOT NULL REFERENCES time_slots (id) ON DELETE CASCADE,
    room_id      BIGINT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE
);
