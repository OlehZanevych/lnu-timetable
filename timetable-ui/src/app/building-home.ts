import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';

interface Building {
  id: string;
  name: string;
  address?: string;
  city?: string;
  postalCode?: string;
}

@Component({
  selector: 'app-building-home',
  templateUrl: './building-home.html',
  imports: [RouterLink, FormsModule]
})
export class BuildingHome {
  private gql = inject(GraphqlService);
  private auth = inject(AuthService);

  /** This account's level on each корпус it can reach at all; absent means none. */
  private levels = signal<ReadonlyMap<string, AccessLevel>>(new Map());

  /**
   * A корпус is a declared `@PermissionRoot` — nothing owns it — so only a university-wide grant
   * creates one. That is why this button used to be the clearest symptom of the old heuristic: a
   * викладач holding one кафедра was offered «+ Додати корпус», and the service refused it.
   */
  canCreate(): boolean {
    return this.auth.canCreateType('BUILDING');
  }

  /** Editing a корпус needs EDIT on it, or university-wide. Deleting is not offered from this list. */
  canEdit(b: Building): boolean {
    return allows(maxLevel(this.auth.globalLevel(), this.levels().get(String(b.id))), 'EDIT');
  }

  buildings = signal<Building[]>([]);
  error = signal('');

  // Create form
  showCreateForm = signal(false);
  createError = signal('');
  createForm: Record<string, any> = {};

  // Edit form
  editingBuilding = signal<Building | null>(null);
  editError = signal('');
  editForm: Record<string, any> = {};

  constructor() {
    this.load();
  }

  load() {
    const q = `query($limit: Int!) { buildings { buildingConnection(limit: $limit) { nodes { id name address city postalCode } } } }`;
    this.gql.request(q, { limit: 200 }).subscribe({
      next: (d: any) => {
        const list = d.buildings.buildingConnection.nodes;
        this.buildings.set(list);
        this.loadPermissions(list.map((b: Building) => String(b.id)));
      },
      error: (e) => this.error.set(e.message)
    });
  }

  private loadPermissions(ids: string[]) {
    if (this.auth.globalLevel() === 'MANAGE' || !ids.length) return;
    this.auth.accessLevels('BUILDING', ids).subscribe((levels) => this.levels.set(levels));
  }

  // ── Create ────────────────────────────────────────────────────────────────

  openCreate() {
    this.createForm = {};
    this.createError.set('');
    this.showCreateForm.set(true);
  }

  closeCreate() {
    this.showCreateForm.set(false);
    this.createError.set('');
  }

  saveCreate() {
    const input: Record<string, any> = {};
    for (const f of ['name', 'address', 'city', 'postalCode']) {
      if (this.createForm[f]) input[f] = this.createForm[f];
    }
    const q = `mutation($input: BuildingInputPayload!) { buildings { createBuilding(building: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { input }).subscribe({
      next: (d: any) => {
        const res = d.buildings.createBuilding;
        if (res.isSuccess) { this.closeCreate(); this.load(); }
        else this.createError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.createError.set(e.message)
    });
  }

  // ── Edit ─────────────────────────────────────────────────────────────────

  openEdit(b: Building) {
    this.editForm = { name: b.name, address: b.address ?? '', city: b.city ?? '', postalCode: b.postalCode ?? '' };
    this.editError.set('');
    this.editingBuilding.set(b);
  }

  closeEdit() {
    this.editingBuilding.set(null);
    this.editError.set('');
  }

  saveEdit() {
    const b = this.editingBuilding();
    if (!b) return;
    const input: Record<string, any> = {};
    for (const f of ['name', 'address', 'city', 'postalCode']) {
      if (this.editForm[f] !== undefined && this.editForm[f] !== '') input[f] = this.editForm[f];
    }
    const q = `mutation($id: ID!, $input: BuildingInputPayload!) { buildings { updateBuilding(id: $id, building: $input) { isSuccess errorStatus } } }`;
    this.gql.request(q, { id: b.id, input }).subscribe({
      next: (d: any) => {
        const res = d.buildings.updateBuilding;
        if (res.isSuccess) { this.closeEdit(); this.load(); }
        else this.editError.set(res.errorStatus || 'Помилка операції');
      },
      error: (e) => this.editError.set(e.message)
    });
  }
}
