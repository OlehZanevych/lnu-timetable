-- Adds `account_tokens` — the one-time links behind self-service registration and password
-- recovery (see the service README's *Self-service registration*). A викладач or a студент whose
-- e-mail is already on their own row can create an account by following a link sent to it, and an
-- account that has forgotten its password can replace it the same way. Both links live thirty
-- minutes, are stored only as a SHA-256, and are spent once.
--
-- Nothing existing changes: no column is added to `users`, no grant is touched, and an account
-- created through a link is indistinguishable from one an administrator created except that it has
-- never needed `must_change_password`.
--
-- Idempotent, as every migration here has to be: `reset_db.sh` re-applies schema.sql (which already
-- creates all of this) and then re-runs the migrations, so each step is guarded on the object not
-- being there yet.

-- ---------------------------------------------------------------- enum
--
-- There is no CREATE TYPE ... IF NOT EXISTS, so the guard is explicit.

DO
$$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_token_purpose') THEN
            CREATE TYPE account_token_purpose AS ENUM ('REGISTRATION', 'PASSWORD_RESET');
        END IF;
    END
$$;

-- ---------------------------------------------------------------- table

CREATE TABLE IF NOT EXISTS account_tokens
(
    id          BIGSERIAL PRIMARY KEY,
    purpose     account_token_purpose NOT NULL,
    -- SHA-256 of the token carried in the link, lowercase hex. The plaintext is never stored: a
    -- link is a bearer credential, and a dump of this table must not be a set of working ones.
    token_hash  CHAR(64)              NOT NULL UNIQUE,
    -- The address the link was sent to, so a token cannot be redeemed against a person whose
    -- e-mail has since been changed to somebody else's.
    email       VARCHAR(255)          NOT NULL,
    -- Exactly one of the three is set, and which one follows from `purpose`.
    lecturer_id BIGINT REFERENCES lecturers (id) ON DELETE CASCADE,
    student_id  BIGINT REFERENCES students (id) ON DELETE CASCADE,
    user_id     BIGINT REFERENCES users (id) ON DELETE CASCADE,
    expires_at  TIMESTAMP             NOT NULL,
    used_at     TIMESTAMP,
    created_at  TIMESTAMP             NOT NULL DEFAULT now(),
    CONSTRAINT account_tokens_subject_check CHECK (
        (purpose = 'REGISTRATION' AND user_id IS NULL
            AND ((lecturer_id IS NULL) <> (student_id IS NULL))) OR
        (purpose = 'PASSWORD_RESET' AND user_id IS NOT NULL
            AND lecturer_id IS NULL AND student_id IS NULL)
    )
);

-- ---------------------------------------------------------------- indexes

CREATE INDEX IF NOT EXISTS account_tokens_recent_idx
    ON account_tokens (lower(email), purpose, created_at DESC);

-- `users.email` is UNIQUE, but case-sensitively, while every lookup in the service is
-- `lower(email) = lower(:email)`. Two accounts differing only in capitalisation are therefore rows
-- the column constraint permits and no code path can tell apart — the duplicate check before a new
-- account sees neither, and `login` finds two rows where it expects one. Self-service registration
-- is the first unauthenticated path that could create such a row, so the rule is stated here.
--
-- If this statement fails, it has found that pair rather than caused it: the database already holds
-- two accounts for one mailbox, at least one of which cannot sign in. Decide which is the real one,
-- move or delete the other, and re-run.
CREATE UNIQUE INDEX IF NOT EXISTS users_unique_lower_email ON users (lower(email));
