-- Access levels on permission grants.
--
-- Before this migration a row in `permissions` was a single boolean fact: "this grantee may modify
-- this resource and everything under it", where "modify" meant update, delete and create-children
-- all at once, and — because the delegation check was literally the same check — also grant and
-- revoke access to the same scope. That is one indivisible bundle, so there was no way to say
-- "maintain the навантаження of this кафедра but never delete anything", and no way to hand a
-- deputy the right to edit without also handing them the right to give that right away.
--
-- This splits the bundle into three ordered levels, EDIT < FULL < MANAGE:
--
--   EDIT   — create and update within the scope; no deletes.
--   FULL   — EDIT plus delete.
--   MANAGE — FULL plus granting/revoking access to this resource and its descendants.
--
-- Backfill: every existing grant becomes MANAGE. That is not the "safest" value, it is the
-- *faithful* one — MANAGE is exactly what an old row already permitted, so nobody loses access on
-- the morning this ships. Narrowing existing grants is a decision for whoever administers them,
-- and the new UI makes it a two-click change; silently demoting live grants here would instead
-- present itself as the application breaking.
--
-- Also adds updated_at, since a grant is now a mutable row (re-granting the same scope at a
-- different level is an UPDATE of `level`, not a second row).

-- Written to be a no-op against a database already created from the current schema.sql, the same
-- way V2-V4 are: reset_db.sh runs schema.sql (which has `level` in it) and Flyway then baselines at
-- version 0 and replays every migration over the top, so a migration that assumed the old shape
-- would break exactly the workflow used to rebuild a local database.

DO
$$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'access_level') THEN
            CREATE TYPE access_level AS ENUM ('EDIT', 'FULL', 'MANAGE');
        END IF;
    END
$$;

ALTER TABLE permissions
    ADD COLUMN IF NOT EXISTS level access_level;

-- Only ever touches rows the ADD COLUMN above just created: on a database that already had `level`,
-- every row has one and this matches nothing.
UPDATE permissions
SET level = 'MANAGE'
WHERE level IS NULL;

ALTER TABLE permissions
    ALTER COLUMN level SET NOT NULL;

ALTER TABLE permissions
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT now();
