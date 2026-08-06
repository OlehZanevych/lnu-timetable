-- Link a user account to the person it belongs to.
--
-- `users` gained two optional, mutually exclusive foreign keys: `lecturer_id` (the викладач this
-- account is) and `student_id` (the студент). Most accounts — deanery staff, the administrator —
-- are neither, so both are nullable and the "at most one" rule is a CHECK rather than a
-- discriminator column. The link is an identity, not a role: permissions still come entirely from
-- `permissions`, and this only decides whose навантаження / навчальний план / розклад «Мій кабінет»
-- shows. See `schema.sql` for the same definition in full, with its comments.
--
-- These columns are also part of `schema.sql`; this file exists so a database created before the
-- change can be brought up to date **without** re-seeding, since `schema.sql` opens with
-- `DROP SCHEMA public CASCADE` and would take the data with it. It is safe to run more than once.
--
--   psql -h localhost -U postgres -d lnu-timetable -f users-person-link.sql

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS lecturer_id BIGINT REFERENCES public.lecturers (id) ON DELETE SET NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS student_id  BIGINT REFERENCES public.students (id)  ON DELETE SET NULL;

-- A user can be a Lecturer or a Student, or neither — never both. ADD CONSTRAINT has no
-- IF NOT EXISTS, so it is guarded by the catalogue instead, which keeps this file re-runnable.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_person_link_check') THEN
        ALTER TABLE public.users
            ADD CONSTRAINT users_person_link_check CHECK (lecturer_id IS NULL OR student_id IS NULL);
    END IF;
END
$$;

-- One account per person, in the other direction.
CREATE UNIQUE INDEX IF NOT EXISTS users_unique_lecturer ON public.users (lecturer_id) WHERE lecturer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_unique_student  ON public.users (student_id)  WHERE student_id IS NOT NULL;
