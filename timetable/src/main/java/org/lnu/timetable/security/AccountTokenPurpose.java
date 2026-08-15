package org.lnu.timetable.security;

/**
 * What a one-time link in {@code account_tokens} is for — mirroring the {@code
 * account_token_purpose} PostgreSQL enum, in the same one-to-one way {@link AccessLevel} mirrors
 * {@code access_level}.
 *
 * <p>Two purposes, one table, because the two links are the same object in every respect that
 * matters: thirty minutes long, stored as a hash, spent once, and invalidating whatever was
 * outstanding before them. What differs is only which column names the subject — a person who has
 * no account yet, or an account whose owner has forgotten how to open it — and that is a CHECK
 * constraint rather than a second table.
 */
public enum AccountTokenPurpose {

    /** A викладач or a студент, entered by the institution, creating the account that is theirs. */
    REGISTRATION,

    /** An existing account replacing a password nobody can remember. */
    PASSWORD_RESET
}
