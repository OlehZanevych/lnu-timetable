-- Renames `specialties` to `degree_programs`, and every column, constraint, index and sequence
-- named after it, to `degree_program`.
--
-- The entity was misnamed. A спеціальність is the broader thing — a code and a name in the
-- national classifier, 122 «Комп'ютерні науки» — and a university may run several освітні програми
-- under one of them. What this table actually holds, and what every curriculum in
-- `curriculum_items` is written against, is the освітня програма: `code` still records the
-- specialty the programme sits under, but the row is the programme. Everything downstream — the
-- групи enrolled in it, its навчальний план, the навантаження and the розклад derived
-- from that plan — hangs off the programme, so calling it a specialty made the one join everybody
-- reads say the wrong thing.
--
-- Also rewrites the `permissions.resource_type` value, which is the entity's simple name in
-- UPPER_SNAKE_CASE and is derived from the class at startup (EntityMetadataRegistry). Renaming the
-- class to DegreeProgram changes what the service looks for; a grant left saying 'SPECIALTY' would
-- match nothing and would silently stop working — a deanery would lose access to its programmes
-- with no error anywhere.
--
-- Idempotent, as every migration here has to be: `reset_db.sh` re-applies schema.sql (which already
-- creates `degree_programs`) and then re-runs this. Every step is guarded on the old name still
-- being present, so a second run finds nothing to do.

-- ---------------------------------------------------------------- tables

ALTER TABLE IF EXISTS specialties RENAME TO degree_programs;
ALTER TABLE IF EXISTS course_specialties RENAME TO course_degree_programs;

-- ---------------------------------------------------------------- columns
--
-- There is no ALTER TABLE ... RENAME COLUMN IF EXISTS, so each is guarded on information_schema.

DO
$$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'academic_groups'
                     AND column_name = 'specialty_id') THEN
            ALTER TABLE academic_groups RENAME COLUMN specialty_id TO degree_program_id;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'course_degree_programs'
                     AND column_name = 'specialty_id') THEN
            ALTER TABLE course_degree_programs RENAME COLUMN specialty_id TO degree_program_id;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'curriculum_items'
                     AND column_name = 'specialty_id') THEN
            ALTER TABLE curriculum_items RENAME COLUMN specialty_id TO degree_program_id;
        END IF;
    END
$$;

-- ------------------------------------------------------- constraints & indexes
--
-- Neither the table rename nor the column renames touch these: a database carried forward would
-- otherwise keep constraints called `specialties_pkey` and `curriculum_items_specialty_id_fkey`
-- while a database freshly built from schema.sql calls them `degree_programs_pkey` and
-- `curriculum_items_degree_program_id_fkey`. Renaming a PRIMARY KEY or UNIQUE constraint renames
-- its backing index with it, so the indexes need no separate statement.

DO
$$
    DECLARE
        renames CONSTANT TEXT[][] := ARRAY [
            ['degree_programs', 'specialties_pkey', 'degree_programs_pkey'],
            ['degree_programs', 'specialties_name_degree_key', 'degree_programs_name_degree_key'],
            ['degree_programs', 'specialties_faculty_id_fkey', 'degree_programs_faculty_id_fkey'],
            ['course_degree_programs', 'course_specialties_pkey', 'course_degree_programs_pkey'],
            ['course_degree_programs', 'course_specialties_course_id_fkey', 'course_degree_programs_course_id_fkey'],
            ['course_degree_programs', 'course_specialties_specialty_id_fkey', 'course_degree_programs_degree_program_id_fkey'],
            ['academic_groups', 'academic_groups_specialty_id_fkey', 'academic_groups_degree_program_id_fkey'],
            ['curriculum_items', 'curriculum_items_specialty_id_fkey', 'curriculum_items_degree_program_id_fkey'],
            ['curriculum_items', 'curriculum_items_course_id_specialty_id_semester_key', 'curriculum_items_course_id_degree_program_id_semester_key']
            ];
        i       INTEGER;
    BEGIN
        FOR i IN 1 .. array_length(renames, 1)
            LOOP
                IF EXISTS (SELECT 1
                           FROM pg_constraint
                           WHERE conname = renames[i][2]
                             AND conrelid = to_regclass('public.' || renames[i][1])) THEN
                    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
                                   renames[i][1], renames[i][2], renames[i][3]);
                END IF;
            END LOOP;
    END
$$;

-- ---------------------------------------------------------------- sequence

ALTER SEQUENCE IF EXISTS specialties_id_seq RENAME TO degree_programs_id_seq;

-- ---------------------------------------------------------------- permission grants

UPDATE permissions
SET resource_type = 'DEGREE_PROGRAM',
    updated_at    = now()
WHERE resource_type = 'SPECIALTY';
