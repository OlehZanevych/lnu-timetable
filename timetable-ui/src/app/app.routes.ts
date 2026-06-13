import { Routes } from '@angular/router';
import { Timetable } from './timetable';
import { ENTITY_PAGES } from './entity-pages';
import { FacultyHome } from './faculty-home';
import { FacultyPage } from './faculty-page';
import { BuildingHome } from './building-home';
import { BuildingPage } from './building-page';
import { DepartmentDetailPage } from './department-page';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: FacultyHome },
  { path: 'faculty/:id', component: FacultyPage },
  { path: 'building/:id', component: BuildingPage },
  { path: 'department/:id', component: DepartmentDetailPage },
  { path: 'timetable', component: Timetable },
  // /e/building is handled by BuildingHome, not the generic entity table
  { path: 'e/building', component: BuildingHome },
  // All other entity pages (generic CRUD tables)
  ...ENTITY_PAGES.map((p) => ({ path: `e/${p.single}`, component: p.component })),
  { path: '**', redirectTo: '' }
];
