import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ENTITIES, EntityMeta } from './entities';

interface Section { title: string; items: EntityMeta[]; }

const byKey = (key: string) => ENTITIES.find((e) => e.single === key)!;
const section = (title: string, keys: string[]): Section => ({ title, items: keys.map(byKey) });

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  // Ordered for convenient top-down data entry in a Ukrainian HEI.
  protected readonly sections: Section[] = [
    section('Структура / Structure', ['faculty', 'department', 'specialty', 'room', 'timeSlot']),
    section('Навчальні плани / Curricula', ['course', 'curriculum', 'curriculumItem', 'workingCurriculum', 'workingCurriculumItem']),
    section('Люди та групи / People & groups', ['lecturer', 'student', 'academicGroup', 'combinedGroup']),
    section('Розклад / Scheduling', ['lecturerWorkload', 'timetableEntry'])
  ];
}
