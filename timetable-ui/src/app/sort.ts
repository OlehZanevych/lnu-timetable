/**
 * Ukrainian-aware string ordering, used for every alphabetical sort in the UI.
 *
 * `String.prototype.localeCompare(b)` with no locale uses the *browser's* locale, so the same list
 * comes out ordered differently for a user running an English UI than a Ukrainian one — and the
 * English ordering is wrong for Ukrainian text (it sorts Ґ before Г, where Ukrainian puts it
 * after). Pinning the locale here keeps the order identical for everyone, and matches how the
 * database sorts: schema.sql declares the same alphabet on the text columns via COLLATE ukrainian.
 *
 * A shared Intl.Collator is also markedly faster than calling localeCompare per comparison, which
 * matters on the larger lists (a specialty can have 200+ courses).
 */
const collator = new Intl.Collator('uk');

/** Compares two strings by Ukrainian alphabet; null/undefined sort as empty. */
export const compareUk = (a: string | null | undefined, b: string | null | undefined): number =>
  collator.compare(a ?? '', b ?? '');
