import { Component, Input, OnChanges, OnInit, computed, inject, signal } from '@angular/core';
import { GraphqlService } from './graphql.service';
import { HOUR_TYPE_OPTIONS } from './entities';

interface GroupRef {
  id: string;
  name: string;
}

interface RawItem {
  id: string;
  academicGroups: GroupRef[];
  combinedWorkingCurriculumItems: { id: string }[];
  curriculumItemHours: {
    id: string;
    hourType: string;
    hours: number;
    curriculumItem: {
      id: string;
      semester: number;
      specialty: { id: string; name: string };
      course: { id: string; name: string };
    };
  };
}

interface CandidateItem {
  id: string;
  specialty: { id: string; name: string };
  academicGroups: GroupRef[];
}

/** A proposed merge: 2+ not-yet-combined items sharing course + semester + hour type + hours. */
interface MergeProposal {
  key: string;
  course: { id: string; name: string };
  semester: number;
  hourType: string;
  hours: number;
  items: CandidateItem[];
  /** Which item ids are currently checked for merging; all start pre-selected. */
  selected: Set<string>;
}

interface CombinedItemMember {
  id: string;
  academicGroups: GroupRef[];
  curriculumItemHours: {
    hourType: string;
    hours: number;
    curriculumItem: {
      semester: number;
      specialty: { id: string; name: string };
      course: { id: string; name: string };
    };
  };
}

interface CombinedItem {
  id: string;
  workingCurriculumItems: CombinedItemMember[];
}

/**
 * Lets a department combine several working curriculum items that relate to the same course,
 * semester, and hour type (typically the same discipline taught to groups from different
 * specialties) into one combined_working_curriculum_item, so a lecturer who teaches them all
 * simultaneously (e.g. one shared lecture) can be assigned once via lecturer_workloads.
 */
@Component({
  selector: 'app-combined-working-curriculum-item-list',
  templateUrl: './combined-working-curriculum-item-list.html'
})
export class CombinedWorkingCurriculumItemList implements OnInit, OnChanges {
  private gql = inject(GraphqlService);

  @Input() departmentId!: string;

  readonly HOUR_TYPE_OPTIONS = HOUR_TYPE_OPTIONS;

  private rawItems = signal<RawItem[]>([]);
  /** Existing combined items with at least one member belonging to this department — filtered
   *  server-side (see loadCombined) via the departmentIds relation filter on
   *  combinedWorkingCurriculumItemConnection. */
  existingCombined = signal<CombinedItem[]>([]);
  error = signal('');
  actionError = signal('');

  /** Proposed merge groups, built from the department's not-yet-combined working curriculum items. */
  proposals = computed(() => this.buildProposals(this.rawItems()));

  private initialized = false;

  ngOnInit() {
    this.initialized = true;
    if (this.departmentId) this.loadAll();
  }

  ngOnChanges() {
    if (this.initialized && this.departmentId) this.loadAll();
  }

  private loadAll() {
    this.loadItems();
    this.loadCombined();
  }

  private loadItems() {
    if (!this.departmentId) return;
    const q = `{ workingCurriculumItems { workingCurriculumItemConnection(limit: 1000, offset: 0, departmentId: "${this.departmentId}") { nodes {
      id
      academicGroups { id name }
      combinedWorkingCurriculumItems { id }
      curriculumItemHours {
        id hourType hours
        curriculumItem {
          id semester
          specialty { id name }
          course { id name }
        }
      }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.rawItems.set(d.workingCurriculumItems.workingCurriculumItemConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadCombined() {
    if (!this.departmentId) return;
    const q = `{ combinedWorkingCurriculumItems { combinedWorkingCurriculumItemConnection(limit: 1000, offset: 0, departmentIds: ["${this.departmentId}"]) { nodes {
      id
      workingCurriculumItems {
        id
        academicGroups { id name }
        curriculumItemHours {
          hourType hours
          curriculumItem { semester specialty { id name } course { id name } }
        }
      }
    } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.existingCombined.set(d.combinedWorkingCurriculumItems.combinedWorkingCurriculumItemConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
  }

  private buildProposals(items: RawItem[]): MergeProposal[] {
    const byKey = new Map<string, MergeProposal>();
    for (const it of items) {
      if ((it.combinedWorkingCurriculumItems ?? []).length > 0) continue; // already part of a combined item
      const cih = it.curriculumItemHours;
      const ci = cih.curriculumItem;
      const key = `${ci.course.id}__${ci.semester}__${cih.hourType}__${cih.hours}`;
      let group = byKey.get(key);
      if (!group) {
        group = { key, course: ci.course, semester: ci.semester, hourType: cih.hourType, hours: cih.hours, items: [], selected: new Set() };
        byKey.set(key, group);
      }
      group.items.push({ id: it.id, specialty: ci.specialty, academicGroups: it.academicGroups });
      group.selected.add(it.id);
    }

    const groups = Array.from(byKey.values()).filter((g) => g.items.length >= 2);
    groups.sort((a, b) => a.semester - b.semester || a.course.name.localeCompare(b.course.name));
    return groups;
  }

  hourTypeLabel(v: string): string {
    return this.HOUR_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;
  }

  academicGroupNames(refs: GroupRef[]): string {
    return (refs ?? []).map((g) => g.name).join(', ') || '—';
  }

  isChecked(group: MergeProposal, itemId: string): boolean {
    return group.selected.has(itemId);
  }

  toggle(group: MergeProposal, itemId: string) {
    if (group.selected.has(itemId)) group.selected.delete(itemId);
    else group.selected.add(itemId);
  }

  canMerge(group: MergeProposal): boolean {
    return group.selected.size >= 2;
  }

  merge(group: MergeProposal) {
    this.actionError.set('');
    const input = { workingCurriculumItemIds: Array.from(group.selected) };
    const q = `mutation($input: CombinedWorkingCurriculumItemInputPayload!) { combinedWorkingCurriculumItems { createCombinedWorkingCurriculumItem(combinedWorkingCurriculumItem: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { input }).subscribe({
      next: (d: any) => {
        const res = d.combinedWorkingCurriculumItems.createCombinedWorkingCurriculumItem;
        if (res.isSuccess) this.loadAll();
        else this.actionError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.actionError.set(e.message)
    });
  }

  remove(c: CombinedItem) {
    this.actionError.set('');
    const q = `mutation($id: ID!) { combinedWorkingCurriculumItems { deleteCombinedWorkingCurriculumItem(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: c.id }).subscribe({
      next: (d: any) => {
        const res = d.combinedWorkingCurriculumItems.deleteCombinedWorkingCurriculumItem;
        if (res.isSuccess) this.loadAll();
        else this.actionError.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.actionError.set(e.message)
    });
  }

  memberSpecialtyName(m: CombinedItemMember): string {
    return m.curriculumItemHours.curriculumItem.specialty.name;
  }

  memberCourseName(m: CombinedItemMember): string {
    return m.curriculumItemHours.curriculumItem.course.name;
  }

  memberSemester(m: CombinedItemMember): number {
    return m.curriculumItemHours.curriculumItem.semester;
  }
}
