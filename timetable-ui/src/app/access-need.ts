import { AccessLevel, ACCESS_LEVEL_LABELS } from './access-level';

/**
 * What a screen, a tab or a button needs before it is worth drawing.
 *
 * Every permission question in this client used to be asked in the component that had it, in whatever
 * shape that component found convenient — `isAdmin()` here, «holds any grant at all» there, an
 * `accessLevel()` call and two computed signals somewhere else, and nothing whatsoever in the fifteen
 * components that never asked. Stating the requirement as a value instead of as code is what lets one
 * place answer all of them, and what lets a sidebar link and the page it leads to be gated by the
 * same expression rather than by two that agree until one is edited.
 *
 * Three shapes, and the third is the one that did not exist before:
 *
 * - **a row** — `{ type: 'FACULTY', id: '3' }`: the caller's level on that faculty, or on anything
 *   above it. This is what a page about one thing asks.
 * - **university-wide** — `{ type: GLOBAL }`: `global_properties` and nothing else belongs to no
 *   entity, so no grant cascades into it.
 * - **anywhere of a kind** — `{ type: 'CLASS_START_TIME_SET' }` with no id: could this caller create
 *   one of these *somewhere*? Answered from `CurrentUser.creatableResourceTypes`, which the service
 *   computes from the same `@PermissionParent` graph it authorizes the write with. A screen whose
 *   whole purpose is to add rows has no id to ask about until it has already been opened.
 *
 * A need is a convenience, never the boundary: every mutation behind every control this hides is
 * re-checked server-side, against the row rather than the type. Hiding the control only spares the
 * user a request that was always going to come back «requires EDIT access».
 */
export interface AccessNeed {
  /** A `permissions.resource_type` value (see `resource-type.ts`), or {@link GLOBAL_RESOURCE_TYPE}. */
  type: string;
  /**
   * The row being asked about. Omitted for a university-wide need, and for an "anywhere of a kind"
   * need — the two cases that have no row.
   */
  id?: string | null;
  /** Defaults to `EDIT`: the level that opens create and update, which is what most screens are for. */
  level?: AccessLevel;
}

/** The scope that belongs to no entity — a university-wide grant, `resource_id IS NULL`. */
export const GLOBAL_RESOURCE_TYPE = 'GLOBAL';

/** `{ type: 'FACULTY', id }` — the caller's level on one row, or on any ancestor of it. */
export function rowNeed(type: string, id: string | null | undefined, level: AccessLevel = 'EDIT'): AccessNeed {
  return { type, id: id ?? null, level };
}

/** `{ type: GLOBAL }` — university-wide settings, which no grant on any entity reaches. */
export function globalNeed(level: AccessLevel = 'EDIT'): AccessNeed {
  return { type: GLOBAL_RESOURCE_TYPE, level };
}

/** «may create one of these somewhere» — the question a table of nothing but rows to add asks. */
export function anywhereNeed(type: string): AccessNeed {
  return { type, level: 'EDIT' };
}

/** Whether this need is about a row rather than about a kind of thing or the whole university. */
export function isRowNeed(need: AccessNeed): boolean {
  return need.type !== GLOBAL_RESOURCE_TYPE && need.id != null && need.id !== '';
}

/**
 * The sentence «Немає доступу» prints under its heading. It names the level rather than only refusing,
 * for the same reason the service's denial message does: somebody holding «Редагування» who is looking
 * at a screen that needs «Повний доступ» learns what to ask their deanery for, instead of guessing
 * whether they are in the wrong place entirely.
 */
export function describeNeed(need: AccessNeed): string {
  const level = ACCESS_LEVEL_LABELS[need.level ?? 'EDIT'];
  if (need.type === GLOBAL_RESOURCE_TYPE) {
    return `Цей розділ змінює загальносистемні налаштування, тому потребує рівня «${level}» для всієї системи.`;
  }
  return `Цей розділ потребує рівня доступу «${level}» до відповідних даних.`;
}
