import { Routes } from '@angular/router';
import { Timetable } from './timetable';
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
import { AdminPage } from './admin-page';
import { authGuard, adminGuard } from './auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginPage },
  { path: 'change-password', component: ChangePasswordPage, canActivate: [authGuard] },
  { path: 'admin', component: AdminPage, canActivate: [authGuard, adminGuard] },

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
  { path: 'timetable', component: Timetable, canActivate: [authGuard] },
  { path: 'global-properties', component: GlobalPropertiesPage, canActivate: [authGuard] },
  // /e/building is handled by BuildingHome, not the generic entity table
  { path: 'e/building', component: BuildingHome, canActivate: [authGuard] },
  // All other entity pages (generic CRUD tables)
  ...ENTITY_PAGES.map((p) => ({ path: `e/${p.single}`, component: p.component, canActivate: [authGuard] })),
  { path: '**', redirectTo: '' }
];
