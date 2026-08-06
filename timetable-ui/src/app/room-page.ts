import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { SearchSelect, Option } from './search-select';
import { ROOM_KIND_OPTIONS, toOptions } from './entities';
import { TimetableView } from './timetable-view';

type RoomSection = 'info' | 'timetable';

interface RoomInfo {
  id: string;
  number: string;
  name?: string | null;
  capacity?: number | null;
  kind?: string | null;
  faculty?: { id: string; name: string } | null;
  building?: { id: string; name: string; address?: string | null } | null;
}

/**
 * One room: what it is, and what happens in it.
 *
 * The «Розклад» tab is the аудиторний розклад — the sheet a навчальний відділ keeps to see whether a
 * room is free, and the one view of a timetable that ЗВО almost never publish (ЛНУ's own «ПС-Розклад»
 * offers it as an internal mode; КПІ has no room filter at all). It is the same grid as everywhere
 * else, scoped to this room.
 *
 * The info tab also edits and deletes the room itself, exactly as `FacultyPage` does for a faculty:
 * a modal over the entity's own fields and a confirmation before `deleteRoom`, both hidden unless
 * `canModifyIds('ROOM', …)` says this account may — see the README's *Hiding UI the user can't use*.
 */
@Component({
  selector: 'app-room-page',
  templateUrl: './room-page.html',
  imports: [RouterLink, FormsModule, SearchSelect, TimetableView]
})
export class RoomDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private gql = inject(GraphqlService);
  auth = inject(AuthService);

  readonly roomId: string = this.route.snapshot.paramMap.get('id')!;
  readonly roomKindOptions = toOptions(ROOM_KIND_OPTIONS);

  readonly sections: { key: RoomSection; label: string }[] = [
    { key: 'info',      label: '&#x2139; Інформація' },
    { key: 'timetable', label: '&#x1F4C5; Розклад' }
  ];

  room = signal<RoomInfo | null>(null);
  error = signal('');
  activeSection = signal<RoomSection>('info');

  /** Whether the current user may edit/delete this Room — see AuthService#canModifyIds. */
  canModifyRoom = signal(false);

  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};

  showDeleteConfirm = signal(false);
  deleteError = signal('');

  facultyOptions = signal<Option[]>([]);
  buildingOptions = signal<Option[]>([]);

  readonly roomIds = computed(() => [this.roomId]);

  label = computed(() => {
    const r = this.room();
    if (!r) return '';
    return r.name ? `${r.number} — ${r.name}` : r.number;
  });

  ngOnInit() {
    this.load();
    this.loadFaculties();
    this.loadBuildings();
    if (this.auth.isAdmin()) {
      this.canModifyRoom.set(true);
    } else {
      this.auth.canModifyIds('ROOM', [this.roomId]).subscribe((ids) => this.canModifyRoom.set(ids.has(this.roomId)));
    }
  }

  selectSection(key: RoomSection) { this.activeSection.set(key); }

  kindLabel(v?: string | null): string {
    return ROOM_KIND_OPTIONS.find((o) => o.value === v)?.label ?? (v || '—');
  }

  private load() {
    const q = `{ rooms { room(id: "${this.roomId}") {
      id number name capacity kind
      faculty { id name }
      building { id name address }
    } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.room.set(d.rooms.room),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadFaculties() {
    const q = `{ faculties { facultyConnection(limit: 200) { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.facultyOptions.set(
        d.faculties.facultyConnection.nodes.map((f: any) => ({ id: f.id, label: f.name }))),
      error: () => {}
    });
  }

  private loadBuildings() {
    const q = `{ buildings { buildingConnection(limit: 200) { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.buildingOptions.set(
        d.buildings.buildingConnection.nodes.map((b: any) => ({ id: b.id, label: b.name }))),
      error: () => {}
    });
  }

  // ── Edit ──────────────────────────────────────────────────────────────────

  openEdit() {
    const r = this.room();
    if (!r) return;
    this.editForm = {
      number: r.number ?? '',
      name: r.name ?? '',
      capacity: r.capacity ?? '',
      kind: r.kind ?? '',
      facultyId: r.faculty?.id ?? '',
      buildingId: r.building?.id ?? '',
    };
    this.editError.set('');
    this.showEditForm.set(true);
  }

  closeEdit() { this.showEditForm.set(false); this.editError.set(''); }

  /**
   * Sends an explicit `null` for a cleared optional field, as `BaseEntity#buildInput` does, so
   * emptying a box actually clears the column instead of silently leaving it as it was.
   *
   * `timetableConstraints` is deliberately absent from the payload: a nested list missing from an
   * update leaves its rows untouched (see `reconcileNestedLists` on the service), which is what
   * keeps this form from wiping the room's scheduling constraints — those are owned by
   * «Обмеження аудиторій» on the faculty page.
   */
  saveEdit() {
    const input: Record<string, any> = {};
    for (const f of ['number', 'name', 'capacity', 'kind', 'facultyId', 'buildingId']) {
      const v = this.editForm[f];
      if (v === undefined || v === null || v === '') {
        if (f !== 'number') input[f] = null;
        continue;
      }
      input[f] = f === 'capacity' ? Number(v) : v;
    }
    const q = `mutation($id: ID!, $input: RoomInputPayload!) { rooms { updateRoom(id: $id, room: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.roomId, input }).subscribe({
      next: (d: any) => {
        const res = d.rooms.updateRoom;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  openDelete() { this.deleteError.set(''); this.showDeleteConfirm.set(true); }
  closeDelete() { this.showDeleteConfirm.set(false); this.deleteError.set(''); }

  /** Back to wherever the room was reached from — its building, its faculty, or the plain table. */
  private afterDeleteRoute(): any[] {
    const r = this.room();
    if (r?.building) return ['/building', r.building.id];
    if (r?.faculty) return ['/faculty', r.faculty.id];
    return ['/e/room'];
  }

  confirmDelete() {
    const back = this.afterDeleteRoute();
    const q = `mutation($id: ID!) { rooms { deleteRoom(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.roomId }).subscribe({
      next: (d: any) => {
        const res = d.rooms.deleteRoom;
        if (res.isSuccess) this.router.navigate(back);
        else this.deleteError.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.deleteError.set(e.message)
    });
  }
}
