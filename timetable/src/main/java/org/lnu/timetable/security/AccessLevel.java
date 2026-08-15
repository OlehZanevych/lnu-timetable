package org.lnu.timetable.security;

/**
 * How much a permission grant lets its holder do inside the scope it names. Three values, ordered
 * from least to most, mirroring the {@code access_level} PostgreSQL enum in {@code schema.sql}
 * (declaration order is comparison order there too, so {@code level >= 'FULL'} means the same thing
 * in SQL as {@link #allows(AccessLevel)} does here).
 * <p>
 * The reason this is one ordered dimension rather than a set of independent flags — "may update",
 * "may delete", "may delegate" — is that every combination anybody actually asked for is a prefix
 * of this chain. Nobody at the university wants a person who can delete a кафедра but not rename
 * it, or hand out access they do not themselves have. Keeping it ordered means every authorization
 * question in the service reduces to a single comparison, the admin UI is one dropdown instead of
 * a matrix of checkboxes, and "who can do what here" is answerable by reading one word.
 *
 * @see PermissionService
 */
public enum AccessLevel {

    /**
     * Create and update this resource and everything below it in the cascade; no deletes, no
     * delegation. The everyday level — a методист maintaining навчальні плани and навантаження who
     * must not be able to erase a група by mis-clicking.
     */
    EDIT("Редагування"),

    /**
     * Everything {@link #EDIT} allows, plus deleting. Separate from EDIT because deletion in this
     * schema cascades: removing a DegreeProgram takes its academic groups, curriculum items and
     * workloads with it, so it is a qualitatively different act from editing a field.
     */
    FULL("Повний доступ"),

    /**
     * Everything {@link #FULL} allows, plus granting and revoking access to this resource and its
     * descendants, at any level up to MANAGE itself. This is the delegation level: a деканат holding
     * MANAGE on their факультет can hand out EDIT on individual кафедри without an administrator
     * being involved, and can promote a deputy to MANAGE of a single кафедра.
     */
    MANAGE("Керування доступом");

    private final String label;

    AccessLevel(String label) {
        this.label = label;
    }

    /** Ukrainian name shown in the administration UI. */
    public String label() {
        return label;
    }

    /** Does holding this level satisfy a requirement of {@code required}? */
    public boolean allows(AccessLevel required) {
        return this.ordinal() >= required.ordinal();
    }

    /** The higher of two levels; either may be null, meaning "no access at all". */
    public static AccessLevel max(AccessLevel a, AccessLevel b) {
        if (a == null) return b;
        if (b == null) return a;
        return a.ordinal() >= b.ordinal() ? a : b;
    }

    /** Whether {@code held} (possibly null, meaning no grant) satisfies {@code required}. */
    public static boolean allows(AccessLevel held, AccessLevel required) {
        return held != null && held.allows(required);
    }

    /** Parses a level name, tolerating case and returning null for anything unrecognised. */
    public static AccessLevel parse(Object raw) {
        if (raw == null) return null;
        String name = raw.toString().trim().toUpperCase();
        for (AccessLevel level : values()) {
            if (level.name().equals(name)) return level;
        }
        return null;
    }
}
