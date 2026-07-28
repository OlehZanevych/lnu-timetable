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
    min_hours_per_week   INTEGER,
    max_hours_per_week   INTEGER,
    department_id        BIGINT NOT NULL REFERENCES departments (id) ON DELETE CASCADE
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
