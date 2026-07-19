import { Component, Type } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BaseEntity } from './base-entity';
import { SearchSelect } from './search-select';
import { DeptFacultySelect } from './dept-faculty-select';
import { ENTITIES, EntityMeta } from './entities';

const IMPORTS = [FormsModule, SearchSelect, DeptFacultySelect];
const meta = (name: string): EntityMeta => ENTITIES.find((e) => e.name === name)!;
const TPL = './entity-page.html';

@Component({ selector: 'app-academic-degree', templateUrl: TPL, imports: IMPORTS }) export class AcademicDegreePage extends BaseEntity { meta = meta('AcademicDegree'); }
@Component({ selector: 'app-building', templateUrl: TPL, imports: IMPORTS }) export class BuildingPage extends BaseEntity { meta = meta('Building'); }
@Component({ selector: 'app-faculty', templateUrl: TPL, imports: IMPORTS }) export class FacultyPage extends BaseEntity { meta = meta('Faculty'); }
@Component({ selector: 'app-department', templateUrl: TPL, imports: IMPORTS }) export class DepartmentPage extends BaseEntity { meta = meta('Department'); }
@Component({ selector: 'app-specialty', templateUrl: TPL, imports: IMPORTS }) export class SpecialtyPage extends BaseEntity { meta = meta('Specialty'); }
@Component({ selector: 'app-course', templateUrl: TPL, imports: IMPORTS }) export class CoursePage extends BaseEntity { meta = meta('Course'); }
@Component({ selector: 'app-lecturer', templateUrl: TPL, imports: IMPORTS }) export class LecturerPage extends BaseEntity { meta = meta('Lecturer'); }
@Component({ selector: 'app-student', templateUrl: TPL, imports: IMPORTS }) export class StudentPage extends BaseEntity { meta = meta('Student'); }
@Component({ selector: 'app-academic-group', templateUrl: TPL, imports: IMPORTS }) export class AcademicGroupPage extends BaseEntity { meta = meta('AcademicGroup'); }
@Component({ selector: 'app-combined-group', templateUrl: TPL, imports: IMPORTS }) export class CombinedGroupPage extends BaseEntity { meta = meta('CombinedGroup'); }
@Component({ selector: 'app-room', templateUrl: TPL, imports: IMPORTS }) export class RoomPage extends BaseEntity { meta = meta('Room'); }
@Component({ selector: 'app-class-start-time', templateUrl: TPL, imports: IMPORTS }) export class ClassStartTimePage extends BaseEntity { meta = meta('ClassStartTime'); }
@Component({ selector: 'app-timetable-entry', templateUrl: TPL, imports: IMPORTS }) export class TimetableEntryPage extends BaseEntity { meta = meta('TimetableEntry'); }

/** single key -> component, used to generate routes. */
export const ENTITY_PAGES: { single: string; component: Type<BaseEntity> }[] = [
  { single: 'academicDegree', component: AcademicDegreePage },
  { single: 'faculty', component: FacultyPage },
  { single: 'department', component: DepartmentPage },
  { single: 'specialty', component: SpecialtyPage },
  { single: 'course', component: CoursePage },
  { single: 'lecturer', component: LecturerPage },
  { single: 'student', component: StudentPage },
  { single: 'academicGroup', component: AcademicGroupPage },
  { single: 'room', component: RoomPage },
  { single: 'classStartTime', component: ClassStartTimePage },
  { single: 'timetableEntry', component: TimetableEntryPage }
];
