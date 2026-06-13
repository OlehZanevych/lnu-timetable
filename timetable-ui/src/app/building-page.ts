import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { SearchSelect, Option } from './search-select';

type BuildingSection = 'info' | 'rooms';

interface Room {
  id: string;
  number: string;
  name?: string;
  capacity?: number;
  kind?: string;
  faculty?: { id: string; name: string };
}

interface Building {
  id: string;
  name: string;
  address?: string;
  city?: string;
  postalCode?: string;
  rooms: Room[];
}

@Component({
  selector: 'app-building-page',
  templateUrl: './building-page.html',
  imports: [RouterLink, FormsModule, SearchSelect]
})
export class BuildingPage implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private gql = inject(GraphqlService);

  readonly buildingId: string = this.route.snapshot.paramMap.get('id')!;

  building = signal<Building | null>(null);
  error = signal('');
  activeSection = signal<BuildingSection>('info');

  // Edit building
  showEditForm = signal(false);
  editError = signal('');
  editForm: Record<string, any> = {};

  // Delete building
  showDeleteConfirm = signal(false);
  deleteError = signal('');

  // Room form (create + edit)
  showRoomForm = signal(false);
  editingRoomId = signal<string | null>(null);
  roomForm: Record<string, any> = {};
  roomError = signal('');
  facultyOptions = signal<Option[]>([]);

  ngOnInit() {
    this.loadBuilding();
    this.loadFaculties();
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  private loadBuilding() {
    const q = `{ buildings { building(id: "${this.buildingId}") {
      id name address city postalCode
      rooms { id number name capacity kind faculty { id name } }
    } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => this.building.set(d.buildings.building),
      error: (e) => this.error.set(e.message)
    });
  }

  private loadFaculties() {
    const q = `{ faculties { facultyConnection(limit: 100) { nodes { id name } } } }`;
    this.gql.request(q).subscribe({
      next: (d: any) => {
        const opts: Option[] = d.faculties.facultyConnection.nodes.map((f: any) => ({ id: f.id, label: f.name }));
        this.facultyOptions.set(opts);
      },
      error: () => {}
    });
  }

  // ── Edit building ─────────────────────────────────────────────────────────

  openEdit() {
    const b = this.building();
    if (!b) return;
    this.editForm = {
      name:       b.name        ?? '',
      address:    b.address     ?? '',
      city:       b.city        ?? '',
      postalCode: b.postalCode  ?? '',
    };
    this.editError.set('');
    this.showEditForm.set(true);
  }

  closeEdit() {
    this.showEditForm.set(false);
    this.editError.set('');
  }

  saveEdit() {
    const input: Record<string, any> = {};
    for (const f of ['name', 'address', 'city', 'postalCode']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    const q = `mutation($id: ID!, $input: BuildingInputPayload!) { buildings { updateBuilding(id: $id, building: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.buildingId, input }).subscribe({
      next: (d: any) => {
        const res = d.buildings.updateBuilding;
        if (res.isSuccess) { this.closeEdit(); this.loadBuilding(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }

  // ── Delete building ───────────────────────────────────────────────────────

  openDelete() {
    this.deleteError.set('');
    this.showDeleteConfirm.set(true);
  }

  closeDelete() {
    this.showDeleteConfirm.set(false);
    this.deleteError.set('');
  }

  confirmDelete() {
    const q = `mutation($id: ID!) { buildings { deleteBuilding(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: this.buildingId }).subscribe({
      next: (d: any) => {
        const res = d.buildings.deleteBuilding;
        if (res.isSuccess) this.router.navigate(['/e/building']);
        else this.deleteError.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.deleteError.set(e.message)
    });
  }

  // ── Room CRUD ─────────────────────────────────────────────────────────────

  openCreateRoom() {
    this.editingRoomId.set(null);
    this.roomForm = { buildingId: this.buildingId };
    this.roomError.set('');
    this.showRoomForm.set(true);
  }

  openEditRoom(room: Room) {
    this.editingRoomId.set(room.id);
    this.roomForm = {
      number:     room.number       ?? '',
      name:       room.name         ?? '',
      capacity:   room.capacity     ?? '',
      kind:       room.kind         ?? '',
      facultyId:  room.faculty?.id  ?? '',
      buildingId: this.buildingId,
    };
    this.roomError.set('');
    this.showRoomForm.set(true);
  }

  closeRoom() {
    this.showRoomForm.set(false);
    this.editingRoomId.set(null);
    this.roomError.set('');
  }

  saveRoom() {
    const input: Record<string, any> = {};
    const fields = ['number', 'name', 'capacity', 'kind', 'facultyId', 'buildingId'];
    for (const f of fields) {
      const v = this.roomForm[f];
      if (v === undefined || v === null || v === '') continue;
      input[f] = f === 'capacity' ? Number(v) : v;
    }
    const id = this.editingRoomId();
    const op = id ? 'updateRoom' : 'createRoom';
    const q = id
      ? `mutation($id: ID!, $input: RoomInputPayload!) { rooms { updateRoom(id: $id, room: $input) { isSuccess errorStatus } } }`
      : `mutation($input: RoomInputPayload!) { rooms { createRoom(room: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, id ? { id, input } : { input }).subscribe({
      next: (d: any) => {
        const res = d.rooms[op];
        if (res.isSuccess) { this.closeRoom(); this.loadBuilding(); }
        else this.roomError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.roomError.set(e.message)
    });
  }

  deleteRoom(room: Room) {
    const q = `mutation($id: ID!) { rooms { deleteRoom(id: $id) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: room.id }).subscribe({
      next: (d: any) => {
        const res = d.rooms.deleteRoom;
        if (res.isSuccess) this.loadBuilding();
        else this.error.set(res.errorStatus || 'Помилка видалення');
      },
      error: (e) => this.error.set(e.message)
    });
  }
}
