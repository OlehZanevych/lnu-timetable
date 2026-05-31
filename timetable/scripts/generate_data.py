#!/usr/bin/env python3
"""Generate src/main/resources/db/data.sql from the article's variant-4 UCTP instance.

Maps the C++ instance (L=60 lecturers, G=40 groups, A=20 rooms, V=500 class requirements)
and a solved schedule into the richer LNU timetabling schema. Run from the timetable project:
    python3 scripts/generate_data.py
"""
import csv, os

ART = os.path.expanduser("~/Education/Articles/memetic-algorithms/enhanced-ma-mathematical-modeling-and-computing-2026")
REQ = f"{ART}/data/variant4/requirements.csv"
SCH = f"{ART}/results/v4_ma_adaptive/seed1000/schedule.csv"   # a solved variant-4 timetable
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "main", "resources", "db", "data.sql")

L, G, A = 60, 40, 20
DEPTS, SPECS, FACS, COURSES = 4, 4, 2, 24
PARITY = {"weekly": "WEEKLY", "numerator": "NUMERATOR", "denominator": "DENOMINATOR"}
SURNAMES = ["Петренко","Коваленко","Шевченко","Іванчук","Бондар","Мельник","Романюк","Ткаченко",
            "Лисенко","Поліщук","Кравець","Гриценко","Савчук","Бойко","Марченко","Гаврилюк"]
FIRST = ["Іван","Олена","Петро","Марія","Андрій","Софія","Дмитро","Ірина","Тарас","Наталія"]
KINDS = ["LECTURE_HALL","COMPUTER_LAB","SEMINAR_ROOM"]


def rows(path):
    with open(path) as f:
        return list(csv.DictReader(f))


def vals(tuples):
    return ",\n".join(" (" + ", ".join(t) + ")" for t in tuples) + ";\n"


def q(s):
    return "'" + s.replace("'", "''") + "'"


reqs = rows(REQ)
sched = {int(r["req_id"]): r for r in rows(SCH)}

out = []
out.append("-- Generated from article variant 4 (V=500, L=60, G=40, A=20) by scripts/generate_data.py\n")

# Faculties
out.append("INSERT INTO faculties (id, name, abbreviation, email) VALUES")
out.append(vals([(str(i + 1), q(f"Faculty {i + 1}"), q(f"Ф{i + 1}"), q(f"faculty{i + 1}@lnu.edu.ua")) for i in range(FACS)]))
out.append(f"SELECT setval('faculties_id_seq', {FACS});\n")

# Departments
out.append("INSERT INTO departments (id, name, abbreviation, faculty_id) VALUES")
out.append(vals([(str(i + 1), q(f"Department {i + 1}"), q(f"К{i + 1}"), str(i % FACS + 1)) for i in range(DEPTS)]))
out.append(f"SELECT setval('departments_id_seq', {DEPTS});\n")

# Specialties
specs = [("122", "Computer Science"), ("124", "System Analysis"), ("113", "Applied Mathematics"), ("121", "Software Engineering")]
out.append("INSERT INTO specialties (id, code, name, degree, faculty_id) VALUES")
out.append(vals([(str(i + 1), q(specs[i][0]), q(specs[i][1]), q("BACHELOR"), str(i % FACS + 1)) for i in range(SPECS)]))
out.append(f"SELECT setval('specialties_id_seq', {SPECS});\n")

# Courses (discipline pool)
out.append("INSERT INTO courses (id, code, name, ects_credits, department_id) VALUES")
out.append(vals([(str(i + 1), q(f"D-{i + 1:02d}"), q(f"Discipline {i + 1:02d}"), str(3 + i % 4), str(i % DEPTS + 1)) for i in range(COURSES)]))
out.append(f"SELECT setval('courses_id_seq', {COURSES});\n")

# Curricula + items + working curricula + items (one chain per specialty)
out.append("INSERT INTO curricula (id, name, admission_year, degree, specialty_id) VALUES")
out.append(vals([(str(i + 1), q(f"{specs[i][1]} (Bachelor) 2023"), "2023", q("BACHELOR"), str(i + 1)) for i in range(SPECS)]))
out.append(f"SELECT setval('curricula_id_seq', {SPECS});\n")

ci = [(str(k + 1), str(k % 6 + 1), q("EXAM" if k % 2 == 0 else "CREDIT"), str(3 + k % 4), str(k % SPECS + 1), str(k + 1)) for k in range(8)]
out.append("INSERT INTO curriculum_items (id, semester, control_form, ects_credits, curriculum_id, course_id) VALUES")
out.append(vals(ci))
out.append(f"SELECT setval('curriculum_items_id_seq', {len(ci)});\n")

out.append("INSERT INTO working_curricula (id, academic_year, semester, curriculum_id) VALUES")
out.append(vals([(str(i + 1), q("2025/2026"), "1", str(i + 1)) for i in range(SPECS)]))
out.append(f"SELECT setval('working_curricula_id_seq', {SPECS});\n")

wci = [(str(k + 1), "32", "0", "16", "0", str(k % SPECS + 1), str(k + 1)) for k in range(8)]
out.append("INSERT INTO working_curriculum_items (id, lecture_hours, practical_hours, lab_hours, seminar_hours, working_curriculum_id, course_id) VALUES")
out.append(vals(wci))
out.append(f"SELECT setval('working_curriculum_items_id_seq', {len(wci)});\n")

# Lecturers (60)
out.append("INSERT INTO lecturers (id, first_name, last_name, email, position, department_id) VALUES")
out.append(vals([(str(i + 1), q(FIRST[i % len(FIRST)]), q(f"{SURNAMES[i % len(SURNAMES)]}"),
                  q(f"lect{i + 1}@lnu.edu.ua"), q(["ASSISTANT","SENIOR_LECTURER","DOCENT","PROFESSOR"][i % 4]),
                  str(i % DEPTS + 1)) for i in range(L)]))
out.append(f"SELECT setval('lecturers_id_seq', {L});\n")

# Academic groups (40)
out.append("INSERT INTO academic_groups (id, name, course_year, study_form, students_count, specialty_id) VALUES")
out.append(vals([(str(i + 1), q(f"Grp-{i + 1:02d}"), str(i % 4 + 1), q("FULL_TIME"), str(20 + i % 11), str(i % SPECS + 1)) for i in range(G)]))
out.append(f"SELECT setval('academic_groups_id_seq', {G});\n")

# One student per group
out.append("INSERT INTO students (id, first_name, last_name, email, academic_group_id) VALUES")
out.append(vals([(str(i + 1), q(FIRST[i % len(FIRST)]), q(SURNAMES[(i + 3) % len(SURNAMES)]), q(f"stud{i + 1}@lnu.edu.ua"), str(i + 1)) for i in range(G)]))
out.append(f"SELECT setval('students_id_seq', {G});\n")

# Rooms (20)
out.append("INSERT INTO rooms (id, number, building, capacity, kind, faculty_id) VALUES")
out.append(vals([(str(i + 1), q(str(100 + i)), q(f"Building {i % 3 + 1}"), str(30 + (i % 4) * 30), q(KINDS[i % 3]), str(i % FACS + 1)) for i in range(A)]))
out.append(f"SELECT setval('rooms_id_seq', {A});\n")

# Time slots (6)
slots = [("08:30","09:50"),("10:10","11:30"),("11:50","13:10"),("13:30","14:50"),("15:05","16:25"),("16:40","18:00")]
out.append("INSERT INTO time_slots (id, ordinal, start_time, end_time) VALUES")
out.append(vals([(str(i + 1), str(i + 1), q(slots[i][0]), q(slots[i][1])) for i in range(6)]))
out.append("SELECT setval('time_slots_id_seq', 6);\n")

# Combined groups: dedup multi-group requirement audiences
combined = {}            # sorted tuple of group ids -> combined_group_id
members = []             # (cg_id, academic_group_id)
for r in reqs:
    gs = [int(x) for x in r["group_ids"].split(";") if x != ""]
    if len(gs) > 1:
        key = tuple(sorted(gs))
        if key not in combined:
            cid = len(combined) + 1
            combined[key] = cid
            for g in key:
                members.append((cid, g + 1))
if combined:
    out.append("INSERT INTO combined_groups (id, name, purpose) VALUES")
    out.append(vals([(str(cid), q(f"Combined-{cid:02d}"), q("Elective audience")) for _, cid in sorted(combined.items(), key=lambda kv: kv[1])]))
    out.append(f"SELECT setval('combined_groups_id_seq', {len(combined)});\n")
    out.append("INSERT INTO combined_group_academic_groups (combined_group_id, academic_group_id) VALUES")
    out.append(vals([(str(c), str(a)) for c, a in members]))

# Lecturer workloads (500 class requirements)
wl = []
for r in reqs:
    rid = int(r["req_id"])
    lec = int(r["lecturer_id"])
    gs = [int(x) for x in r["group_ids"].split(";") if x != ""]
    periodicity = "WEEKLY" if r["freq"] == "0" else "BIWEEKLY"
    if len(gs) > 1:
        ctype, ag, cg = "LECTURE", "NULL", str(combined[tuple(sorted(gs))])
    elif len(gs) == 1:
        ctype, ag, cg = ["PRACTICAL", "LAB", "SEMINAR"][rid % 3], str(gs[0] + 1), "NULL"
    else:
        ctype, ag, cg = "LECTURE", "NULL", "NULL"
    wl.append((str(rid + 1), q(ctype), q(periodicity), "1", str(lec + 1), str(rid % COURSES + 1), ag, cg))
out.append("INSERT INTO lecturer_workloads (id, class_type, periodicity, hours_per_week, lecturer_id, course_id, academic_group_id, combined_group_id) VALUES")
out.append(vals(wl))
out.append(f"SELECT setval('lecturer_workloads_id_seq', {len(wl)});\n")

# Timetable entries (the solved schedule)
te = []
for rid, s in sorted(sched.items()):
    te.append((str(rid + 1), str(int(s["day"]) + 1), q(PARITY[s["freq"]]), str(rid + 1), str(int(s["slot"]) + 1), str(int(s["room"]) + 1)))
out.append("INSERT INTO timetable_entries (id, day_of_week, week_parity, workload_id, time_slot_id, room_id) VALUES")
out.append(vals(te))
out.append(f"SELECT setval('timetable_entries_id_seq', {len(te)});\n")

with open(os.path.abspath(OUT), "w") as f:
    f.write("".join(out))
print(f"Wrote {os.path.abspath(OUT)}: {len(wl)} workloads, {len(te)} timetable entries, {len(combined)} combined groups")
