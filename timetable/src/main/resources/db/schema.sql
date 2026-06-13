DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

-- ============================ Infrastructure: Buildings ============================

CREATE TABLE buildings
(
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(120) NOT NULL,
    address     VARCHAR(160),
    city        VARCHAR(64),
    postal_code VARCHAR(10)
);

-- ============================ Organisational structure ============================

CREATE TABLE faculties
(
    id           BIGSERIAL PRIMARY KEY,
    name         VARCHAR(160) NOT NULL UNIQUE,
    abbreviation VARCHAR(32),
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
    abbreviation VARCHAR(32),
    faculty_id   BIGINT NOT NULL REFERENCES faculties (id) ON DELETE CASCADE,
    email        VARCHAR(64),
    phone        VARCHAR(64),
    info         TEXT
);

CREATE TABLE specialties
(
    id            BIGSERIAL PRIMARY KEY,
    code          VARCHAR(16)  NOT NULL,
    name          VARCHAR(160) NOT NULL,
    degree        VARCHAR(16)  NOT NULL,
    qualification VARCHAR(160),
    faculty_id    BIGINT NOT NULL REFERENCES faculties (id) ON DELETE CASCADE,
    UNIQUE (code, degree)
);

-- ============================ Disciplines & curricula ============================

CREATE TABLE courses
(
    id            BIGSERIAL PRIMARY KEY,
    code          VARCHAR(32),
    name          VARCHAR(200) NOT NULL,
    ects_credits  INTEGER,
    department_id BIGINT NOT NULL REFERENCES departments (id) ON DELETE CASCADE
);

CREATE TABLE curricula
(
    id             BIGSERIAL PRIMARY KEY,
    name           VARCHAR(200) NOT NULL,
    admission_year INTEGER      NOT NULL,
    degree         VARCHAR(16)  NOT NULL,
    specialty_id   BIGINT NOT NULL REFERENCES specialties (id) ON DELETE CASCADE
);

CREATE TABLE curriculum_items
(
    id            BIGSERIAL PRIMARY KEY,
    semester      INTEGER     NOT NULL,
    control_form  VARCHAR(16) NOT NULL,
    ects_credits  INTEGER,
    curriculum_id BIGINT NOT NULL REFERENCES curricula (id) ON DELETE CASCADE,
    course_id     BIGINT NOT NULL REFERENCES courses (id) ON DELETE CASCADE
);

CREATE TABLE working_curricula
(
    id            BIGSERIAL PRIMARY KEY,
    academic_year VARCHAR(16) NOT NULL,
    semester      INTEGER     NOT NULL,
    curriculum_id BIGINT NOT NULL REFERENCES curricula (id) ON DELETE CASCADE
);

CREATE TABLE working_curriculum_items
(
    id                    BIGSERIAL PRIMARY KEY,
    lecture_hours         INTEGER,
    practical_hours       INTEGER,
    lab_hours             INTEGER,
    seminar_hours         INTEGER,
    working_curriculum_id BIGINT NOT NULL REFERENCES working_curricula (id) ON DELETE CASCADE,
    course_id             BIGINT NOT NULL REFERENCES courses (id) ON DELETE CASCADE
);

-- ============================ People & groups ============================

CREATE TABLE lecturers
(
    id                 BIGSERIAL PRIMARY KEY,
    first_name         VARCHAR(64) NOT NULL,
    last_name          VARCHAR(64) NOT NULL,
    email              VARCHAR(64),
    position           VARCHAR(32),
    academic_degree    VARCHAR(32),
    max_hours_per_week INTEGER,
    department_id      BIGINT NOT NULL REFERENCES departments (id) ON DELETE CASCADE
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

-- ============================ Infrastructure: Rooms ============================

CREATE TABLE rooms
(
    id          BIGSERIAL PRIMARY KEY,
    number      VARCHAR(32) NOT NULL,
    name        VARCHAR(96),
    capacity    INTEGER,
    kind        VARCHAR(32),
    faculty_id  BIGINT REFERENCES faculties (id) ON DELETE SET NULL,
    building_id BIGINT REFERENCES buildings (id) ON DELETE SET NULL
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
    id                    BIGSERIAL PRIMARY KEY,
    class_type            VARCHAR(16) NOT NULL,
    periodicity           VARCHAR(16) NOT NULL,
    hours_per_week        INTEGER,
    lecturer_id           BIGINT NOT NULL REFERENCES lecturers (id) ON DELETE CASCADE,
    course_id             BIGINT NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
    academic_group_id     BIGINT REFERENCES academic_groups (id) ON DELETE SET NULL,
    combined_group_id     BIGINT REFERENCES combined_groups (id) ON DELETE SET NULL,
    working_curriculum_id BIGINT REFERENCES working_curricula (id) ON DELETE SET NULL
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
