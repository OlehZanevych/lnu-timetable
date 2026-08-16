import { Component, Type } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { BaseEntity } from './base-entity';
import { SearchSelect } from './search-select';
import { MultiSelect } from './multi-select';
import { DeptFacultySelect } from './dept-faculty-select';
import { TimeSelect } from './time-select';
import { NoAccessCard } from './access-gate';
import { ENTITIES, EntityMeta } from './entities';

// RouterLink is here for the «Відкрити →» link entity-page.html renders for entities
// that declare a `detailRoute`.
const IMPORTS = [FormsModule, RouterLink, SearchSelect, MultiSelect, DeptFacultySelect, TimeSelect, NoAccessCard];
const meta = (name: string): EntityMeta => ENTITIES.find((e) => e.name === name)!;
const TPL = './entity-page.html';

@Component({ selector: 'app-academic-degree', templateUrl: TPL, imports: IMPORTS }) export class AcademicDegreePage extends BaseEntity { meta = meta('AcademicDegree'); }
@Component({ selector: 'app-building', templateUrl: TPL, imports: IMPORTS }) export class BuildingPage extends BaseEntity { meta = meta('Building'); }
@Component({ selector: 'app-faculty', templateUrl: TPL, imports: IMPORTS }) export class FacultyPage extends BaseEntity { meta = meta('Faculty'); }
@Component({ selector: 'app-department', templateUrl: TPL, imports: IMPORTS }) export class DepartmentPage extends BaseEntity { meta = meta('Department'); }
@Component({ selector: 'app-degree-program', templateUrl: TPL, imports: IMPORTS }) export class DegreeProgramPage extends BaseEntity { meta = meta('DegreeProgram'); }
@Component({ selector: 'app-course', templateUrl: TPL, imports: IMPORTS }) export class CoursePage extends BaseEntity { meta = meta('Course'); }
@Component({ selector: 'app-lecturer', templateUrl: TPL, imports: IMPORTS }) export class LecturerPage extends BaseEntity { meta = meta('Lecturer'); }
@Component({ selector: 'app-student', templateUrl: TPL, imports: IMPORTS }) export class StudentPage extends BaseEntity { meta = meta('Student'); }
@Component({ selector: 'app-academic-group', templateUrl: TPL, imports: IMPORTS }) export class AcademicGroupPage extends BaseEntity { meta = meta('AcademicGroup'); }
@Component({ selector: 'app-combined-group', templateUrl: TPL, imports: IMPORTS }) export class CombinedGroupPage extends BaseEntity { meta = meta('CombinedGroup'); }
@Component({ selector: 'app-room', templateUrl: TPL, imports: IMPORTS }) export class RoomPage extends BaseEntity { meta = meta('Room'); }
@Component({ selector: 'app-room-group', templateUrl: TPL, imports: IMPORTS }) export class RoomGroupPage extends BaseEntity { meta = meta('RoomGroup'); }
@Component({ selector: 'app-abstract-room', templateUrl: TPL, imports: IMPORTS }) export class AbstractRoomPage extends BaseEntity { meta = meta('AbstractRoom'); }
@Component({ selector: 'app-class-start-time-set', templateUrl: TPL, imports: IMPORTS }) export class ClassStartTimeSetPage extends BaseEntity { meta = meta('ClassStartTimeSet'); }
@Component({ selector: 'app-class-start-time', templateUrl: TPL, imports: IMPORTS }) export class ClassStartTimePage extends BaseEntity { meta = meta('ClassStartTime'); }
@Component({ selector: 'app-timetable-entry', templateUrl: TPL, imports: IMPORTS }) export class TimetableEntryPage extends BaseEntity { meta = meta('TimetableEntry'); }

/**
 * single key -> component, used to generate routes.
 *
 * `editorsOnly` marks the tables that are *only* a way to maintain reference data — five of the
 * links under «Загальне» in the sidebar. Those hide themselves («Немає доступу») from an account that can
 * neither add a row nor edit one it already holds, and the sidebar hides the link on the same
 * answer. The rest stay readable: `/course`, `/lecturer` and `/timetable-entry` are also how
 * somebody looks something up, and reading is open to any signed-in user by design — hiding them
 * would be a different change, to a different rule.
 */
export const ENTITY_PAGES: { single: string; component: Type<BaseEntity>; editorsOnly?: true }[] = [
  { single: 'academicDegree', component: AcademicDegreePage, editorsOnly: true },
  { single: 'faculty', component: FacultyPage },
  { single: 'department', component: DepartmentPage },
  { single: 'degreeProgram', component: DegreeProgramPage },
  { single: 'course', component: CoursePage },
  { single: 'lecturer', component: LecturerPage },
  { single: 'student', component: StudentPage },
  { single: 'academicGroup', component: AcademicGroupPage },
  { single: 'room', component: RoomPage },
  { single: 'roomGroup', component: RoomGroupPage, editorsOnly: true },
  { single: 'abstractRoom', component: AbstractRoomPage, editorsOnly: true },
  { single: 'classStartTimeSet', component: ClassStartTimeSetPage, editorsOnly: true },
  { single: 'classStartTime', component: ClassStartTimePage, editorsOnly: true },
  { single: 'timetableEntry', component: TimetableEntryPage }
];
