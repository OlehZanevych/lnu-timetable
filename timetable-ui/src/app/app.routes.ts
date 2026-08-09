import { inject, isDevMode } from '@angular/core';
import { Routes } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ENTITY_PAGES } from './entity-pages';
import { FacultyHome } from './faculty-home';
import { BuildingHome } from './building-home';
import { BuildingPage } from './building-page';
import { SpecialtyDetailPage } from './specialty-page';
import { AcademicGroupDetailPage } from './academic-group-page';
import { LoginPage } from './login-page';
import { ChangePasswordPage } from './change-password-page';
import { AuthService } from './auth.service';
import { authGuard, adminGuard } from './auth.guard';
import { kebabCase } from './section-route';

/**
 * Every tabbed drill-down page carries its open tab as one more path segment — `/faculty/3/rooms`,
 * `/course/12/workloads`, `/me/timetable` — so that what is on screen can be bookmarked, pasted to
 * a colleague, reloaded and reached with Back. Two routes express that per page:
 *
 *   - `…/:id`          — the bare address, which redirects to the page's default tab, so that every
 *                        screen has exactly one canonical URL and an old link still works;
 *   - `…/:id/:section` — the page itself. Switching tabs only changes a parameter of this one
 *                        route, so the router reuses the component and the page is not rebuilt.
 *
 * The slug is the kebab-case of the section key the component switches on; `kebabCase` in
 * `section-route.ts` is where the two forms meet, and an unrecognised slug falls back to the
 * page's default tab rather than rendering nothing.
 *
 * Below those, `ENTITY_TABLE_ROUTES` holds the generated tables, under the same naming rule.
 */
const PAGE_ROUTES: Routes = [
  { path: 'login', component: LoginPage },
  { path: 'change-password', component: ChangePasswordPage, canActivate: [authGuard] },
  // Lazy for the same reasons as the three below: it is a whole screen with its own queries
  // (including the lecturer and student lists behind the person-link pickers), only an
  // administrator can open it, and the main bundle sits close to its budget.
  { path: 'admin', canActivate: [authGuard, adminGuard],
    loadComponent: () => import('./admin-page').then((m) => m.AdminPage) },

  { path: '', pathMatch: 'full', component: FacultyHome, canActivate: [authGuard] },

  // Lazy for the same reason as the drill-down routes below, and with more effect than any of
  // them: FacultyPage pulls in every tab it can show — the department, specialty and group lists,
  // the room and course pages, the constraint editors and the timetable view — and it is not on
  // the path to the one screen most people open the app for. `loadComponent` costs one request the
  // first time a faculty is opened and nothing after that; leaving it eager costs it to everyone,
  // on every cold load, including the students who only ever read a розклад.
  { path: 'faculty/:id', pathMatch: 'full', redirectTo: '/faculty/:id/info' },
  { path: 'faculty/:id/:section', canActivate: [authGuard],
    loadComponent: () => import('./faculty-page').then((m) => m.FacultyPage) },

  { path: 'building/:id', pathMatch: 'full', redirectTo: '/building/:id/info' },
  { path: 'building/:id/:section', component: BuildingPage, canActivate: [authGuard] },

  { path: 'department/:id', pathMatch: 'full', redirectTo: '/department/:id/info' },
  { path: 'department/:id/:section', canActivate: [authGuard],
    loadComponent: () => import('./department-page').then((m) => m.DepartmentDetailPage) },

  { path: 'specialty/:id', pathMatch: 'full', redirectTo: '/specialty/:id/info' },
  { path: 'specialty/:id/:section', component: SpecialtyDetailPage, canActivate: [authGuard] },

  { path: 'academic-group/:id', pathMatch: 'full', redirectTo: '/academic-group/:id/info' },
  { path: 'academic-group/:id/:section', component: AcademicGroupDetailPage, canActivate: [authGuard] },

  // The three drill-down pages are lazy routes: each is a whole screen with its own aggregate
  // query, none of them is on the path a user takes to reach a timetable, and the main bundle is
  // already close to its budget. `loadComponent` costs one extra request the first time each is
  // opened and nothing after that.
  { path: 'course/:id', pathMatch: 'full', redirectTo: '/course/:id/info' },
  { path: 'course/:id/:section', canActivate: [authGuard],
    loadComponent: () => import('./course-page').then((m) => m.CourseDetailPage) },

  { path: 'lecturer/:id', pathMatch: 'full', redirectTo: '/lecturer/:id/info' },
  { path: 'lecturer/:id/:section', canActivate: [authGuard],
    loadComponent: () => import('./lecturer-page').then((m) => m.LecturerDetailPage) },

  { path: 'room/:id', pathMatch: 'full', redirectTo: '/room/:id/info' },
  { path: 'room/:id/:section', canActivate: [authGuard],
    loadComponent: () => import('./room-page').then((m) => m.RoomDetailPage) },

  // «Мій кабінет»: the signed-in user's own навантаження / навчальний план and розклад, resolved
  // from users.lecturer_id / users.student_id. Lazy for the same reason the three pages above are —
  // it pulls in TimetableView and the grid, and nobody who is neither a lecturer nor a student ever
  // opens it. It replaces the old read-only /timetable grid, which showed both halves of the year
  // at once with no scope of any kind (see the READMEs' known limitations, now resolved by removal).
  //
  // Its default tab is the only one that is not a constant: a викладач lands on навантаження and a
  // студент on навчальний план, and the page is the same page either way. A `RedirectFunction` runs
  // in an injection context, so the session can be asked which of the two this account is; an
  // account that is neither still reaches /me/timetable and the page explains itself there.
  //
  // It has to be able to wait, though. Redirects are resolved before guards, so on a cold load —
  // a pasted /me, a reload, a bookmark opened this morning — the token is all that exists and
  // `personLink()` would answer null for everybody, sending a викладач to their розклад instead of
  // their навантаження. Resolving `me` first is not an extra request: it is the one `authGuard` is
  // about to make either way, and `AuthService` caches the answer for it.
  { path: 'me', pathMatch: 'full', redirectTo: async () => {
      const auth = inject(AuthService);
      if (auth.isAuthenticated() && !auth.currentUser()) {
        await firstValueFrom(auth.refreshMe()).catch(() => null);
      }
      const role = auth.personLink();
      return role === 'lecturer' ? '/me/workload'
           : role === 'student'  ? '/me/curriculum'
           : '/me/timetable';
    } },
  { path: 'me/:section', canActivate: [authGuard],
    loadComponent: () => import('./me-page').then((m) => m.MyDeskPage) },

  // Lazy on the same reasoning as /admin and «Мій кабінет»: a whole screen with its own queries,
  // opened by an administrator now and then rather than on the way to anything. Made lazy when the
  // travel-time matrix's styles pushed the initial bundle onto the 1 MB budget — the budget is the
  // point, and moving a rarely-opened screen out of the first download is what it is asking for.
  { path: 'global-properties', canActivate: [authGuard],
    loadComponent: () => import('./global-properties-page').then((m) => m.GlobalPropertiesPage) },
  // «Час переходу між корпусами» — the directed matrix behind the scheduling constraint that a
  // group's next class has to be reachable from its last. Lazy: it is a screen of its own with its
  // own query, and it is opened by whoever maintains the корпуси, not on the way to a timetable.
  { path: 'building-travel-times', canActivate: [authGuard],
    loadComponent: () => import('./building-travel-times').then((m) => m.BuildingTravelTimesPage) },
];

/**
 * The generic CRUD tables — one per entity in `entities.ts`, generated rather than listed, each at
 * the kebab-case of the entity's GraphQL singular: `roomGroup` → `/room-group`.
 *
 * These used to live under an `/e/` prefix, `e` for entity, and the segment after it was the
 * singular verbatim — `/e/roomGroup`. Both halves of that were the schema showing through rather
 * than anything anyone chose: the prefix said "generated route" to the person who wrote the
 * generator, and camelCase in a path is what you get when an identifier is used as a URL without
 * being asked whether it reads like one. Neither survives its own address bar next to
 * `/faculty/3/room-assignment`.
 *
 * `pathMatch: 'full'` on each is what lets `/faculty` (the table of every faculty) and
 * `/faculty/3/departments` (one of them) be different screens without either shadowing the other.
 */
const ENTITY_TABLE_ROUTES: Routes = [
  // Building is the one entity whose table is a page of tiles instead — BuildingHome, not the
  // generic component. It is listed here rather than above because /building is its table's path.
  { path: 'building', pathMatch: 'full', component: BuildingHome, canActivate: [authGuard] },
  ...ENTITY_PAGES.map((p) => ({
    path: kebabCase(p.single), pathMatch: 'full' as const, component: p.component, canActivate: [authGuard]
  })),
];

/**
 * One namespace, two authors. The tables above are generated from `entities.ts` and the screens
 * before them are written by hand, and nothing in a flat path space stops the two from claiming the
 * same address: add an entity whose singular is `admin`, `me` or `login` and one of the pair simply
 * stops opening, quietly, depending on which comes first in the array. The `/e/` prefix used to make
 * that impossible for free; dropping it bought a uniform URL space and owes this in exchange. It
 * fails at startup in development — where the entity is being added — rather than in whichever
 * screen went dark.
 */
if (isDevMode()) {
  const taken = new Set(PAGE_ROUTES.map((r) => r.path));
  const clashes: string[] = [];
  for (const route of ENTITY_TABLE_ROUTES) {
    if (taken.has(route.path)) clashes.push(route.path!);
    taken.add(route.path);
  }
  if (clashes.length) {
    throw new Error(
      `app.routes.ts: entity table route(s) ${clashes.map((c) => `/${c}`).join(', ')} collide with a `
      + `route that already exists. Rename the entity's \`single\` in entities.ts, or give the table `
      + `a path of its own.`);
  }
}

export const routes: Routes = [
  ...PAGE_ROUTES,
  ...ENTITY_TABLE_ROUTES,
  { path: '**', redirectTo: '' }
];
