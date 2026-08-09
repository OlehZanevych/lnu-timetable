import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';

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
      next: (d: any) => this.buildings.set(d.buildings.buildingConnection.nodes),
      error: (e) => this.error.set(e.message)
    });
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
