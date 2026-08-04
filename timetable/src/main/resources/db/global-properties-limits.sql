-- Curriculum limits as settings rather than constants.
--
-- Every figure a навчальний план is measured against — обсяг кредиту, обсяг освітньої програми за
-- ступенем, частка вибіркових компонентів, стелі дисциплін і екзаменів у семестрі — now lives in
-- `global_properties` and is edited on «Глобальні властивості» rather than compiled into the
-- client. See timetable-ui/src/app/plan-limits.ts.
--
-- These rows are also part of `data.sql`; this file exists so a database created before the change
-- can be brought up to date without re-seeding. It is safe to run more than once: a row that is
-- already there keeps whatever value the institution has set it to.
--
--   psql -h localhost -U postgres -d lnu-timetable -f global-properties-limits.sql

INSERT INTO public.global_properties (name, type, value) VALUES
    -- Обсяг освітньої програми. `hours_per_ects_credit` is the one figure with no "unset" state:
    -- every total in both printed plans is computed from it.
    ('hours_per_ects_credit',       'INTEGER', '30'),
    ('credits_per_academic_year',   'INTEGER', '60'),
    ('credits_per_year_tolerance',  'INTEGER', '3'),

    -- Обсяг за освітніми ступенями. A degree with neither bound set is simply not checked.
    ('min_credits_junior_bachelor', 'INTEGER', '120'),
    ('max_credits_junior_bachelor', 'INTEGER', '120'),
    ('min_credits_bachelor',        'INTEGER', '180'),
    ('max_credits_bachelor',        'INTEGER', '240'),
    ('min_credits_master',          'INTEGER', '90'),
    ('max_credits_master',          'INTEGER', '120'),
    ('min_credits_phd',             'INTEGER', '30'),
    ('max_credits_phd',             'INTEGER', '60'),

    -- Обмеження навчального плану. Clearing any of these switches its check off entirely.
    ('min_elective_share_percent',  'INTEGER', '25'),
    ('max_courses_per_semester',    'INTEGER', '8'),
    ('max_exams_per_semester',      'INTEGER', '5')
ON CONFLICT (name) DO NOTHING;
