#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stage 2 of the LNU import pipeline: turn the scraped JSON into data.sql.

Reads the directory produced by ``scrape_lnu.py`` and emits a single SQL script
that can replace ``src/main/resources/db/data.sql``.  Nothing from the previous
data.sql is carried over: every id is assigned from 1 in insertion order, and
the file ends with the matching ``setval`` calls.

Order of work (this is what makes cross-faculty references resolve):

  1. buildings, faculties, departments, specialties, lecturers are generated
     *first*, and indexed by normalised name;
  2. only then are the curricula walked, so a course whose page says
     "Кафедра: алгебри, топології та основ математики" (a Mechmat department on
     an AMI course page) or whose lecturer works at another faculty can be
     matched by name against the already-generated rows.

Elective handling: a curriculum row like
"Дисципліна на вибір 1: <A> <B>" becomes a parent course named **ДВ** with
``course_type = 'ELECTIVE_GROUP'`` and two ``course_tags`` — the specialty name
and ``семестр <n>`` — while A and B become ``ELECTIVE`` child courses pointing at
it via ``parent_course_id``.

Usage
-----
    python3 build_sql.py                       # data/ -> generated/data.sql
    python3 build_sql.py -i data -o ../../src/main/resources/db/data.sql
    python3 build_sql.py --no-auth             # omit the seeded users/permissions
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from typing import Any, Iterable

LOG = logging.getLogger("build")
HERE = os.path.dirname(os.path.abspath(__file__))

CONTROL_FORM_DEFAULT = "CREDIT"
DEFAULT_CLASS_DURATION_HOURS = 2

ACADEMIC_DEGREES = [
    (1, "Кандидат наук", "к.н.", 1),
    (2, "Доктор філософії", "PhD", 2),
    (3, "Доктор наук", "д-р н.", 3),
]

CLASS_START_TIMES = ["08:30", "10:10", "11:50", "13:30", "15:05", "16:40"]

GLOBAL_PROPERTIES = [
    ("academic_hour_duration_minutes", "INTEGER", "40"),
    ("semester_duration_weeks", "INTEGER", "16"),
    ("current_semester_parity", "ENUM", "ODD"),
    ("default_class_duration_hours", "INTEGER", str(DEFAULT_CLASS_DURATION_HOURS)),
]

# Kept byte-for-byte from the previous data.sql so the documented local
# credentials (Admin#2026 / Temp#12345) keep working.
ADMIN_HASH = "$2b$10$aU2Ny.wmIvCtafhZ4S9Vz.m/JY8hlWi4XZfjrqKHVbNDSP8yDRD2e"
TEMP_HASH = "$2b$10$EPun8nZjuzjdnDbi8akF/OQI16Qq7VgcoLyQizwv3IMu4dAko7At6"

HOUR_TYPES = ("LECTURE", "PRACTICAL", "LAB", "INDEPENDENT_WORK")
# Hour types that translate into scheduled classes; INDEPENDENT_WORK does not.
SCHEDULED_HOUR_TYPES = ("LECTURE", "PRACTICAL", "LAB")

STOPWORDS = {"та", "і", "й", "з", "із", "на", "у", "в", "для"}


# ----------------------------------------------------------------------------
# Text helpers (kept in sync with scrape_lnu.py)
# ----------------------------------------------------------------------------

def norm_ws(text: str | None) -> str:
    if not text:
        return ""
    text = unicodedata.normalize("NFC", str(text))
    text = text.replace("’", "'").replace("ʼ", "'").replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def match_key(text: str | None) -> str:
    text = norm_ws(text).lower()
    text = re.sub(r"^\s*кафедр[аи]\s+", "", text)
    text = re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def q(value: Any) -> str:
    """Render a Python value as a SQL literal."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def truncate(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    value = norm_ws(value)
    return value[:limit] if value else None


class Unique:
    """Assigns collision-free values for a UNIQUE column.

    ``departments.name``, ``faculties.abbreviation``, ``academic_groups.name``
    and friends are unique across the whole table, but the source data is not
    (two faculties genuinely both have a "Кафедра філософії"), so the second
    occurrence gets a disambiguating suffix rather than breaking the load.
    """

    def __init__(self, label: str, limit: int):
        self.label = label
        self.limit = limit
        self.used: set[str] = set()
        self.collisions = 0

    def take(self, value: str, hint: str = "") -> str:
        value = (norm_ws(value) or "?")[:self.limit]
        if value not in self.used:
            self.used.add(value)
            return value
        self.collisions += 1
        if hint:
            candidate = f"{value} ({hint})"[:self.limit]
            if candidate not in self.used:
                self.used.add(candidate)
                LOG.debug("%s: '%s' taken, using '%s'", self.label, value, candidate)
                return candidate
        for n in range(2, 1000):
            suffix = f" {n}"
            candidate = (value[:self.limit - len(suffix)] + suffix)
            if candidate not in self.used:
                self.used.add(candidate)
                LOG.debug("%s: '%s' taken, using '%s'", self.label, value, candidate)
                return candidate
        raise RuntimeError(f"cannot make {self.label} unique for {value!r}")


class Table:
    """An ordered set of rows with auto-incrementing ids."""

    def __init__(self, name: str, columns: Iterable[str], has_id: bool = True):
        self.name = name
        self.columns = list(columns)
        self.has_id = has_id
        self.rows: list[tuple] = []

    def add(self, *values) -> int:
        if self.has_id:
            new_id = len(self.rows) + 1
            self.rows.append((new_id,) + tuple(values))
            return new_id
        self.rows.append(tuple(values))
        return 0

    def __len__(self) -> int:
        return len(self.rows)

    def to_sql(self) -> str:
        if not self.rows:
            return f"-- {self.name}: no rows\n"
        columns = (["id"] if self.has_id else []) + self.columns
        quoted = ", ".join(f'"{c}"' if c in ("position",) else c for c in columns)
        head = f"-- {self.name} ({len(self.rows)} rows)\n"
        lines = [f"INSERT INTO public.{self.name} ({quoted}) VALUES ("
                 + ", ".join(q(v) for v in row) + ");" for row in self.rows]
        return head + "\n".join(lines) + "\n\n"


# ----------------------------------------------------------------------------
# Generator
# ----------------------------------------------------------------------------

class Builder:
    def __init__(self, data: dict[str, Any], args: argparse.Namespace):
        self.args = args
        self.data = data
        self.problems: list[str] = []
        self.notes: Counter = Counter()

        self.t_buildings = Table("buildings", ["name", "address", "city", "postal_code"])
        self.t_faculties = Table("faculties", ["name", "abbreviation", "website", "email",
                                               "phone", "building_id"])
        self.t_departments = Table("departments", ["name", "abbreviation", "faculty_id",
                                                   "email", "phone"])
        self.t_specialties = Table("specialties", ["code", "name", "degree", "faculty_id"])
        self.t_lecturers = Table("lecturers", ["first_name", "middle_name", "last_name",
                                               "email", "position", "academic_degree_id",
                                               "min_hours_per_week", "max_hours_per_week",
                                               "department_id"])
        self.t_groups = Table("academic_groups", ["name", "course_year", "study_form",
                                                  "students_count", "specialty_id"])
        self.t_courses = Table("courses", ["name", "course_type", "faculty_id",
                                           "department_id", "parent_course_id"])
        self.t_course_specialties = Table("course_specialties",
                                          ["course_id", "specialty_id"], has_id=False)
        self.t_course_tags = Table("course_tags", ["course_id", "tag"])
        self.t_curriculum_items = Table("curriculum_items", ["semester", "control_form",
                                                             "ects_credits", "specialty_id",
                                                             "course_id"])
        self.t_hours = Table("curriculum_item_hours", ["curriculum_item_id", "hour_type", "hours"])
        self.t_wci = Table("working_curriculum_items", ["curriculum_item_hours_id",
                                                        "lecturer_count", "teaching_format",
                                                        "department_id", "course_id"])
        self.t_wci_groups = Table("working_curriculum_item_groups",
                                  ["working_curriculum_item_id", "academic_group_id"],
                                  has_id=False)
        self.t_cwci = Table("combined_working_curriculum_items", [])
        self.t_cwci_members = Table("combined_working_curriculum_item_members",
                                    ["combined_working_curriculum_item_id",
                                     "working_curriculum_item_id"], has_id=False)
        self.t_workloads = Table("lecturer_workloads", ["working_curriculum_item_id",
                                                        "combined_working_curriculum_item_id",
                                                        "duration_hours"])
        self.t_workload_lecturers = Table("lecturer_workload_lecturers",
                                          ["lecturer_workload_id", "lecturer_id"], has_id=False)
        self.t_workload_groups = Table("lecturer_workload_academic_groups",
                                       ["lecturer_workload_id", "academic_group_id"],
                                       has_id=False)
        self.t_class_start_times = Table("class_start_times", ["ordinal", "start_time"])

        # Lookups
        self.building_ids: dict[str, int] = {}
        self.faculty_by_host: dict[str, int] = {}
        self.faculty_abbrev: dict[int, str] = {}
        self.department_by_url: dict[str, int] = {}
        self.department_by_key: dict[str, int] = {}
        self.department_faculty: dict[int, int] = {}
        self.specialty_by_key: dict[tuple[str, str, str], int] = {}
        self.specialty_name: dict[int, str] = {}
        self.specialty_faculty: dict[int, int] = {}
        self.lecturer_by_url: dict[str, int] = {}
        self.lecturer_by_name: dict[str, int] = {}
        self.lecturer_by_short: dict[str, list[int]] = defaultdict(list)
        self.group_ids: dict[str, int] = {}
        self.course_by_url: dict[str, int] = {}
        self.course_department: dict[int, int | None] = {}
        self.course_pages: dict[str, dict] = {}

        self.u_building = Unique("buildings.name", 120)
        self.u_faculty_name = Unique("faculties.name", 160)
        self.u_faculty_abbrev = Unique("faculties.abbreviation", 32)
        self.u_department_name = Unique("departments.name", 160)
        self.u_department_abbrev = Unique("departments.abbreviation", 32)
        self.u_group = Unique("academic_groups.name", 32)
        self.u_lecturer_email = Unique("lecturers.email", 64)

        self.seen_specialty_names: set[tuple[str, str]] = set()
        self.seen_curriculum_items: set[tuple[int, int, int]] = set()
        self.seen_course_specialties: set[tuple[int, int]] = set()
        self.seen_tags: set[tuple[int, str]] = set()
        self.seen_hours: set[tuple[int, str]] = set()

    def problem(self, message: str) -> None:
        self.problems.append(message)
        LOG.warning(message)

    # ------------------------------------------------------------------ 1-5

    def build_organisation(self) -> None:
        payload = self.data["faculties"]
        LOG.info("--- buildings & faculties ---")
        for building in payload.get("buildings", []):
            name = self.u_building.take(building["name"])
            self.building_ids[building["name"]] = self.t_buildings.add(
                name, truncate(building.get("address"), 160),
                truncate(building.get("city"), 64), truncate(building.get("postal_code"), 10))
        LOG.info("buildings: %d", len(self.t_buildings))

        for faculty in payload.get("faculties", []):
            abbrev = self.u_faculty_abbrev.take(faculty.get("abbreviation") or "Ф")
            fid = self.t_faculties.add(
                self.u_faculty_name.take(faculty["name"]),
                abbrev,
                truncate(faculty.get("website"), 128),
                truncate(faculty.get("email"), 64),
                truncate(faculty.get("phone"), 128),
                self.building_ids.get(faculty.get("building_name") or ""),
            )
            self.faculty_by_host[faculty["host"]] = fid
            self.faculty_abbrev[fid] = abbrev
        LOG.info("faculties: %d", len(self.t_faculties))

        LOG.info("--- departments ---")
        for department in self.data["departments"]:
            faculty_id = self.faculty_by_host.get(department["faculty_host"])
            if faculty_id is None:
                self.problem(f"department {department['url']}: unknown faculty host "
                             f"{department['faculty_host']}")
                continue
            key = department["match_key"]
            if key in self.department_by_key:
                # Same department reachable from two pages -> reuse the row.
                self.department_by_url[department["url"]] = self.department_by_key[key]
                self.notes["department_deduplicated"] += 1
                continue
            hint = self.faculty_abbrev.get(faculty_id, "")
            did = self.t_departments.add(
                self.u_department_name.take(department["name"], hint),
                self.u_department_abbrev.take(department["abbreviation"], hint),
                faculty_id,
                truncate(department.get("email"), 64),
                truncate(department.get("phone"), 64),
            )
            self.department_by_url[department["url"]] = did
            self.department_by_key[key] = did
            self.department_faculty[did] = faculty_id
        LOG.info("departments: %d (%d duplicates merged)", len(self.t_departments),
                 self.notes["department_deduplicated"])

        LOG.info("--- specialties ---")
        for specialty in self.data["specialties"]:
            faculty_id = self.faculty_by_host.get(specialty["faculty_host"])
            if faculty_id is None:
                self.problem(f"specialty {specialty['code']}: unknown faculty host")
                continue
            key = (specialty["faculty_host"], specialty["code"], specialty["degree"])
            if key in self.specialty_by_key:
                continue
            name = norm_ws(specialty["name"])
            if (name.lower(), specialty["degree"]) in self.seen_specialty_names:
                name = f"{name} ({self.faculty_abbrev[faculty_id]})"[:160]
                self.notes["specialty_name_disambiguated"] += 1
            self.seen_specialty_names.add((name.lower(), specialty["degree"]))
            sid = self.t_specialties.add(truncate(specialty["code"], 16), name,
                                         specialty["degree"], faculty_id)
            self.specialty_by_key[key] = sid
            self.specialty_name[sid] = name
            self.specialty_faculty[sid] = faculty_id
        LOG.info("specialties: %d", len(self.t_specialties))

        LOG.info("--- lecturers ---")
        by_email: dict[str, int] = {}
        for lecturer in self.data["lecturers"]:
            department_id = self.department_by_url.get(lecturer["department_url"])
            if department_id is None:
                department_id = self.department_by_key.get(lecturer.get("department_key", ""))
            if department_id is None:
                self.problem(f"lecturer {lecturer['url']}: department not found "
                             f"({lecturer['department_url']})")
                continue
            email = truncate(lecturer.get("email"), 64)
            if email and email.lower() in by_email:
                # The same person listed under two departments (сумісник).
                lid = by_email[email.lower()]
                self.lecturer_by_url[lecturer["url"]] = lid
                self.notes["lecturer_deduplicated"] += 1
                continue
            lid = self.t_lecturers.add(
                truncate(lecturer["first_name"], 64),
                truncate(lecturer.get("middle_name"), 64),
                truncate(lecturer["last_name"], 64),
                email.lower() if email else None,
                lecturer["position"],
                lecturer.get("academic_degree_id"),
                None, None,
                department_id,
            )
            if email:
                by_email[email.lower()] = lid
            self.lecturer_by_url[lecturer["url"]] = lid
            if lecturer.get("name_key"):
                self.lecturer_by_name.setdefault(lecturer["name_key"], lid)
            short = self._short_key(lecturer["last_name"], lecturer["first_name"],
                                    lecturer.get("middle_name") or "")
            self.lecturer_by_short[short].append(lid)
        LOG.info("lecturers: %d (%d duplicates merged)", len(self.t_lecturers),
                 self.notes["lecturer_deduplicated"])

    @staticmethod
    def _short_key(last: str, first: str, middle: str) -> str:
        parts = [norm_ws(last).lower()]
        if first:
            parts.append(first[0].lower())
        if middle:
            parts.append(middle[0].lower())
        return " ".join(parts)

    @staticmethod
    def _label_short_key(label: str) -> str:
        text = norm_ws(label).lower()
        text = re.sub(r"\(.*?\)", " ", text)
        for title in ("завідувач кафедри", "завідувач", "професор", "доцент",
                      "старший викладач", "ст. наук. співробітник", "ст. викладач",
                      "асистент", "викладач", "проф.", "доц."):
            text = text.replace(title, " ")
        text = re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)
        parts = [p for p in text.split() if p]
        if not parts:
            return ""
        return " ".join([parts[0]] + [p[0] for p in parts[1:3]])

    # -------------------------------------------------------------------- 6

    def resolve_department(self, course_page: dict, faculty_id: int) -> int | None:
        """Find the department that owns a course, creating one if need be.

        The course page names its department in prose ("Кафедра: алгебри,
        топології та основ математики") and that department frequently belongs
        to *another* faculty, which is why every department row exists before
        this runs.  If the name matches nothing (typically because the owning
        faculty was not crawled), a department row is synthesised under the
        course's own faculty so that ``working_curriculum_items.department_id``
        — a NOT NULL column — can still be filled.
        """
        key = course_page.get("department_key") or ""
        if not key:
            return None
        did = self.department_by_key.get(key)
        if did is not None:
            return did
        for known_key, known_id in self.department_by_key.items():
            if key and (key in known_key or known_key in key):
                self.department_by_key[key] = known_id
                self.notes["department_fuzzy_matched"] += 1
                return known_id
        name = norm_ws(course_page.get("department_text") or "")
        if not name:
            return None
        if not name.lower().startswith("кафедр"):
            name = "Кафедра " + name[0].lower() + name[1:]
        hint = self.faculty_abbrev.get(faculty_id, "")
        abbrev = "К" + "".join(
            w[0].upper() for w in re.split(r"[\s\-]+", re.sub(r"^кафедра\s+", "", name.lower()))
            if w and w not in STOPWORDS)
        did = self.t_departments.add(
            self.u_department_name.take(name, hint),
            self.u_department_abbrev.take(abbrev or "К", hint),
            faculty_id, None, None)
        self.department_by_key[key] = did
        self.department_faculty[did] = faculty_id
        self.notes["department_synthesized"] += 1
        LOG.info("synthesised department '%s' under faculty #%d (named only on a course page)",
                 name, faculty_id)
        return did

    def course_row(self, url: str | None, fallback_name: str, faculty_id: int,
                   course_type: str, parent_id: int | None = None) -> int:
        """Insert (or reuse) a course row for a curriculum entry."""
        page = self.course_pages.get(url or "", {})
        name = truncate(page.get("name") or fallback_name, 200) or "Без назви"
        department_id = self.resolve_department(page, faculty_id) if page else None
        if page.get("course_type") and parent_id is None and course_type == "MANDATORY":
            course_type = page["course_type"]
        cid = self.t_courses.add(name, course_type, faculty_id, department_id, parent_id)
        self.course_department[cid] = department_id
        return cid

    def build_curricula(self) -> None:
        LOG.info("--- courses, curricula and hours ---")
        self.course_pages = {c["url"]: c for c in self.data["courses"]}
        group_votes: dict[str, Counter] = defaultdict(Counter)

        # Pass 1: work out which specialty each academic group belongs to.
        # A course page names its groups but not their specialty, so the group
        # is assigned to whichever specialty's curriculum mentions it in the
        # most *distinct* courses (counting per course, not per lecture/lab row,
        # so a course with many practical rows does not outvote the rest).
        seen_group_course: set[tuple[str, int, str]] = set()
        for curriculum in self.data["curricula"]:
            sid = self._specialty_id(curriculum)
            if sid is None:
                continue
            for semester in curriculum["semesters"]:
                for row in semester["rows"]:
                    for url in self._row_course_urls(row):
                        for block in self.course_pages.get(url, {}).get("classes", []):
                            for group in block.get("groups", []):
                                group = norm_ws(group)
                                marker = (group, sid, url)
                                if marker in seen_group_course:
                                    continue
                                seen_group_course.add(marker)
                                group_votes[group][sid] += 1
        for group, votes in sorted(group_votes.items()):
            ranked = votes.most_common()
            sid = ranked[0][0]
            tied = [s for s, count in ranked if count == ranked[0][1]]
            if len(tied) > 1:
                # A master group ("ПМом-11") belongs to a master specialty.
                wanted = "MASTER" if self._looks_like_master(group) else "BACHELOR"
                preferred = [s for s in tied if self.t_specialties.rows[s - 1][3] == wanted]
                sid = preferred[0] if preferred else tied[0]
            if len(votes) > 1:
                self.notes["group_specialty_ambiguous"] += 1
                LOG.info("  group %s is claimed by %d specialties %s; assigned to #%d (%s)",
                         group, len(votes), [s for s, _ in ranked], sid,
                         self.specialty_name.get(sid, "?"))
            gid = self.t_groups.add(self.u_group.take(group), self._group_year(group),
                                    self._group_study_form(group), None, sid)
            self.group_ids[group] = gid
        LOG.info("academic groups: %d (%d ambiguous)", len(self.t_groups),
                 self.notes["group_specialty_ambiguous"])

        # Pass 2: courses, curriculum items, hours, working curriculum items.
        wci_signature: dict[tuple, list[int]] = defaultdict(list)
        wci_context: dict[int, dict] = {}

        for curriculum in self.data["curricula"]:
            sid = self._specialty_id(curriculum)
            if sid is None:
                self.problem(f"curriculum {curriculum['url']}: specialty "
                             f"{curriculum['specialty_code']}/{curriculum['specialty_degree']} "
                             f"not generated")
                continue
            faculty_id = self.specialty_faculty[sid]
            LOG.info("  %s %s (%s)", curriculum["specialty_code"],
                     curriculum["specialty_degree"], curriculum["url"])
            for semester_block in curriculum["semesters"]:
                semester = int(semester_block["semester"])
                for row in semester_block["rows"]:
                    if row["kind"] == "elective_group":
                        self._elective_group_row(curriculum, sid, faculty_id, semester, row,
                                                 wci_signature, wci_context)
                    else:
                        self._plain_course_row(curriculum, sid, faculty_id, semester, row,
                                               wci_signature, wci_context)

        LOG.info("courses: %d | curriculum items: %d | hour rows: %d | working items: %d",
                 len(self.t_courses), len(self.t_curriculum_items), len(self.t_hours),
                 len(self.t_wci))

        self._combine_working_items(wci_signature, wci_context)
        self._build_workloads(wci_context)

    def _specialty_id(self, curriculum: dict) -> int | None:
        return self.specialty_by_key.get((curriculum["faculty_host"],
                                          curriculum["specialty_code"],
                                          curriculum["specialty_degree"]))

    @staticmethod
    def _row_course_urls(row: dict) -> list[str]:
        if row["kind"] == "elective_group":
            return [o["course_url"] for o in row["options"] if o.get("course_url")]
        return [row["course_url"]] if row.get("course_url") else []

    @staticmethod
    def _group_year(name: str) -> int:
        m = re.search(r"-(\d)", name)
        return int(m.group(1)) if m else 1

    @staticmethod
    def _group_study_form(name: str) -> str:
        return "PART_TIME" if re.search(r"-\d+з", name.lower()) else "FULL_TIME"

    @staticmethod
    def _looks_like_master(name: str) -> bool:
        """LNU marks master groups with a trailing 'м' — "ПМом-11", "ФеП-51м"."""
        low = norm_ws(name).lower()
        return bool(re.search(r"м-\d", low) or re.search(r"-\d+м$", low))

    def _link_course_specialty(self, course_id: int, specialty_id: int) -> None:
        key = (course_id, specialty_id)
        if key in self.seen_course_specialties:
            return
        self.seen_course_specialties.add(key)
        self.t_course_specialties.add(course_id, specialty_id)

    def _add_tag(self, course_id: int, tag: str) -> None:
        tag = truncate(tag, 64)
        if not tag or (course_id, tag) in self.seen_tags:
            return
        self.seen_tags.add((course_id, tag))
        self.t_course_tags.add(course_id, tag)

    def _curriculum_item(self, specialty_id: int, course_id: int, semester: int,
                         row: dict, course_url: str | None) -> int | None:
        key = (course_id, specialty_id, semester)
        if key in self.seen_curriculum_items:
            self.notes["curriculum_item_duplicate"] += 1
            return None
        self.seen_curriculum_items.add(key)
        control = row.get("control_form")
        ects = None
        if course_url:
            for plan in self.course_pages.get(course_url, {}).get("plan", []):
                if int(plan.get("semester") or 0) == semester:
                    ects = plan.get("ects_credits")
                    control = control or plan.get("control_form")
                    break
        if control is None:
            control = CONTROL_FORM_DEFAULT
            self.notes["control_form_defaulted"] += 1
        return self.t_curriculum_items.add(semester, control, ects, specialty_id, course_id)

    def _hours_rows(self, curriculum_item_id: int, hours: dict[str, int]) -> dict[str, int]:
        out: dict[str, int] = {}
        for hour_type in HOUR_TYPES:
            value = int(hours.get(hour_type) or 0)
            if value <= 0:
                continue
            key = (curriculum_item_id, hour_type)
            if key in self.seen_hours:
                continue
            self.seen_hours.add(key)
            out[hour_type] = self.t_hours.add(curriculum_item_id, hour_type, value)
        return out

    def _plain_course_row(self, curriculum, specialty_id, faculty_id, semester, row,
                          wci_signature, wci_context) -> None:
        url = row.get("course_url")
        if url and url in self.course_by_url:
            course_id = self.course_by_url[url]
        else:
            course_id = self.course_row(url, row.get("name", ""), faculty_id, "MANDATORY")
            if url:
                self.course_by_url[url] = course_id
        self._link_course_specialty(course_id, specialty_id)
        item_id = self._curriculum_item(specialty_id, course_id, semester, row, url)
        if item_id is None:
            return
        hour_ids = self._hours_rows(item_id, row.get("hours") or {})
        for hour_type, hours_id in hour_ids.items():
            if hour_type not in SCHEDULED_HOUR_TYPES:
                continue
            self._working_item(hours_id, hour_type, semester, specialty_id,
                               course_url=url, course_key=url or f"name:{row.get('name')}",
                               hours=int((row.get("hours") or {})[hour_type]),
                               department_id=self.course_department.get(course_id),
                               faculty_id=faculty_id, elective_course_id=None,
                               wci_signature=wci_signature, wci_context=wci_context)

    def _elective_group_row(self, curriculum, specialty_id, faculty_id, semester, row,
                            wci_signature, wci_context) -> None:
        """Create the ДВ parent course, its tags, and one child per option."""
        parent_id = self.t_courses.add("ДВ", "ELECTIVE_GROUP", faculty_id, None, None)
        self.course_department[parent_id] = None
        self._add_tag(parent_id, self.specialty_name[specialty_id].lower())
        self._add_tag(parent_id, f"семестр {semester}")
        self._link_course_specialty(parent_id, specialty_id)
        self.notes["elective_group"] += 1

        item_id = self._curriculum_item(specialty_id, parent_id, semester, row, None)
        if item_id is None:
            return
        hour_ids = self._hours_rows(item_id, row.get("hours") or {})

        children: list[tuple[int, str | None]] = []
        for option in row["options"]:
            url = option.get("course_url")
            child_id = self.course_row(url, option.get("name", ""), faculty_id,
                                       "ELECTIVE", parent_id)
            children.append((child_id, url))
            self._link_course_specialty(child_id, specialty_id)

        for hour_type, hours_id in hour_ids.items():
            if hour_type not in SCHEDULED_HOUR_TYPES:
                continue
            for child_id, url in children:
                self._working_item(hours_id, hour_type, semester, specialty_id,
                                   course_url=url,
                                   course_key=url or f"child:{child_id}",
                                   hours=int((row.get("hours") or {})[hour_type]),
                                   department_id=self.course_department.get(child_id),
                                   faculty_id=faculty_id, elective_course_id=child_id,
                                   wci_signature=wci_signature, wci_context=wci_context)

    def _class_blocks(self, course_url: str | None, hour_type: str,
                      semester: int) -> list[dict]:
        """Class rows from the course page for this hour type.

        Master curricula number their semesters 1..3 while the course page uses
        the same numbering, but bachelor pages occasionally disagree, so an
        exact semester match is preferred and a single unambiguous block is
        accepted as a fallback.
        """
        page = self.course_pages.get(course_url or "", {})
        blocks = [b for b in page.get("classes", []) if b.get("hour_type") == hour_type]
        if not blocks:
            return []
        exact = [b for b in blocks if int(b.get("semester") or 0) == semester]
        if exact:
            return exact
        semesters = {int(b.get("semester") or 0) for b in blocks}
        if len(semesters) == 1:
            self.notes["class_block_semester_mismatch"] += 1
            return blocks
        self.notes["class_block_semester_unmatched"] += 1
        return []

    def _resolve_lecturers(self, blocks: list[dict], department_id: int | None) -> dict[int, list[int]]:
        """block index -> lecturer ids, matching by /employee/ URL then by name."""
        out: dict[int, list[int]] = {}
        for index, block in enumerate(blocks):
            ids: list[int] = []
            for entry in block.get("lecturers", []):
                lid = None
                if entry.get("url"):
                    lid = self.lecturer_by_url.get(entry["url"])
                if lid is None and entry.get("label"):
                    candidates = self.lecturer_by_short.get(self._label_short_key(entry["label"]), [])
                    if len(candidates) == 1:
                        lid = candidates[0]
                        self.notes["lecturer_matched_by_name"] += 1
                    elif len(candidates) > 1:
                        preferred = [c for c in candidates
                                     if department_id is not None
                                     and self.t_lecturers.rows[c - 1][-1] == department_id]
                        lid = preferred[0] if preferred else candidates[0]
                        self.notes["lecturer_ambiguous_name"] += 1
                if lid is None:
                    self.notes["lecturer_unresolved"] += 1
                    LOG.debug("unresolved lecturer %s", entry)
                    continue
                if lid not in ids:
                    ids.append(lid)
            out[index] = ids
        return out

    def _working_item(self, hours_id: int, hour_type: str, semester: int, specialty_id: int,
                      course_url: str | None, course_key: str, hours: int,
                      department_id: int | None, faculty_id: int,
                      elective_course_id: int | None,
                      wci_signature, wci_context) -> None:
        blocks = self._class_blocks(course_url, hour_type, semester)
        specialty_groups = {name for name, gid in self.group_ids.items()
                            if self.t_groups.rows[gid - 1][-1] == specialty_id}
        # Groups mentioned on the course page that belong to this specialty.
        group_names: list[str] = []
        for block in blocks:
            for name in block.get("groups", []):
                name = norm_ws(name)
                if name in specialty_groups and name not in group_names:
                    group_names.append(name)
        if department_id is None:
            department_id = self._fallback_department(faculty_id)
        if department_id is None:
            self.problem(f"working item skipped for hours #{hours_id}: no department "
                         f"(course {course_url})")
            return

        lecturers_by_block = self._resolve_lecturers(blocks, department_id)
        all_lecturers: list[int] = []
        for ids in lecturers_by_block.values():
            for lid in ids:
                if lid not in all_lecturers:
                    all_lecturers.append(lid)

        single_block_covers_all = len(blocks) <= 1
        teaching_format = "TOGETHER" if single_block_covers_all else "SEPARATELY"
        wci_id = self.t_wci.add(hours_id, max(1, len(all_lecturers)), teaching_format,
                                department_id, elective_course_id)
        for name in group_names:
            self.t_wci_groups.add(wci_id, self.group_ids[name])

        wci_signature[(course_key, semester, hour_type, hours)].append(wci_id)
        wci_context[wci_id] = {
            "teaching_format": teaching_format,
            "lecturers": all_lecturers,
            "groups": [self.group_ids[n] for n in group_names],
            "blocks": [
                {
                    "lecturers": lecturers_by_block.get(i, []),
                    "groups": [self.group_ids[norm_ws(g)] for g in block.get("groups", [])
                               if norm_ws(g) in specialty_groups],
                }
                for i, block in enumerate(blocks)
            ],
        }

    def _fallback_department(self, faculty_id: int) -> int | None:
        for did, fid in self.department_faculty.items():
            if fid == faculty_id:
                return did
        return None

    # -------------------------------------------------------------- combine

    def _combine_working_items(self, wci_signature, wci_context) -> None:
        LOG.info("--- combined working curriculum items ---")
        combined_of: dict[int, int] = {}
        for signature, ids in sorted(wci_signature.items()):
            if len(ids) < 2:
                continue
            cid = self.t_cwci.add()
            for wci_id in ids:
                self.t_cwci_members.add(cid, wci_id)
                combined_of[wci_id] = cid
            LOG.debug("combined %d working items for %s", len(ids), signature)
        self.combined_of = combined_of
        LOG.info("combined items: %d covering %d working items",
                 len(self.t_cwci), len(combined_of))

    # ------------------------------------------------------------- workloads

    def _build_workloads(self, wci_context) -> None:
        LOG.info("--- lecturer workloads ---")
        by_combined: dict[int, list[int]] = defaultdict(list)
        for wci_id, cid in self.combined_of.items():
            by_combined[cid].append(wci_id)

        for cid, members in sorted(by_combined.items()):
            lecturers: list[int] = []
            groups: list[int] = []
            for wci_id in members:
                context = wci_context.get(wci_id, {})
                for lid in context.get("lecturers", []):
                    if lid not in lecturers:
                        lecturers.append(lid)
                for gid in context.get("groups", []):
                    if gid not in groups:
                        groups.append(gid)
            if not lecturers:
                self.notes["combined_without_lecturer"] += 1
                continue
            self._workload(None, cid, lecturers, groups)

        for wci_id, context in sorted(wci_context.items()):
            if wci_id in self.combined_of:
                continue
            if context["teaching_format"] == "TOGETHER" or not context["blocks"]:
                if not context["lecturers"]:
                    self.notes["working_item_without_lecturer"] += 1
                    continue
                self._workload(wci_id, None, context["lecturers"], context["groups"])
            else:
                for block in context["blocks"]:
                    if not block["lecturers"]:
                        self.notes["block_without_lecturer"] += 1
                        continue
                    self._workload(wci_id, None, block["lecturers"], block["groups"])
        LOG.info("workloads: %d (%d lecturer links, %d group links)",
                 len(self.t_workloads), len(self.t_workload_lecturers),
                 len(self.t_workload_groups))

    def _workload(self, wci_id: int | None, cwci_id: int | None,
                  lecturers: list[int], groups: list[int]) -> None:
        wid = self.t_workloads.add(wci_id, cwci_id, DEFAULT_CLASS_DURATION_HOURS)
        for lid in lecturers:
            self.t_workload_lecturers.add(wid, lid)
        for gid in groups:
            self.t_workload_groups.add(wid, gid)

    # ------------------------------------------------------------ static bits

    def build_static(self) -> None:
        for ordinal, start in enumerate(CLASS_START_TIMES, start=1):
            self.t_class_start_times.add(ordinal, start)

    # ------------------------------------------------------------- self-check

    def self_check(self) -> list[str]:
        """In-memory checks mirroring schema.sql's constraints."""
        errors: list[str] = []

        def ids(table: Table) -> set[int]:
            return {row[0] for row in table.rows}

        faculty_ids, building_ids = ids(self.t_faculties), ids(self.t_buildings)
        department_ids, specialty_ids = ids(self.t_departments), ids(self.t_specialties)
        lecturer_ids, group_ids = ids(self.t_lecturers), ids(self.t_groups)
        course_ids, item_ids = ids(self.t_courses), ids(self.t_curriculum_items)
        hour_ids, wci_ids = ids(self.t_hours), ids(self.t_wci)
        cwci_ids, workload_ids = ids(self.t_cwci), ids(self.t_workloads)

        def check_fk(table: Table, column: str, valid: set[int], nullable: bool) -> None:
            index = ([*(["id"] if table.has_id else []), *table.columns]).index(column)
            for row in table.rows:
                value = row[index]
                if value is None:
                    if not nullable:
                        errors.append(f"{table.name}: NULL in NOT NULL column {column}")
                elif value not in valid:
                    errors.append(f"{table.name}.{column}={value} has no matching row")

        check_fk(self.t_faculties, "building_id", building_ids, True)
        check_fk(self.t_departments, "faculty_id", faculty_ids, False)
        check_fk(self.t_specialties, "faculty_id", faculty_ids, False)
        check_fk(self.t_lecturers, "department_id", department_ids, False)
        check_fk(self.t_lecturers, "academic_degree_id", {1, 2, 3}, True)
        check_fk(self.t_groups, "specialty_id", specialty_ids, False)
        check_fk(self.t_courses, "faculty_id", faculty_ids, True)
        check_fk(self.t_courses, "department_id", department_ids, True)
        check_fk(self.t_courses, "parent_course_id", course_ids, True)
        check_fk(self.t_course_specialties, "course_id", course_ids, False)
        check_fk(self.t_course_specialties, "specialty_id", specialty_ids, False)
        check_fk(self.t_course_tags, "course_id", course_ids, False)
        check_fk(self.t_curriculum_items, "specialty_id", specialty_ids, False)
        check_fk(self.t_curriculum_items, "course_id", course_ids, False)
        check_fk(self.t_hours, "curriculum_item_id", item_ids, False)
        check_fk(self.t_wci, "curriculum_item_hours_id", hour_ids, False)
        check_fk(self.t_wci, "department_id", department_ids, False)
        check_fk(self.t_wci, "course_id", course_ids, True)
        check_fk(self.t_wci_groups, "working_curriculum_item_id", wci_ids, False)
        check_fk(self.t_wci_groups, "academic_group_id", group_ids, False)
        check_fk(self.t_cwci_members, "combined_working_curriculum_item_id", cwci_ids, False)
        check_fk(self.t_cwci_members, "working_curriculum_item_id", wci_ids, False)
        check_fk(self.t_workloads, "working_curriculum_item_id", wci_ids, True)
        check_fk(self.t_workloads, "combined_working_curriculum_item_id", cwci_ids, True)
        check_fk(self.t_workload_lecturers, "lecturer_workload_id", workload_ids, False)
        check_fk(self.t_workload_lecturers, "lecturer_id", lecturer_ids, False)
        check_fk(self.t_workload_groups, "lecturer_workload_id", workload_ids, False)
        check_fk(self.t_workload_groups, "academic_group_id", group_ids, False)

        # parent_course_id must reference a row inserted earlier.
        for row in self.t_courses.rows:
            if row[5] is not None and row[5] >= row[0]:
                errors.append(f"courses id={row[0]} references a later parent {row[5]}")

        # lecturer_workloads_target_check: exactly one of the two targets.
        for row in self.t_workloads.rows:
            if (row[1] is None) == (row[2] is None):
                errors.append(f"lecturer_workloads id={row[0]} violates the target CHECK")
            if not 1 <= row[3] <= 4:
                errors.append(f"lecturer_workloads id={row[0]} duration {row[3]} outside 1..4")

        def check_unique(table: Table, columns: list[str], skip_null: bool = False) -> None:
            header = ([*(["id"] if table.has_id else []), *table.columns])
            indexes = [header.index(c) for c in columns]
            seen: set[tuple] = set()
            for row in table.rows:
                key = tuple(row[i] for i in indexes)
                if skip_null and any(v is None for v in key):
                    continue
                if key in seen:
                    errors.append(f"{table.name}: duplicate {columns} = {key}")
                seen.add(key)

        check_unique(self.t_buildings, ["name"])
        check_unique(self.t_faculties, ["name"])
        check_unique(self.t_faculties, ["abbreviation"], skip_null=True)
        check_unique(self.t_departments, ["name"])
        check_unique(self.t_departments, ["abbreviation"], skip_null=True)
        check_unique(self.t_specialties, ["code", "degree"])
        check_unique(self.t_specialties, ["name", "degree"])
        check_unique(self.t_groups, ["name"])
        check_unique(self.t_lecturers, ["email"], skip_null=True)
        check_unique(self.t_course_tags, ["course_id", "tag"])
        check_unique(self.t_curriculum_items, ["course_id", "specialty_id", "semester"])
        check_unique(self.t_hours, ["curriculum_item_id", "hour_type"])
        check_unique(self.t_course_specialties, ["course_id", "specialty_id"])
        check_unique(self.t_wci_groups, ["working_curriculum_item_id", "academic_group_id"])
        check_unique(self.t_cwci_members, ["combined_working_curriculum_item_id",
                                           "working_curriculum_item_id"])
        check_unique(self.t_workload_lecturers, ["lecturer_workload_id", "lecturer_id"])
        check_unique(self.t_workload_groups, ["lecturer_workload_id", "academic_group_id"])

        enums = {
            (self.t_specialties, "degree"): {"JUNIOR_BACHELOR", "BACHELOR", "MASTER",
                                             "PHD", "DOCTOR_OF_SCIENCE"},
            (self.t_lecturers, "position"): {"ASSISTANT", "TEACHER", "SENIOR_LECTURER",
                                             "DOCENT", "PROFESSOR", "HEAD_OF_DEPARTMENT"},
            (self.t_groups, "study_form"): {"FULL_TIME", "PART_TIME"},
            (self.t_courses, "course_type"): {"MANDATORY", "ELECTIVE_GROUP", "ELECTIVE",
                                              "OPTIONAL", "INTERNSHIP", "COURSE_PROJECT",
                                              "COURSE_WORK", "QUALIFICATION_WORK"},
            (self.t_curriculum_items, "control_form"): {"EXAM", "CREDIT", "GRADED_CREDIT"},
            (self.t_hours, "hour_type"): set(HOUR_TYPES),
            (self.t_wci, "teaching_format"): {"TOGETHER", "SEPARATELY"},
        }
        for (table, column), allowed in enums.items():
            index = ([*(["id"] if table.has_id else []), *table.columns]).index(column)
            for row in table.rows:
                if row[index] is not None and row[index] not in allowed:
                    errors.append(f"{table.name}.{column}: illegal enum value {row[index]!r}")

        widths = {
            (self.t_buildings, "name"): 120, (self.t_faculties, "name"): 160,
            (self.t_faculties, "abbreviation"): 32, (self.t_faculties, "website"): 128,
            (self.t_faculties, "email"): 64, (self.t_faculties, "phone"): 128,
            (self.t_departments, "name"): 160, (self.t_departments, "abbreviation"): 32,
            (self.t_departments, "email"): 64, (self.t_departments, "phone"): 64,
            (self.t_specialties, "code"): 16, (self.t_specialties, "name"): 160,
            (self.t_lecturers, "first_name"): 64, (self.t_lecturers, "middle_name"): 64,
            (self.t_lecturers, "last_name"): 64, (self.t_lecturers, "email"): 64,
            (self.t_groups, "name"): 32, (self.t_courses, "name"): 200,
            (self.t_course_tags, "tag"): 64,
        }
        for (table, column), limit in widths.items():
            index = ([*(["id"] if table.has_id else []), *table.columns]).index(column)
            for row in table.rows:
                value = row[index]
                if isinstance(value, str) and len(value) > limit:
                    errors.append(f"{table.name}.{column} id={row[0]}: "
                                  f"{len(value)} chars exceeds VARCHAR({limit})")
        return errors

    # ----------------------------------------------------------------- output

    def to_sql(self) -> str:
        out: list[str] = []
        out.append("--\n-- LNU timetable seed data\n"
                   f"-- Generated by scripts/lnu_import/build_sql.py on "
                   f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
                   "-- Source: https://lnu.edu.ua/structure/faculties and the faculty sites.\n"
                   "-- All ids are assigned from 1; load after schema.sql.\n--\n\n")
        out.append("SET client_encoding = 'UTF8';\n"
                   "SET standard_conforming_strings = on;\n"
                   "SET client_min_messages = warning;\n\n")

        out.append("-- global_properties\n")
        for name, ptype, value in GLOBAL_PROPERTIES:
            out.append(f"INSERT INTO public.global_properties (name, type, value) "
                       f"VALUES ({q(name)}, {q(ptype)}, {q(value)});\n")
        out.append("\n-- academic_degrees\n")
        for did, name, abbreviation, level in ACADEMIC_DEGREES:
            out.append("INSERT INTO public.academic_degrees (id, name, abbreviation, level) "
                       f"VALUES ({did}, {q(name)}, {q(abbreviation)}, {level});\n")
        out.append("\n")

        for table in (self.t_buildings, self.t_faculties, self.t_departments,
                      self.t_specialties, self.t_lecturers, self.t_groups,
                      self.t_courses, self.t_course_specialties, self.t_course_tags,
                      self.t_curriculum_items, self.t_hours, self.t_wci,
                      self.t_wci_groups, self.t_cwci, self.t_cwci_members,
                      self.t_workloads, self.t_workload_lecturers,
                      self.t_workload_groups, self.t_class_start_times):
            out.append(table.to_sql())

        if self.args.auth:
            out.append(self._auth_sql())

        out.append("--\n-- Sequences\n--\n")
        sequences = [
            ("academic_degrees_id_seq", len(ACADEMIC_DEGREES)),
            ("buildings_id_seq", len(self.t_buildings)),
            ("faculties_id_seq", len(self.t_faculties)),
            ("departments_id_seq", len(self.t_departments)),
            ("specialties_id_seq", len(self.t_specialties)),
            ("lecturers_id_seq", len(self.t_lecturers)),
            ("academic_groups_id_seq", len(self.t_groups)),
            ("combined_groups_id_seq", 0),
            ("students_id_seq", 0),
            ("courses_id_seq", len(self.t_courses)),
            ("course_tags_id_seq", len(self.t_course_tags)),
            ("curriculum_items_id_seq", len(self.t_curriculum_items)),
            ("curriculum_item_hours_id_seq", len(self.t_hours)),
            ("working_curriculum_items_id_seq", len(self.t_wci)),
            ("combined_working_curriculum_items_id_seq", len(self.t_cwci)),
            ("lecturer_workloads_id_seq", len(self.t_workloads)),
            ("rooms_id_seq", 0),
            ("class_start_times_id_seq", len(self.t_class_start_times)),
            ("timetable_entries_id_seq", 0),
        ]
        if self.args.auth:
            sequences += [("users_id_seq", 3), ("groups_id_seq", 2), ("permissions_id_seq", 3)]
        for sequence, value in sequences:
            out.append(f"SELECT pg_catalog.setval('public.{sequence}', "
                       f"{max(value, 1)}, {str(value > 0).lower()});\n")
        out.append("\n-- End of generated data\n")
        return "".join(out)

    def _auth_sql(self) -> str:
        """Seed accounts so the application is usable straight after loading."""
        faculty_id = 1 if len(self.t_faculties) else None
        department_id = 1 if len(self.t_departments) else None
        lines = ["--\n-- Seeded accounts (admin@lnu.edu.ua / Admin#2026,\n"
                 "-- dean.fpmi@lnu.edu.ua and o.melnyk@lnu.edu.ua / Temp#12345)\n--\n"]
        lines.append("INSERT INTO public.groups (id, name, description) VALUES "
                     f"(1, {q('Деканат ФПМіІ')}, {q('Deans office staff of the Faculty of Applied Mathematics and Informatics')});\n")
        lines.append("INSERT INTO public.groups (id, name, description) VALUES "
                     f"(2, {q('Завідувачі кафедр')}, {q('Heads of department, university-wide')});\n")
        users = [
            (1, "admin@lnu.edu.ua", "Адміністратор", "Системи", ADMIN_HASH, False),
            (2, "dean.fpmi@lnu.edu.ua", "Софія", "Мельник", TEMP_HASH, True),
            (3, "o.melnyk@lnu.edu.ua", "Олена", "Коваленко", TEMP_HASH, True),
        ]
        for uid, email, first, last, digest, must_change in users:
            lines.append("INSERT INTO public.users (id, email, first_name, last_name, "
                         "password_hash, must_change_password, is_active) VALUES "
                         f"({uid}, {q(email)}, {q(first)}, {q(last)}, {q(digest)}, "
                         f"{q(must_change)}, true);\n")
        lines.append("INSERT INTO public.user_groups (user_id, group_id) VALUES (2, 1);\n")
        lines.append("INSERT INTO public.user_groups (user_id, group_id) VALUES (3, 2);\n")
        lines.append("INSERT INTO public.permissions (id, grantee_type, user_id, group_id, "
                     "resource_type, resource_id, granted_by) VALUES "
                     "(1, 'USER', 1, NULL, 'GLOBAL', NULL, NULL);\n")
        if faculty_id:
            lines.append("INSERT INTO public.permissions (id, grantee_type, user_id, group_id, "
                         "resource_type, resource_id, granted_by) VALUES "
                         f"(2, 'GROUP', NULL, 1, 'FACULTY', {faculty_id}, 1);\n")
        if department_id:
            lines.append("INSERT INTO public.permissions (id, grantee_type, user_id, group_id, "
                         "resource_type, resource_id, granted_by) VALUES "
                         f"(3, 'USER', 3, NULL, 'DEPARTMENT', {department_id}, 1);\n")
        lines.append("\n")
        return "".join(lines)

    def summary(self) -> str:
        rows = [
            ("buildings", len(self.t_buildings)),
            ("faculties", len(self.t_faculties)),
            ("departments", len(self.t_departments)),
            ("specialties", len(self.t_specialties)),
            ("lecturers", len(self.t_lecturers)),
            ("academic_groups", len(self.t_groups)),
            ("courses", len(self.t_courses)),
            ("course_specialties", len(self.t_course_specialties)),
            ("course_tags", len(self.t_course_tags)),
            ("curriculum_items", len(self.t_curriculum_items)),
            ("curriculum_item_hours", len(self.t_hours)),
            ("working_curriculum_items", len(self.t_wci)),
            ("working_curriculum_item_groups", len(self.t_wci_groups)),
            ("combined_working_curriculum_items", len(self.t_cwci)),
            ("combined_working_curriculum_item_members", len(self.t_cwci_members)),
            ("lecturer_workloads", len(self.t_workloads)),
            ("lecturer_workload_lecturers", len(self.t_workload_lecturers)),
            ("lecturer_workload_academic_groups", len(self.t_workload_groups)),
            ("class_start_times", len(self.t_class_start_times)),
        ]
        width = max(len(name) for name, _ in rows)
        return "\n".join(f"  {name.ljust(width)} : {count}" for name, count in rows)


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def load(indir: str) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for name in ("faculties", "departments", "lecturers", "specialties",
                 "curricula", "courses"):
        path = os.path.join(indir, f"{name}.json")
        if not os.path.exists(path):
            sys.exit(f"Missing {path} — run scrape_lnu.py first.")
        with open(path, encoding="utf-8") as fh:
            data[name] = json.load(fh)
        size = len(data[name]) if isinstance(data[name], list) else "-"
        LOG.info("loaded %-16s %s entries", name + ".json", size)
    return data


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-i", "--in", dest="indir", default=os.path.join(HERE, "data"),
                   help="directory written by scrape_lnu.py (default: ./data)")
    p.add_argument("-o", "--out", default=os.path.join(HERE, "generated", "data.sql"),
                   help="SQL file to write (default: ./generated/data.sql)")
    p.add_argument("--no-auth", dest="auth", action="store_false",
                   help="omit the seeded users/groups/permissions block")
    p.add_argument("--no-check", dest="check", action="store_false",
                   help="skip the constraint self-check")
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    p.add_argument("--log-file", default=None, help="also write the log to this file")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if args.log_file:
        handlers.append(logging.FileHandler(args.log_file, encoding="utf-8"))
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s",
                        datefmt="%H:%M:%S", handlers=handlers)

    started = time.time()
    LOG.info("Building SQL from %s", args.indir)
    builder = Builder(load(args.indir), args)
    builder.build_organisation()
    builder.build_curricula()
    builder.build_static()

    LOG.info("--- row counts ---\n%s", builder.summary())
    if builder.notes:
        LOG.info("--- notes ---")
        for key, count in sorted(builder.notes.items()):
            LOG.info("  %-38s %d", key, count)
    if builder.problems:
        LOG.warning("%d data problems logged (first 10):", len(builder.problems))
        for message in builder.problems[:10]:
            LOG.warning("  %s", message)

    exit_code = 0
    if args.check:
        LOG.info("--- self-check against schema.sql constraints ---")
        errors = builder.self_check()
        if errors:
            LOG.error("%d constraint violations (first 20):", len(errors))
            for message in errors[:20]:
                LOG.error("  %s", message)
            exit_code = 2
        else:
            LOG.info("self-check passed: foreign keys, unique keys, enums, CHECKs "
                     "and column widths are all satisfied")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    sql = builder.to_sql()
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(sql)
    LOG.info("wrote %s (%d bytes, %d statements)", args.out, len(sql.encode("utf-8")),
             sql.count("INSERT INTO"))
    LOG.info("done in %.1fs", time.time() - started)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
