-- Where a class is held, when the answer is not a room.
--
-- Until now a lecturer_workloads row had one way to answer that: a set of eligible rooms, named
-- directly or through room groups, out of which the scheduler picked one and wrote it onto every
-- timetable_entries row. Two kinds of class have never fitted that.
--
-- **Physical education**, and anything like it. «Спортивні зали» is one line on the розклад, and
-- the groups of half a faculty are in it at the same hour without that being a clash at all.
-- Recording it as a rooms row is a lie the scheduler believes, because every consumer of `rooms`
-- is built on one room holding one class at a time. So `abstract_rooms` is a table of its own that
-- nothing reasoning about room exclusivity reads. An abstract room may belong to a building, and
-- then the journey to it is that building's out of `building_travel_times`, exactly as for a room;
-- or it may not, and then there is no address to measure from and the journey is one fixed figure
-- from anywhere — the `abstract_room_travel_time_minutes` property this migration seeds at 60. It
-- may declare a capacity, which unlike a room's is a ceiling on the *total* students of the classes
-- sharing it in one slot rather than on the size of any one of them.
--
-- **A class held online**, which occupies no place at all. That is `lecturer_workload_online_classes`,
-- one row per workload, whose presence is the fact; its columns only say how to attend.
--
-- Both are one-to-one with the workload, and both say so with the primary key rather than with a
-- UNIQUE beside a surrogate id: keying `lecturer_workload_abstract_rooms` on lecturer_workload_id
-- alone *is* the statement "no more than one abstract room per class", and the same for the online
-- row. Contrast `lecturer_workload_rooms`, whose PRIMARY KEY (workload, room) deliberately lets a
-- workload name many rooms.
--
-- Consequently `timetable_entries.room_id` loses its NOT NULL: a class in a shared abstract room
-- has nothing to allocate, and one held online has nowhere to be. Which of the two it is, and which
-- abstract room, is read from the workload rather than copied onto the entry — a second copy could
-- only ever disagree with the first.
--
-- The second property this seeds, `university_commute_time_minutes`, is not about a place at all.
-- It is how long it comfortably takes a student to get between home and the university, and it
-- exists because a day that mixes an online class with an in-room one needs a real gap between
-- them. The timetable generator prefers to keep online and in-room days apart entirely, and when
-- it cannot, this is the gap it must leave. 80 minutes is the seeded figure; like every other row
-- in that table it is an institutional judgement an administrator edits, not an invariant.
--
-- Written, like V2-V6, to be a no-op against a database already created from the current
-- schema.sql: reset_db.sh runs schema.sql (which has all of this in it) and Flyway replays every
-- migration over the top, so a migration that assumed the old shape would break exactly the
-- workflow used to rebuild a local database. Every statement below is therefore either
-- IF NOT EXISTS, guarded by a catalogue test, or naturally idempotent — ALTER COLUMN … DROP NOT
-- NULL succeeds silently on a column that is already nullable, and ON CONFLICT DO NOTHING leaves a
-- property an administrator has already edited exactly as they set it.

-- ---------------------------------------------------------------- the platform enum

DO
$$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'online_class_platform') THEN
            CREATE TYPE online_class_platform AS ENUM (
                'ZOOM',
                'MICROSOFT_TEAMS',
                'GOOGLE_MEET',
                'MOODLE',
                'SKYPE',
                'WEBEX',
                'BIGBLUEBUTTON',
                'OTHER'
                );
        END IF;
    END
$$;

-- ---------------------------------------------------------------- abstract rooms

CREATE TABLE IF NOT EXISTS abstract_rooms
(
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(96)  COLLATE ukrainian NOT NULL,
    purpose     VARCHAR(200) COLLATE ukrainian,
    building_id BIGINT REFERENCES buildings (id) ON DELETE SET NULL,
    faculty_id  BIGINT REFERENCES faculties (id) ON DELETE CASCADE,
    capacity    INTEGER CHECK (capacity > 0)
);

-- Unique within its scope, so a faculty may keep a «Спортивні зали» of its own beside the
-- university-wide one. COALESCE rather than NULLS NOT DISTINCT, matching room_groups_unique_name.
CREATE UNIQUE INDEX IF NOT EXISTS abstract_rooms_unique_name
    ON abstract_rooms (name, COALESCE(faculty_id, 0));

CREATE INDEX IF NOT EXISTS abstract_rooms_faculty_idx
    ON abstract_rooms (faculty_id) WHERE faculty_id IS NOT NULL;

-- ---------------------------------------------------------------- the two workload links

CREATE TABLE IF NOT EXISTS lecturer_workload_abstract_rooms
(
    lecturer_workload_id BIGINT PRIMARY KEY REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    abstract_room_id     BIGINT NOT NULL   REFERENCES abstract_rooms (id)     ON DELETE CASCADE
);

-- The primary key indexes the workload side only, and the question the capacity ceiling asks runs
-- the other way — "every class placed in this abstract room" — so that direction gets an index of
-- its own. It is the one read the generator makes per candidate placement.
CREATE INDEX IF NOT EXISTS lecturer_workload_abstract_rooms_abstract_room_idx
    ON lecturer_workload_abstract_rooms (abstract_room_id);

CREATE TABLE IF NOT EXISTS lecturer_workload_online_classes
(
    lecturer_workload_id BIGINT PRIMARY KEY REFERENCES lecturer_workloads (id) ON DELETE CASCADE,
    platform             online_class_platform,
    meeting_url          VARCHAR(512),
    note                 VARCHAR(200) COLLATE ukrainian
);

-- ---------------------------------------------------------------- a class need not have a room

-- No IF NOT EXISTS to guard: dropping a NOT NULL that is not there is not an error, so this is
-- already a no-op on a database whose schema.sql wrote the column nullable in the first place.
ALTER TABLE timetable_entries
    ALTER COLUMN room_id DROP NOT NULL;

-- ---------------------------------------------------------------- the two new properties

-- ON CONFLICT DO NOTHING rather than an UPDATE: these are institutional figures, and an
-- administrator who has already moved one away from the seeded value means it. A blank value is
-- meaningful too — it reads as «не встановлено» and the client drops the rule that rests on it —
-- so this must not "repair" one either.
INSERT INTO global_properties (name, type, value)
VALUES ('abstract_room_travel_time_minutes', 'INTEGER', '60'),
       ('university_commute_time_minutes', 'INTEGER', '80')
ON CONFLICT (name) DO NOTHING;
