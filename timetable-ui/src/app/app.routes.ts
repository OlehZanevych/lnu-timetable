import { Routes } from '@angular/router';
import { Timetable } from './timetable';
import { ENTITY_PAGES } from './entity-pages';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'timetable' },
  { path: 'timetable', component: Timetable },
  ...ENTITY_PAGES.map((p) => ({ path: `e/${p.single}`, component: p.component })),
  { path: '**', redirectTo: 'timetable' }
];
