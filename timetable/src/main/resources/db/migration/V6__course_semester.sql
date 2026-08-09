-- A discipline that belongs to one particular semester.
--
-- `curriculum_items` already records the semester a discipline is studied in, and that is the right
-- place for it: the same course can be a second-semester component of one programme and a fourth-
-- semester one of another. But a few disciplines are not like that. A група вибіркових
-- (`course_type = 'ELECTIVE_GROUP'`) exists precisely to reserve one slot, in one semester, that a
-- student fills with one of its children — «Вибіркова дисципліна 5» is a name that only means
-- anything in the fifth semester, and a plan position putting it in the sixth is an error nobody
-- notices until the розклад is built around it.
--
-- `courses.semester` is where that fact is written down. NULL — every course, until somebody says
-- otherwise — means unrestricted, and nothing changes. A value means: this discipline may only be
-- planned for that semester. The client enforces it on both curriculum screens, offering no other
-- value, and prints it before the course's tags wherever a course is named:
--
--     Вибіркова дисципліна 5 (семестр 5, англійською)
--
-- Nothing in the database enforces the agreement between this column and
-- `curriculum_items.semester`, deliberately: the service stores and serves, and a constraint here
-- would reject a plan that was legal when it was written the moment somebody restricts a course
-- that is already in use. Setting the column on a discipline that already has positions in other
-- semesters leaves them exactly as they are, to be corrected on the screen that now flags them.
--
-- Written, like V2-V5, to be a no-op against a database already created from the current
-- schema.sql: reset_db.sh runs schema.sql (which has the column in it) and Flyway then baselines at
-- version 0 and replays every migration over the top, so a migration that assumed the old shape
-- would break exactly the workflow used to rebuild a local database. `ADD COLUMN IF NOT EXISTS`
-- carries the column, and the constraint is added only when it is absent, since there is no
-- `ADD CONSTRAINT IF NOT EXISTS`.

ALTER TABLE courses
    ADD COLUMN IF NOT EXISTS semester INTEGER;

DO
$$
    BEGIN
        IF NOT EXISTS (SELECT 1
                       FROM pg_constraint
                       WHERE conrelid = 'courses'::regclass
                         AND conname = 'courses_semester_check') THEN
            ALTER TABLE courses
                ADD CONSTRAINT courses_semester_check CHECK (semester IS NULL OR semester > 0);
        END IF;
    END
$$;
