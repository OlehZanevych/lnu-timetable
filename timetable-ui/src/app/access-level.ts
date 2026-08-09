/**
 * The three access levels a permission grant can carry, mirroring the backend's
 * `org.lnu.timetable.security.AccessLevel` and the `access_level` PostgreSQL enum.
 *
 * They are *ordered*, and every permission question in the client reduces to one comparison:
 * editing needs `EDIT`, deleting needs `FULL`, handing access to somebody else needs `MANAGE`.
 * Keeping it a chain rather than a set of independent flags is what keeps the UI honest — there is
 * one dropdown to grant access, one word to read back, and no combination anybody has to reason
 * about that doesn't exist.
 */
export type AccessLevel = 'EDIT' | 'FULL' | 'MANAGE';

/** Weakest first — the order the grant form offers them in. */
export const ACCESS_LEVELS: readonly AccessLevel[] = ['EDIT', 'FULL', 'MANAGE'];

const RANK: Record<AccessLevel, number> = { EDIT: 0, FULL: 1, MANAGE: 2 };

/** Does `held` (absent means no access at all) satisfy a requirement of `required`? */
export function allows(held: AccessLevel | null | undefined, required: AccessLevel): boolean {
  return held != null && RANK[held] >= RANK[required];
}

/** The stronger of two levels; either may be absent. */
export function maxLevel(a: AccessLevel | null | undefined, b: AccessLevel | null | undefined): AccessLevel | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

export const ACCESS_LEVEL_LABELS: Record<AccessLevel, string> = {
  EDIT: 'Редагування',
  FULL: 'Повний доступ',
  MANAGE: 'Керування доступом'
};

/** The one-line explanation shown beside each option in the grant form. */
export const ACCESS_LEVEL_HINTS: Record<AccessLevel, string> = {
  EDIT: 'Створення та редагування цього ресурсу й усього, що йому підпорядковане. Без видалення.',
  FULL: 'Те саме, що «Редагування», а також видалення.',
  MANAGE: 'Те саме, що «Повний доступ», а також надання доступу іншим до цього ресурсу та підпорядкованих йому.'
};
