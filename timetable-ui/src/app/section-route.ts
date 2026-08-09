import { DestroyRef, Signal, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

/**
 * The tab of a drill-down page, in the address bar.
 *
 * Every tabbed page — `/faculty/:id`, `/department/:id`, `/course/:id`, `/me`, … — used to keep the
 * open tab in a component signal, which meant «Кафедри» and «Аудиторії» were the same URL as
 * «Інформація». That URL could not be bookmarked, sent to a colleague, reloaded, or reached with the
 * browser's Back button: everything led back to the first tab. Here the tab is a route parameter
 * instead, so the address bar names the screen actually on display and the router owns the state.
 *
 * The section *key* stays camelCase, because it is a TypeScript union the templates switch on; the
 * *slug* in the URL is the kebab-case of it, because that is what a path segment reads like —
 * `roomAssignment` is `/faculty/3/room-assignment`. `kebabCase` is the only place the two forms
 * meet, so no page has to carry a second table of names.
 *
 * The same rule turns an entity's GraphQL singular into its table's path — `roomGroup` into
 * `/room-group` (see `app.routes.ts`) — which is why the function is general and not called
 * `sectionSlug`: there is one convention for identifiers in this app's URLs, not two.
 */
export function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

export interface SectionNav<T extends string> {
  /**
   * The section on screen: whichever key the URL's slug names, or `fallback()` when it names none
   * this page has. A tab that exists only sometimes — «Вибіркові дисципліни», which belongs to an
   * `ELECTIVE_GROUP` alone — therefore degrades to the fallback rather than leaving `@switch`
   * matching no case at all, which is a blank page rather than an error.
   */
  readonly active: Signal<T>;

  /** Open `key`. Navigation is the only way the section changes, so Back and Forward work too. */
  select(key: T): void;
}

/**
 * Bind a page's section to its `:section` route parameter. Call it from a field initialiser, which
 * is an injection context.
 *
 * @param base    the page's own path, without the section — `['/faculty', this.facultyId]`
 * @param keys    the sections this page has *right now*; may be a computed that grows or shrinks
 * @param fallback which one an unknown or absent slug means
 *
 * Reading the parameter rather than the snapshot matters: `/faculty/3/departments` and
 * `/faculty/3/rooms` are the same route configuration, so the router reuses the component instance
 * and only the parameters change. The page is built once and its queries run once, exactly as when
 * the tab was a signal.
 */
export function sectionNav<T extends string>(
  base: () => (string | number)[],
  keys: () => readonly T[],
  fallback: () => T
): SectionNav<T> {
  const router = inject(Router);
  const route = inject(ActivatedRoute);

  const slug = signal<string | null>(route.snapshot.paramMap.get('section'));
  const sub = route.paramMap.subscribe((params) => slug.set(params.get('section')));
  inject(DestroyRef).onDestroy(() => sub.unsubscribe());

  const active = computed<T>(() => {
    const current = slug();
    return keys().find((key) => kebabCase(key) === current) ?? fallback();
  });

  return {
    active,
    select: (key: T) => { void router.navigate([...base(), kebabCase(key)]); }
  };
}
