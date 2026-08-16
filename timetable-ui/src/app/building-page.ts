import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { SearchSelect, Option } from './search-select';
import { ROOM_KIND_OPTIONS, toOptions } from './entities';
import { sectionNav } from './section-route';

type BuildingSection = 'info' | 'rooms';

/** Which slugs `/building/:id/:section` recognises — see `section-route.ts`. */
const SECTION_KEYS: BuildingSection[] = ['info', 'rooms'];

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
  auth = inject(AuthService);

  readonly buildingId: string = this.route.snapshot.paramMap.get('id')!;
  readonly roomKindOptions = toOptions(ROOM_KIND_OPTIONS);

  building = signal<Building | null>(null);
  error = signal('');

  /** The open tab, and the last segment of the URL — see `section-route.ts`. */
  private nav = sectionNav<BuildingSection>(
    () => ['/building', this.buildingId], () => SECTION_KEYS, () => 'info');
  readonly activeSection = this.nav.active;

  /**
   * This user's level on this корпус. Two signals rather than one boolean, exactly as `RoomDetailPage`
   * keeps them, because the buttons they gate are no longer the same right: «Редагувати» needs EDIT,
   * «Видалити» needs FULL.
   */
  buildingLevel = signal<AccessLevel | null>(null);
  canModifyBuilding = computed(() => allows(maxLevel(this.auth.globalLevel(), this.buildingLevel()), 'EDIT'));
  canDeleteBuilding = computed(() => allows(maxLevel(this.auth.globalLevel(), this.buildingLevel()), 'FULL'));

  /**
   * A new аудиторія opened from here is attached to this корпус, so the right it needs is EDIT on the
   * building it lands in — the same rule the server applies to the parent of a created row.
   */
  canCreateRoom = this.canModifyBuilding;

  /**
   * The per-row level on each аудиторія of this корпус, batched into one `accessLevels` call once the
   * rooms are known. A room cannot be judged by the корпус alone: `Room` declares both `Building` and
   * `Faculty` as permission parents, so a faculty may hold an аудиторія in a корпус that is not theirs,
   * while a grant on the корпус itself cascades into every room in it, whichever faculty owns them.
   */
  roomAccessById = signal<Map<string, AccessLevel>>(new Map());

  selectSection(key: BuildingSection) { this.nav.select(key); }

  /** The strongest of the three grants that can reach one room: university-wide, the корпус, the row. */
  private roomLevel(room: Room): AccessLevel | null {
    return maxLevel(maxLevel(this.auth.globalLevel(), this.buildingLevel()),
                    this.roomAccessById().get(String(room.id)));
  }

  canEditRoom(room: Room): boolean { return allows(this.roomLevel(room), 'EDIT'); }
  canDeleteRoom(room: Room): boolean { return allows(this.roomLevel(room), 'FULL'); }

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
    this.auth.accessLevel('BUILDING', this.buildingId).subscribe((level) => this.buildingLevel.set(level));
  }

  roomKindLabel(v: string | undefined): string {
    return ROOM_KIND_OPTIONS.find((o) => o.value === v)?.label ?? (v || '');
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  private loadBuilding() {
    const q = `query($id: ID!) { buildings { building(id: $id) {
      id name address city postalCode
      rooms { id number name capacity kind faculty { id name } }
    } } }`;
    this.gql.request(q, { id: this.buildingId }).subscribe({
      next: (d: any) => {
        const b = d.buildings.building;
        this.building.set(b);
        this.loadRoomAccess(b?.rooms ?? []);
      },
      error: (e) => this.error.set(e.message)
    });
  }

  /**
   * One batched permission check for every room's «Редагувати» / «Видалити», the way `BaseEntity`
   * asks for the rows of a table. A university-wide MANAGE grant already answers each of them, and
   * anything weaker still has to ask, because a grant on an individual аудиторія can be stronger than
   * both the global one and the one on this корпус.
   */
  private loadRoomAccess(rooms: Room[]) {
    if (this.auth.globalLevel() === 'MANAGE' || rooms.length === 0) return;
    this.auth.accessLevels('ROOM', rooms.map((r) => String(r.id)))
      .subscribe({ next: (levels) => this.roomAccessById.set(levels), error: () => {} });
  }

  private loadFaculties() {
    const q = `query($limit: Int!) { faculties { facultyConnection(limit: $limit) { nodes { id name } } } }`;
    this.gql.request(q, { limit: 100 }).subscribe({
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
        if (res.isSuccess) this.router.navigate(['/building']);
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
