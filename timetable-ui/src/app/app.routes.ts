import { Routes } from '@angular/router';
import { ENTITY_PAGES } from './entity-pages';
import { FacultyHome } from './faculty-home';
import { FacultyPage } from './faculty-page';
import { BuildingHome } from './building-home';
import { BuildingPage } from './building-page';
import { DepartmentDetailPage } from './department-page';
import { SpecialtyDetailPage } from './specialty-page';
import { AcademicGroupDetailPage } from './academic-group-page';
import { GlobalPropertiesPage } from './global-properties-page';
import { LoginPage } from './login-page';
import { ChangePasswordPage } from './change-password-page';
import { authGuard, adminGuard } from './auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginPage },
  { path: 'change-password', component: ChangePasswordPage, canActivate: [authGuard] },
  // Lazy for the same reasons as the three below: it is a whole screen with its own queries
  // (including the lecturer and student lists behind the person-link pickers), only an
  // administrator can open it, and the main bundle sits close to its budget.
  { path: 'admin', canActivate: [authGuard, adminGuard],
    loadComponent: () => import('./admin-page').then((m) => m.AdminPage) },

  { path: '', pathMatch: 'full', component: FacultyHome, canActivate: [authGuard] },
  { path: 'faculty/:id', component: FacultyPage, canActivate: [authGuard] },
  { path: 'building/:id', component: BuildingPage, canActivate: [authGuard] },
  { path: 'department/:id', component: DepartmentDetailPage, canActivate: [authGuard] },
  { path: 'specialty/:id', component: SpecialtyDetailPage, canActivate: [authGuard] },
  { path: 'academic-group/:id', component: AcademicGroupDetailPage, canActivate: [authGuard] },
  // The three drill-down pages are lazy routes: each is a whole screen with its own aggregate
  // query, none of them is on the path a user takes to reach a timetable, and the main bundle is
  // already close to its budget. `loadComponent` costs one extra request the first time each is
  // opened and nothing after that.
  { path: 'course/:id', canActivate: [authGuard],
    loadComponent: () => import('./course-page').then((m) => m.CourseDetailPage) },
  { path: 'lecturer/:id', canActivate: [authGuard],
    loadComponent: () => import('./lecturer-page').then((m) => m.LecturerDetailPage) },
  { path: 'room/:id', canActivate: [authGuard],
    loadComponent: () => import('./room-page').then((m) => m.RoomDetailPage) },
  // «Мій кабінет»: the signed-in user's own навантаження / навчальний план and розклад, resolved
  // from users.lecturer_id / users.student_id. Lazy for the same reason the three pages above are —
  // it pulls in TimetableView and the grid, and nobody who is neither a lecturer nor a student ever
  // opens it. It replaces the old read-only /timetable grid, which showed both halves of the year
  // at once with no scope of any kind (see the READMEs' known limitations, now resolved by removal).
  { path: 'me', canActivate: [authGuard],
    loadComponent: () => import('./me-page').then((m) => m.MyDeskPage) },
  { path: 'global-properties', component: GlobalPropertiesPage, canActivate: [authGuard] },
  // /e/building is handled by BuildingHome, not the generic entity table
  { path: 'e/building', component: BuildingHome, canActivate: [authGuard] },
  // All other entity pages (generic CRUD tables)
  ...ENTITY_PAGES.map((p) => ({ path: `e/${p.single}`, component: p.component, canActivate: [authGuard] })),
  { path: '**', redirectTo: '' }
];
