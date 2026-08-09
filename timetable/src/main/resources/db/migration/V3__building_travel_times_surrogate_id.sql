-- A surrogate key for building_travel_times.
--
-- V2 gave the table the natural primary key, (from_building_id, to_building_id), which is what the
-- data actually is. The entity framework cannot address a row that way: `findById`, the update and
-- delete mutations and the permission cascade all take one `id`, and there is nowhere in that for a
-- pair. Every other table in this schema carries a BIGSERIAL for the same reason.
--
-- The pair remains the real identity — it just moves from PRIMARY KEY to UNIQUE, which enforces
-- exactly as much and leaves the surrogate to the machinery. Nothing about the rows changes.
--
-- Written as a separate migration rather than by editing V2, because V2 may already have run: an
-- applied migration is immutable, and Flyway refuses to start when one changes underneath it.
--
-- One cosmetic difference survives, and it is worth knowing about rather than discovering: a
-- database built from today's schema.sql has `id` as its first column, while one migrated here has
-- it appended last, because ALTER TABLE ADD COLUMN can only append. Constraints, types, defaults
-- and the sequence are identical — verified by diffing `\d building_travel_times` between a
-- database built each way — and everything reads columns by name, so nothing depends on it.

ALTER TABLE building_travel_times
    DROP CONSTRAINT IF EXISTS building_travel_times_pkey;

ALTER TABLE building_travel_times
    ADD COLUMN IF NOT EXISTS id BIGSERIAL;

-- Two separate statements: the column has to exist before it can be made the key, and both are
-- guarded so that a database built from the current schema.sql — where the table already has all
-- of this — passes through unchanged.
DO
$$
    BEGIN
        IF NOT EXISTS (SELECT 1
                       FROM pg_constraint
                       WHERE conrelid = 'building_travel_times'::regclass
                         AND contype = 'p') THEN
            ALTER TABLE building_travel_times ADD PRIMARY KEY (id);
        END IF;

        IF NOT EXISTS (SELECT 1
                       FROM pg_constraint
                       WHERE conrelid = 'building_travel_times'::regclass
                         AND contype = 'u') THEN
            ALTER TABLE building_travel_times
                ADD CONSTRAINT building_travel_times_from_building_id_to_building_id_key
                    UNIQUE (from_building_id, to_building_id);
        END IF;
    END
$$;
