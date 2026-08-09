import { Component, OnInit, WritableSignal, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, map, of } from 'rxjs';
import { GqlVars, GraphqlService } from './graphql.service';
import { AuthService } from './auth.service';
import { AccessLevel, allows, maxLevel } from './access-level';
import { compareUk } from './sort';

interface BuildingRef {
  id: string;
  name: string;
  /** What the headers show — «вул. Університетська 1» rather than «Корпус на вул. …». */
  label: string;
}

/**
 * One cell of the matrix: the journey from one building to another.
 *
 * `id` is null until the row exists in the database, which is what tells a save whether the cell is
 * a create or an update — and an emptied cell that has an id is a delete. `original` is what the
 * server last said, so that «змінено» counts edits rather than keystrokes.
 */
interface Cell {
  fromId: string;
  toId: string;
  id: string | null;
  minutes: WritableSignal<string>;
  original: string;
  error: WritableSignal<string>;
}

/**
 * «Час переходу між корпусами» — the whole directed matrix on one screen.
 *
 * A group's day is a sequence of classes and the gap between two bells is fixed; when consecutive
 * classes sit in different корпуси, that gap has to cover the journey. This page is where the
 * length of that journey is written down.
 *
 * **Why a matrix and not a list of 342 rows.** The value being edited is not a row, it is a
 * relation between two buildings, and its neighbour — the same journey walked the other way — is
 * the thing a reader most wants to compare it against. A table sorts those two apart; a matrix puts
 * one at (i, j) and the other at (j, i), so an asymmetry is visible by looking across the diagonal
 * instead of by searching. Lviv is built on hills and those two numbers genuinely differ, which is
 * the whole reason the table is directed.
 *
 * Columns are numbered rather than named because nineteen building names will not fit across a
 * screen; the row headers carry the same numbers and the full names, so the legend is the table.
 */
@Component({
  selector: 'app-building-travel-times',
  templateUrl: './building-travel-times.html',
  imports: [FormsModule, RouterLink]
})
export class BuildingTravelTimesPage implements OnInit {
  private gql = inject(GraphqlService);
  auth = inject(AuthService);

  buildings = signal<BuildingRef[]>([]);
  private cells = signal<Map<string, Cell>>(new Map());

  loading = signal(false);
  saving = signal(false);
  error = signal('');
  saveError = signal('');
  saved = signal(0);

  /** This account's level on each корпус; a cell is governed by the stronger of its two ends. */
  private buildingLevels = signal<ReadonlyMap<string, AccessLevel>>(new Map());

  readonly key = (fromId: string, toId: string) => `${fromId}>${toId}`;

  cell(fromId: string, toId: string): Cell | undefined {
    return this.cells().get(this.key(fromId, toId));
  }

  /**
   * Whether this journey may be edited. The server ORs over an entity's permission parents and this
   * entity has two — both ends of the journey — so a деканат holding one корпус can correct the
   * walks into and out of it without a grant over the university.
   */
  canEdit(fromId: string, toId: string): boolean {
    return allows(this.cellLevel(fromId, toId), 'EDIT');
  }

  /**
   * Emptying a cell deletes the row, so it needs FULL rather than EDIT — the same split as every
   * «Видалити» button elsewhere, expressed here as "you may correct this walk but not erase it".
   */
  canClear(fromId: string, toId: string): boolean {
    return allows(this.cellLevel(fromId, toId), 'FULL');
  }

  private cellLevel(fromId: string, toId: string): AccessLevel | null {
    const levels = this.buildingLevels();
    return maxLevel(this.auth.globalLevel(), maxLevel(levels.get(fromId), levels.get(toId)));
  }

  /** Cells whose value differs from what the server last returned. */
  private changed = computed(() =>
    [...this.cells().values()].filter((c) => c.minutes().trim() !== c.original));

  changedCount = computed(() => this.changed().length);

  ngOnInit() {
    this.load();
  }

  private load() {
    this.loading.set(true);
    this.saved.set(0);
    const v = new GqlVars();
    const buildings = `${v.arg('limit', 'Int!', 500)}, ${v.arg('offset', 'Int!', 0)}`;
    // `limit`, not `timeLimit`: the variable is named apart from the buildings query's own limit
    // (GqlVars#ref numbers a colliding name whose value differs, giving $limit2), but the *argument*
    // is still the schema's `limit`. 19 корпусів make 342 ordered pairs, so one page holds them all.
    const times = `limit: ${v.ref('limit', 'Int!', 5000)}, ${v.arg('offset', 'Int!', 0)}`;
    const q = `${v.declaration()}{
      buildings { buildingConnection(${buildings}) { nodes { id name address } } }
      buildingTravelTimes { buildingTravelTimeConnection(${times}) { nodes {
        id minutes fromBuilding { id } toBuilding { id }
      } } }
    }`;
    this.gql.request(q, v.values).subscribe({
      next: (d: any) => {
        const list: BuildingRef[] = (d.buildings.buildingConnection.nodes ?? [])
          .map((b: any) => ({ id: String(b.id), name: b.name, label: b.address || b.name }))
          .sort((a: BuildingRef, b: BuildingRef) => compareUk(a.label, b.label));
        this.buildings.set(list);

        const stored = new Map<string, { id: string; minutes: number }>();
        for (const n of d.buildingTravelTimes.buildingTravelTimeConnection.nodes ?? []) {
          const from = String(n.fromBuilding?.id ?? '');
          const to = String(n.toBuilding?.id ?? '');
          if (from && to) stored.set(this.key(from, to), { id: String(n.id), minutes: n.minutes });
        }

        // Every ordered pair gets a cell, whether or not the database has a row for it: a blank
        // cell is how a missing journey is entered, and the matrix would otherwise have holes you
        // could look at but not fill.
        const cells = new Map<string, Cell>();
        for (const from of list) {
          for (const to of list) {
            if (from.id === to.id) continue;
            const k = this.key(from.id, to.id);
            const row = stored.get(k);
            const value = row ? String(row.minutes) : '';
            cells.set(k, {
              fromId: from.id, toId: to.id,
              id: row?.id ?? null,
              minutes: signal(value),
              original: value,
              error: signal('')
            });
          }
        }
        this.cells.set(cells);
        this.error.set('');
        this.loading.set(false);
        this.loadPermissions(list.map((b) => b.id));
      },
      error: (e) => { this.error.set(e.message); this.loading.set(false); }
    });
  }

  private loadPermissions(ids: string[]) {
    if (this.auth.globalLevel() === 'MANAGE' || !ids.length) return;
    this.auth.accessLevels('BUILDING', ids).subscribe((levels) => this.buildingLevels.set(levels));
  }

  /** Any cell at all — used to hide the save bar from an account that can only read. */
  canEditAnything = computed(() =>
    allows(this.auth.globalLevel(), 'EDIT')
    || [...this.buildingLevels().values()].some((level) => allows(level, 'EDIT')));

  onCellInput(cell: Cell, value: string) {
    cell.minutes.set(value);
    cell.error.set('');
    this.saved.set(0);
  }

  /** Copies each edited cell's value into the opposite direction, for the flat walks. */
  mirrorChanged() {
    for (const c of this.changed()) {
      const back = this.cells().get(this.key(c.toId, c.fromId));
      if (back) back.minutes.set(c.minutes().trim());
    }
  }

  revert() {
    for (const c of this.cells().values()) {
      c.minutes.set(c.original);
      c.error.set('');
    }
    this.saveError.set('');
    this.saved.set(0);
  }

  save() {
    const pending = this.changed();
    if (!pending.length || this.saving()) return;

    // Validate before sending anything: a half-applied matrix is worse than a refused one.
    let bad = 0;
    let forbiddenClears = 0;
    for (const c of pending) {
      const raw = c.minutes().trim();
      if (raw === '') {
        // An emptied cell is a delete, and deleting needs FULL. Caught here rather than left to
        // the server so the whole batch is refused together instead of half of it landing.
        if (c.id && !this.canClear(c.fromId, c.toId)) {
          c.error.set('Видалення потребує рівня «Повний доступ»');
          forbiddenClears++;
        }
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) { c.error.set('Ціле число хвилин, 0 або більше'); bad++; }
    }
    if (bad || forbiddenClears) {
      const parts = [];
      if (bad) parts.push(`${bad} комірк(и) містять не ціле число хвилин`);
      if (forbiddenClears) parts.push(`${forbiddenClears} комірк(и) очищено без права видалення`);
      this.saveError.set(`Не збережено: ${parts.join('; ')}.`);
      return;
    }

    this.saving.set(true);
    this.saveError.set('');
    const calls = pending.map((c) => this.mutationFor(c));
    forkJoin(calls).subscribe({
      next: (results: any[]) => {
        const failed = results.filter((r) => r && !r.isSuccess);
        this.saving.set(false);
        if (failed.length) {
          this.saveError.set(`${failed.length} з ${results.length} змін не збережено (${failed[0].errorStatus || 'помилка'}).`);
        } else {
          this.saved.set(results.length);
        }
        this.load();                                   // whatever happened, redraw from the server
      },
      error: (e) => { this.saving.set(false); this.saveError.set(e.message); }
    });
  }

  private mutationFor(c: Cell) {
    const raw = c.minutes().trim();

    if (raw === '') {
      if (!c.id) return of(null);                      // blank and never stored: nothing to do
      const q = `mutation($id: ID!) { buildingTravelTimes { deleteBuildingTravelTime(id: $id) { isSuccess errorStatus } } }`;
      return this.gql.request(q, { id: c.id })
        .pipe(map((d: any) => d.buildingTravelTimes.deleteBuildingTravelTime));
    }

    const input = { minutes: Number(raw), fromBuildingId: c.fromId, toBuildingId: c.toId };
    if (c.id) {
      const q = `mutation($id: ID!, $input: BuildingTravelTimeInputPayload!) { buildingTravelTimes {
        updateBuildingTravelTime(id: $id, buildingTravelTime: $input) { isSuccess errorStatus }
      } }`;
      return this.gql.request(q, { id: c.id, input })
        .pipe(map((d: any) => d.buildingTravelTimes.updateBuildingTravelTime));
    }
    const q = `mutation($input: BuildingTravelTimeInputPayload!) { buildingTravelTimes {
      createBuildingTravelTime(buildingTravelTime: $input) { isSuccess errorStatus }
    } }`;
    return this.gql.request(q, { input })
      .pipe(map((d: any) => d.buildingTravelTimes.createBuildingTravelTime));
  }
}

