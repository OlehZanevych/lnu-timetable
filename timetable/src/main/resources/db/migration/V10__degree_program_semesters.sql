-- How long a programme runs, and how long each of its semesters runs.
--
-- The number of weekly classes a розклад has to place for a plan position is
-- hours ÷ (weeks × class length), and the weeks in that division come from the
-- `semester_duration_weeks` global property — one number for the whole university. That holds for
-- most of a degree and stops holding at the end of one: the last semester of a master's programme is
-- largely taken up by the final attestation and a work placement, so its teaching runs for fewer
-- weeks than the property claims, and planning it as sixteen puts fewer classes a week on the
-- timetable than the plan's hours require.
--
-- Two things are added. `degree_programs.duration_semesters` says how long the programme is, in
-- semesters. `degree_program_semesters` overrides the global property for one semester of one
-- programme, and only where it differs — a missing row means «the usual length», which is what the
-- global property is for, and filling the table in exhaustively would turn one correctable number
-- into several hundred copies of it that cannot be corrected in one place.
--
-- The new column is NOT NULL, which cannot be done in one statement against a table that already
-- holds rows: the column arrives nullable, every existing row is given a value, and only then is
-- the constraint added. That is the whole reason this migration has three steps where the schema
-- has one line.
--
-- Idempotent, as every migration here has to be: `reset_db.sh` re-applies schema.sql (which already
-- creates all of this, with the column already NOT NULL) and then re-runs the migrations over the
-- top, so each step is guarded on the object not already being there. Step 2 is guarded by its own
-- `WHERE duration_semesters IS NULL`, which matches nothing on such a database; step 3 is a no-op
-- on a column that is already NOT NULL.

-- ---------------------------------------------------------------- 1. the column, nullable

ALTER TABLE degree_programs
    ADD COLUMN IF NOT EXISTS duration_semesters INTEGER;

-- ---------------------------------------------------------------- 2. a value for every row
--
-- The two lengths that exist in this university's data: a bachelor's programme runs four years and a
-- master's two, both counted in semesters of teaching. Nothing here reads the programme's own curriculum
-- to infer its length, and deliberately so — a plan may be incomplete, and a programme whose plan
-- has only been entered up to the fifth semester is still a four-year programme.
--
-- The other three degrees are named explicitly rather than left to an ELSE, because a NULL here
-- would stop step 3 with a constraint violation and nothing else would say why. None of them
-- appears in the current data; the numbers are the ordinary lengths, and a database that does hold
-- one of them should be corrected on the programme's own page rather than trusted from here. A
-- DOCTOR_OF_SCIENCE programme has no taught semesters at all in the sense this column means, so it
-- takes the same eight as a PhD purely so that the column can be NOT NULL.
--
-- `WHERE duration_semesters IS NULL` is what makes this safe to re-run: a value already entered —
-- by a previous run, or by somebody correcting a programme afterwards — is never overwritten.

UPDATE degree_programs
SET duration_semesters = CASE degree
                             WHEN 'JUNIOR_BACHELOR' THEN 4
                             WHEN 'BACHELOR' THEN 8
                             WHEN 'MASTER' THEN 4
                             WHEN 'PHD' THEN 8
                             WHEN 'DOCTOR_OF_SCIENCE' THEN 8
                             END
WHERE duration_semesters IS NULL;

-- ---------------------------------------------------------------- 3. now it can be required

ALTER TABLE degree_programs
    ALTER COLUMN duration_semesters SET NOT NULL;

DO
$$
    BEGIN
        IF NOT EXISTS (SELECT 1
                       FROM pg_constraint
                       WHERE conrelid = 'degree_programs'::regclass
                         AND conname = 'degree_programs_duration_semesters_check') THEN
            ALTER TABLE degree_programs
                ADD CONSTRAINT degree_programs_duration_semesters_check CHECK (duration_semesters > 0);
        END IF;
    END
$$;

-- ---------------------------------------------------------------- 4. per-semester lengths
--
-- `semester` is the number the plan itself uses — the same value `curriculum_items.semester` carries
-- for this programme — because lining the two up is the entire purpose of the row. That numbering is
-- the programme's own and is not necessarily 1-based: a master's programme whose plan runs 9, 10, 11
-- states 9, 10, 11 here, not 1, 2, 3, and the current data holds programmes of both kinds.
--
-- It is bounded below but not above. A CHECK cannot read `degree_programs.duration_semesters` from
-- here, so a row naming a semester the programme does not have is accepted by the database and means
-- nothing: no curriculum item carries that semester, so nothing is ever planned against it.

CREATE TABLE IF NOT EXISTS degree_program_semesters
(
    id                BIGSERIAL PRIMARY KEY,
    degree_program_id BIGINT  NOT NULL REFERENCES degree_programs (id) ON DELETE CASCADE,
    semester          INTEGER NOT NULL CHECK (semester > 0),
    -- Teaching weeks, replacing `semester_duration_weeks` for this one semester of this one
    -- programme. Whole weeks, and greater than zero: a semester with no teaching weeks would make
    -- the division above undefined rather than describing a semester anybody has.
    duration_weeks    INTEGER NOT NULL CHECK (duration_weeks > 0),
    -- A programme states each of its semesters' length at most once; re-stating it is an update of
    -- this row rather than a second row meaning the same thing.
    UNIQUE (degree_program_id, semester)
);

COMMENT ON TABLE degree_program_semesters IS
    'Per-semester override of the semester_duration_weeks global property, for one degree programme. A semester with no row here runs for the global number of weeks.';
