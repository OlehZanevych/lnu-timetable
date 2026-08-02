#!/usr/bin/env python3
"""
Rewrites data.sql for the class_start_time_sets refactor.

Three edits, all idempotent-checked (the script refuses to run twice):
  1. a new class_start_time_sets section, inserted before class_start_times (pg_dump orders
     sections by table name, and 'class_start_time_sets' < 'class_start_times');
  2. class_start_times inserts gain class_start_time_set_id, and two more sets get their own times;
  3. every lecturer_workloads insert gains class_start_time_set_id = 1 (the default set).
Plus the matching sequence resets.
"""
import re
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()

if 'class_start_time_sets' in src:
    sys.exit('data.sql already migrated — nothing to do')

DEFAULT_SET_ID = 1

# ── 1. the sets themselves ────────────────────────────────────────────────────
#
# One university-wide default carrying the existing eight bells, one university-wide alternative
# for physical education (the case that motivated sets in the first place), and one scoped to a
# single faculty so the faculty_id path has seed data to exercise. A faculty-scoped set is never
# the default — the DB rejects that combination outright.
SETS_SECTION = """--
-- Data for Name: class_start_time_sets; Type: TABLE DATA; Schema: public; Owner: -
--

ALTER TABLE public.class_start_time_sets DISABLE TRIGGER ALL;

INSERT INTO public.class_start_time_sets (id, name, is_default, faculty_id) VALUES (1, 'Основний розклад дзвінків', true, NULL);
INSERT INTO public.class_start_time_sets (id, name, is_default, faculty_id) VALUES (2, 'Фізичне виховання', false, NULL);
INSERT INTO public.class_start_time_sets (id, name, is_default, faculty_id) VALUES (3, 'Вечірні заняття (ФПМІ)', false, 1);


ALTER TABLE public.class_start_time_sets ENABLE TRIGGER ALL;


"""

marker = '--\n-- Data for Name: class_start_times; Type: TABLE DATA; Schema: public; Owner: -\n--\n'
if marker not in src:
    sys.exit('could not find the class_start_times data section header')
src = src.replace(marker, SETS_SECTION + marker, 1)

# ── 2. class_start_times: carry a set, and add the two extra grids ────────────
times_insert = re.compile(
    r"INSERT INTO public\.class_start_times \(id, ordinal, start_time\) VALUES \((\d+), (\d+), '([^']*)'\);")
count = len(times_insert.findall(src))
if count != 8:
    sys.exit(f'expected 8 class_start_times rows, found {count}')

src = times_insert.sub(
    lambda m: ('INSERT INTO public.class_start_times '
               f"(id, class_start_time_set_id, ordinal, start_time) VALUES ({m.group(1)}, {DEFAULT_SET_ID}, "
               f"{m.group(2)}, '{m.group(3)}');"),
    src)

# PE starts half an hour later and runs 90-minute slots, so a group can cross the city to a hall
# and back; the evening grid shifts the whole day past the working day.
EXTRA_TIMES = [
    (9, 2, 1, '09:00'), (10, 2, 2, '10:40'), (11, 2, 3, '12:20'),
    (12, 2, 4, '14:00'), (13, 2, 5, '15:40'),
    (14, 3, 1, '17:00'), (15, 3, 2, '18:30'), (16, 3, 3, '20:00'),
]
extra_sql = '\n'.join(
    'INSERT INTO public.class_start_times (id, class_start_time_set_id, ordinal, start_time) '
    f"VALUES ({i}, {s}, {o}, '{t}');"
    for i, s, o, t in EXTRA_TIMES)

last_default_time = ("INSERT INTO public.class_start_times (id, class_start_time_set_id, ordinal, "
                     f"start_time) VALUES (8, {DEFAULT_SET_ID}, 8, '19:40');")
if last_default_time not in src:
    sys.exit('could not find the last default-set start time to append after')
src = src.replace(last_default_time, last_default_time + '\n' + extra_sql, 1)

# ── 3. lecturer_workloads: every row scheduled on the default set ────────────
wl_insert = re.compile(
    r"INSERT INTO public\.lecturer_workloads \(id, working_curriculum_item_id, "
    r"combined_working_curriculum_item_id, duration_hours\) VALUES \(([^)]*)\);")
wl_count = len(wl_insert.findall(src))
if wl_count == 0:
    sys.exit('found no lecturer_workloads inserts')

src = wl_insert.sub(
    lambda m: ('INSERT INTO public.lecturer_workloads (id, working_curriculum_item_id, '
               'combined_working_curriculum_item_id, duration_hours, class_start_time_set_id) '
               f'VALUES ({m.group(1)}, {DEFAULT_SET_ID});'),
    src)

# ── 4. sequences ─────────────────────────────────────────────────────────────
old_seq = "SELECT pg_catalog.setval('public.class_start_times_id_seq', 8, true);"
if old_seq not in src:
    sys.exit('could not find the class_start_times sequence reset')
new_seq = """--
-- Name: class_start_time_sets_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.class_start_time_sets_id_seq', 3, true);


--
-- Name: class_start_times_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.class_start_times_id_seq', 16, true);"""

seq_header = ("--\n-- Name: class_start_times_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -\n--\n"
              "\n" + old_seq)
if seq_header not in src:
    sys.exit('could not find the class_start_times sequence block')
src = src.replace(seq_header, new_seq, 1)

open(path, 'w', encoding='utf-8').write(src)
print(f'ok: 3 sets, {count} + {len(EXTRA_TIMES)} start times, {wl_count} lecturer_workloads rows')
