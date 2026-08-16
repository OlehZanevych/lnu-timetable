-- Adds `group_invitations` — a link that puts whoever follows it into one group.
--
-- Membership is what carries access here: a grant may name a group, and «Деканат ФПМіІ» holds
-- MANAGE on its факультет, so putting an account into a group is the act that lets that account do
-- anything at all. Until now that act was an administrator's, one account at a time, through
-- `addUserToGroup` on «Користувачі та права» — which is the right shape for handing somebody a
-- кафедра and the wrong one for the week the data has to be entered, when twenty volunteers arrive
-- at once and each of them is a separate visit to the same screen.
--
-- An invitation is that same act, delegated to the person joining. Its holder does not gain the
-- right to invite anybody else, to create an account, or to see the group's grants: following the
-- link inserts one `user_groups` row for the account already signed in, and nothing else.
--
-- ---------------------------------------------------------------- why the token is stored as it is
--
-- `account_tokens` stores only a SHA-256, because a registration link is issued to one person, sent
-- to one address and spent once — nobody ever needs to read it back, and a dump of that table must
-- not be a set of working links.
--
-- This table stores the token itself, and the difference is what an invitation is for. It is shared
-- with a room full of people rather than sent to one, over days rather than minutes, and the person
-- who created it has to be able to open «Посилання-запрошення» a week later and paste the same link
-- into a second chat. A hash cannot be un-hashed to do that; hashing here would mean either «shown
-- once, then never again» or a new link per re-share, and both make the list a worse answer to the
-- question the list exists for.
--
-- So this table holds live bearer credentials, and that is bounded rather than denied. Three things
-- bound it: every invitation expires (`expires_at`, and no row may outlive thirty days), every
-- invitation can be deleted the moment it has done its work, and what redeeming one gets you is
-- membership of one group — never an account, never a grant, never the right to invite. The rest is
-- the ordinary care any credential column needs: this table is not in any `SELECT` the entity
-- framework can reach, and it is read only by callers who may already administer the group.

-- ---------------------------------------------------------------- table

CREATE TABLE IF NOT EXISTS group_invitations
(
    id         BIGSERIAL PRIMARY KEY,
    group_id   BIGINT      NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    -- 32 bytes from SecureRandom, base64url — 43 characters, no dot, which is what keeps
    -- FrontendController's `[^.]*` route patterns serving the page that carries it.
    token      VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP   NOT NULL,
    -- How many accounts have joined through this link. A counter rather than a table of redemptions:
    -- who is in the group is already `user_groups`, and this only answers «did anyone actually use
    -- the link I sent» — which is the question asked when deciding whether to delete it.
    join_count INTEGER     NOT NULL DEFAULT 0,
    -- Kept when the account that made the invitation is deleted, for the same reason
    -- `permissions.granted_by` is: who opened a door is worth knowing after they have left.
    created_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMP   NOT NULL DEFAULT now(),
    -- The lifetime the product asks for, said here rather than only in the mutation that writes it:
    -- at least five minutes, at most thirty days. A link is a credential, and a client that forgets
    -- to validate its own form must not be able to write one that outlives the term it was made for.
    CONSTRAINT group_invitations_lifetime_check CHECK (
        expires_at >= created_at + INTERVAL '5 minutes' AND
        expires_at <= created_at + INTERVAL '30 days'
    )
);

-- ---------------------------------------------------------------- indexes
--
-- `token` is UNIQUE, which is the index the redemption path looks the link up by. This one is the
-- other question: every invitation of one group, newest first — what «Посилання-запрошення» lists.

CREATE INDEX IF NOT EXISTS group_invitations_group_idx
    ON group_invitations (group_id, created_at DESC);
