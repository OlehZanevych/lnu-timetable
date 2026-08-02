#!/usr/bin/env python3
"""
Seeds rooms and room groups in data.sql.

`rooms` is checked in empty, so room groups would have had nothing to hold and the feature would
look broken when it isn't (the same trap the README already documents for `students`). A small,
realistic set of rooms is therefore seeded alongside the groups — enough to exercise all three
group scopes: university-wide, faculty-scoped, and department-scoped.

Idempotent-checked: refuses to run twice.
"""
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()

if 'public.room_groups' in src:
    sys.exit('data.sql already has room groups — nothing to do')

# rooms columns: (id, building_id, number, name, capacity, kind, faculty_id)
# Faculty 1 = ФПМІ, 2 = ММФ; building 1 = Університетська 1, 8 = Ген. Чупринки 49.
# The sports halls belong to no faculty — they are shared, which is exactly why a university-wide
# room group is the natural way to reach them.
ROOMS = [
    (1,  1, '241',  "Комп'ютерний клас",              30,  'COMPUTER_LAB', 1),
    (2,  1, '242',  "Комп'ютерний клас",              30,  'COMPUTER_LAB', 1),
    (3,  1, '243',  "Комп'ютерний клас",              24,  'COMPUTER_LAB', 1),
    (4,  1, '244',  "Лабораторія інформаційних систем", 20, 'COMPUTER_LAB', 1),
    (5,  1, '251',  'Семінарська аудиторія',          25,  'SEMINAR_ROOM', 1),
    (6,  1, '377',  'Велика потокова аудиторія',      120, 'LECTURE_HALL', 1),
    (7,  1, '115',  'Механіко-математична аудиторія', 100, 'LECTURE_HALL', 2),
    (8,  1, '372',  'Семінарська аудиторія',          28,  'SEMINAR_ROOM', 2),
    (9,  1, '373',  'Семінарська аудиторія',          28,  'SEMINAR_ROOM', 2),
    (10, 8, 'СЗ-1', 'Велика спортивна зала',          60,  None,           None),
    (11, 8, 'СЗ-2', 'Мала спортивна зала',            30,  None,           None),
]

# (id, name, purpose, faculty_id, department_id) — faculty_id and department_id are exclusive.
# Department 2 is "Кафедра інформаційних систем" (faculty 1).
GROUPS = [
    (1, 'Спортивні зали', 'Заняття з фізичного виховання', None, None),
    (2, 'Потокові аудиторії', 'Лекції для великих потоків', None, None),
    (3, "Комп'ютерні класи", 'Лабораторні заняття з програмування', 1, None),
    (4, 'Лабораторії кафедри', 'Спеціалізовані лабораторії кафедри', None, 2),
]

MEMBERS = [
    (1, 10), (1, 11),
    (2, 6), (2, 7),
    (3, 1), (3, 2), (3, 3), (3, 4),
    (4, 3), (4, 4),
]


def sql_str(v):
    return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"


def sql_num(v):
    return 'NULL' if v is None else str(v)


# ── 1. fill the empty rooms section ──────────────────────────────────────────
rooms_sql = '\n'.join(
    'INSERT INTO public.rooms (id, building_id, number, name, capacity, kind, faculty_id) '
    f'VALUES ({i}, {sql_num(b)}, {sql_str(num)}, {sql_str(name)}, {sql_num(cap)}, '
    f'{sql_str(kind)}, {sql_num(fac)});'
    for i, b, num, name, cap, kind, fac in ROOMS)

empty_rooms = ('ALTER TABLE public.rooms DISABLE TRIGGER ALL;\n\n\n\n'
               'ALTER TABLE public.rooms ENABLE TRIGGER ALL;')
if empty_rooms not in src:
    sys.exit('the rooms data section is not in the expected empty shape')
src = src.replace(empty_rooms,
                  'ALTER TABLE public.rooms DISABLE TRIGGER ALL;\n\n'
                  + rooms_sql
                  + '\n\n\nALTER TABLE public.rooms ENABLE TRIGGER ALL;', 1)

# ── 2. the groups and their membership, after rooms (both reference it) ──────
groups_sql = '\n'.join(
    'INSERT INTO public.room_groups (id, name, purpose, faculty_id, department_id) '
    f'VALUES ({i}, {sql_str(name)}, {sql_str(purpose)}, {sql_num(fac)}, {sql_num(dep)});'
    for i, name, purpose, fac, dep in GROUPS)
members_sql = '\n'.join(
    f'INSERT INTO public.room_group_rooms (room_group_id, room_id) VALUES ({g}, {r});'
    for g, r in MEMBERS)

SECTIONS = f"""--
-- Data for Name: room_groups; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.room_groups DISABLE TRIGGER ALL;

{groups_sql}


ALTER TABLE public.room_groups ENABLE TRIGGER ALL;

--
-- Data for Name: room_group_rooms; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.room_group_rooms DISABLE TRIGGER ALL;

{members_sql}


ALTER TABLE public.room_group_rooms ENABLE TRIGGER ALL;

"""

tail = '--\n-- Data for Name: timetable_entries; Type: TABLE DATA; Schema: public; Owner: -\n--\n'
anchor = 'ALTER TABLE public.rooms ENABLE TRIGGER ALL;\n\n' + tail
if anchor not in src:
    sys.exit('could not find the section boundary after rooms')
src = src.replace(anchor,
                  'ALTER TABLE public.rooms ENABLE TRIGGER ALL;\n\n' + SECTIONS + tail, 1)

# ── 3. sequences ─────────────────────────────────────────────────────────────
old_seq = "SELECT pg_catalog.setval('public.rooms_id_seq', 1, false);"
if old_seq not in src:
    sys.exit('could not find the rooms sequence reset')
src = src.replace(old_seq, f"""SELECT pg_catalog.setval('public.rooms_id_seq', {len(ROOMS)}, true);


--
-- Name: room_groups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.room_groups_id_seq', {len(GROUPS)}, true);""", 1)

open(path, 'w', encoding='utf-8').write(src)
print(f'ok: {len(ROOMS)} rooms, {len(GROUPS)} room groups, {len(MEMBERS)} memberships')
