import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { GraphqlService } from './graphql.service';
import { ROOM_KIND_OPTIONS } from './entities';
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
 */
@Component({
  selector: 'app-room-page',
  templateUrl: './room-page.html',
  imports: [RouterLink, TimetableView]
})
export class RoomDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private gql = inject(GraphqlService);

  readonly roomId: string = this.route.snapshot.paramMap.get('id')!;

  readonly sections: { key: RoomSection; label: string }[] = [
    { key: 'info',      label: '&#x2139; Інформація' },
    { key: 'timetable', label: '&#x1F4C5; Розклад' }
  ];

  room = signal<RoomInfo | null>(null);
  error = signal('');
  activeSection = signal<RoomSection>('info');

  readonly roomIds = computed(() => [this.roomId]);

  label = computed(() => {
    const r = this.room();
    if (!r) return '';
    return r.name ? `${r.number} — ${r.name}` : r.number;
  });

  ngOnInit() { this.load(); }

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
}
