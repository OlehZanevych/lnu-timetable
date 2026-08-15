#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stage 1 of the LNU import pipeline: crawl lnu.edu.ua and the faculty sites.

Walks, for every faculty listed on https://lnu.edu.ua/structure/faculties:

    faculty site
      /about/departments      -> department links
      /department/<slug>      -> department name / abbreviation / contacts
      /about/staff            -> lecturer links grouped per department
      /employee/<slug>        -> lecturer name, position, academic degree, e-mail
      /academics/bachelor     -> degree_program links (code + name + curriculum page)
      /academics/master       -> ditto
      /academics/<deg>/<plan> -> curriculum: per-semester course rows + hours
      /course/<slug>          -> course type, owning department, lectures /
                                practicals / labs with lecturers and groups

Faculties whose website appears in the priority file (default
``priority_faculties.txt``) are processed first, in the order given there; the
rest follow in the order they appear on the university structure page.

Output: a directory of JSON files (``--out``, default ``data/``) consumed by
``build_sql.py``:

    faculties.json    buildings + faculties
    departments.json  departments (with a normalised match key)
    lecturers.json    lecturers (with their department match key)
    degree_programs.json  degree programmes + their curriculum page URLs
    curricula.json    curriculum rows per semester (incl. elective groups)
    courses.json      course pages: type, department, lectures/practicals/labs
    manifest.json     run metadata + per-faculty statistics

Examples
--------
    python3 scrape_lnu.py                       # every faculty, cached
    python3 scrape_lnu.py --faculties ami.lnu.edu.ua,physics.lnu.edu.ua
    python3 scrape_lnu.py --limit-faculties 5   # the five priority sites only
    python3 scrape_lnu.py --offline tests/fixtures   # no network, read from disk
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

try:
    import requests
    from bs4 import BeautifulSoup, Tag
except ImportError:  # pragma: no cover - dependency hint
    sys.exit("Missing dependencies. Run:  pip install requests beautifulsoup4 lxml")

LOG = logging.getLogger("scrape")

HERE = os.path.dirname(os.path.abspath(__file__))
FACULTIES_URL = "https://lnu.edu.ua/structure/faculties"
USER_AGENT = "lnu-timetable-import/1.0 (dissertation data collection; contact: oleh.zanevych@gmail.com)"

# ----------------------------------------------------------------------------
# Static reference data
# ----------------------------------------------------------------------------

# Official abbreviations of the 19 LNU faculties. `faculties.abbreviation` is
# UNIQUE in schema.sql and there is no reliable way to derive e.g. "ФПМіІ" from
# the full name, so the known set is spelled out and anything unknown falls back
# to initials (see `_fallback_abbrev`).
FACULTY_ABBREVIATIONS = {
    "факультет прикладної математики та інформатики": "ФПМіІ",
    "механіко-математичний факультет": "ММФ",
    "біологічний факультет": "БФ",
    "географічний факультет": "ГеогФ",
    "геологічний факультет": "ГеолФ",
    "економічний факультет": "ЕкФ",
    "факультет електроніки та комп'ютерних технологій": "ФЕКТ",
    "факультет журналістики": "ФЖ",
    "факультет іноземних мов": "ФІМ",
    "історичний факультет": "ІФ",
    "факультет культури і мистецтв": "ФКМ",
    "факультет міжнародних відносин": "ФМВ",
    "факультет педагогічної освіти": "ФПО",
    "факультет управління фінансами та бізнесу": "ФУФБ",
    "фізичний факультет": "ФзФ",
    "філологічний факультет": "ФлФ",
    "філософський факультет": "ФсФ",
    "хімічний факультет": "ХФ",
    "юридичний факультет": "ЮФ",
}

# lecturer_position enum in schema.sql. Longest key wins, so "старший викладач"
# is tested before "викладач".
POSITION_MAP = [
    ("завідувач кафедри", "HEAD_OF_DEPARTMENT"),
    ("завідувач", "HEAD_OF_DEPARTMENT"),
    ("зав. кафедри", "HEAD_OF_DEPARTMENT"),
    ("професор", "PROFESSOR"),
    ("доцент", "DOCENT"),
    ("старший викладач", "SENIOR_LECTURER"),
    ("ст. викладач", "SENIOR_LECTURER"),
    ("асистент", "ASSISTANT"),
    ("викладач", "TEACHER"),
]

# Roles that appear on /about/staff but are not teaching staff -> not imported.
NON_TEACHING = (
    "інженер", "лаборант", "секретар", "методист", "технік", "програміст",
    "адміністратор", "діловод", "фахівець", "бібліотекар", "препаратор",
)

# academic_degrees ids agreed with build_sql.py / data.sql.
DEGREE_CANDIDATE = 1   # Кандидат наук
DEGREE_PHD = 2         # Доктор філософії
DEGREE_DOCTOR = 3      # Доктор наук

CONTROL_FORM_MAP = {
    "іспит": "EXAM",
    "екзамен": "EXAM",
    "залік": "CREDIT",
    "зал.": "CREDIT",
    "диф. залік": "GRADED_CREDIT",
    "диф.залік": "GRADED_CREDIT",
    "диференційований залік": "GRADED_CREDIT",
}

# Curriculum table column header -> hour_type enum value.
HOUR_COLUMNS = [
    (("лекц",), "LECTURE"),
    (("лаб",), "LAB"),
    (("практ", "семінар"), "PRACTICAL"),
    (("сам", "срс"), "INDEPENDENT_WORK"),
]

# Course-page section heading -> hour_type enum value.
SECTION_HOUR_TYPE = [
    ("лекц", "LECTURE"),
    ("лаборатор", "LAB"),
    ("практ", "PRACTICAL"),
    ("семінар", "PRACTICAL"),
    ("самостійн", "INDEPENDENT_WORK"),
]

ELECTIVE_ROW_MARKERS = (
    "дисципліна на вибір",
    "дисципліни на вибір",
    "дисципліна за вибором",
    "вибіркова дисципліна",
    "вибіркові дисципліни",
    "блок вибіркових",
)

GROUP_RE = re.compile(r"\b[А-ЯІЇЄҐA-Z][А-Яа-яІіЇїЄєҐґA-Za-z’'`]{0,7}-\d{2,3}[а-яa-zА-ЯA-Z]?\b")
DEGREE_PROGRAM_CODE_RE = re.compile(r"^\s*([A-ZА-Я]?\d{1,3}(?:\.\d{1,2})?)[\s.–—-]+(.+)$")
STOPWORDS = {"та", "і", "й", "з", "із", "на", "у", "в", "для", "the", "of", "and", "a"}


# ----------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------

def norm_ws(text: str) -> str:
    """Collapse whitespace and normalise the various Unicode apostrophes."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text)
    text = text.replace("’", "'").replace("ʼ", "'").replace("‘", "'")
    text = text.replace("\xa0", " ").replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", text).strip()


def match_key(text: str) -> str:
    """Fold a name down to a comparison key (case/punctuation insensitive).

    Department names arrive in three shapes across the site network:
    "Дискретного аналізу та інтелектуальних систем" (departments listing),
    "Кафедра дискретного аналізу та інтелектуальних систем" (staff page) and
    "алгебри, топології та основ математики" (course page).  Stripping the
    leading "кафедра" and all punctuation makes them comparable.
    """
    text = norm_ws(text).lower()
    text = re.sub(r"^\s*кафедр[аи]\s+", "", text)
    text = re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def person_key(last: str, first: str, middle: str) -> str:
    """Key for matching a lecturer by name when no /employee/ link is available."""
    return " ".join(p for p in (norm_ws(last).lower(), norm_ws(first).lower(),
                                norm_ws(middle).lower()) if p)


def short_person_key(text: str) -> str:
    """'доцент Бридун В. Л.' -> 'бридун в л' — matches a full name's initials."""
    text = norm_ws(text).lower()
    for title, _ in POSITION_MAP:
        text = text.replace(title, " ")
    text = re.sub(r"\(.*?\)", " ", text)
    text = re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)
    parts = [p for p in text.split() if p]
    if not parts:
        return ""
    return " ".join([parts[0]] + [p[0] for p in parts[1:3]])


def _fallback_abbrev(name: str, prefix: str = "") -> str:
    words = [w for w in re.split(r"[\s\-]+", norm_ws(name)) if w and w.lower() not in STOPWORDS]
    letters = "".join(w[0].upper() for w in words)
    return (prefix + letters)[:32] or "X"


def department_abbreviation(name: str) -> str:
    """'Кафедра дискретного аналізу та інтелектуальних систем' -> 'КДАІС'."""
    core = re.sub(r"^\s*кафедр[аи]\s+", "", norm_ws(name), flags=re.IGNORECASE)
    return _fallback_abbrev(core, prefix="К")


def faculty_abbreviation(name: str) -> str:
    return FACULTY_ABBREVIATIONS.get(match_key(name).replace("’", "'"),
                                     None) or _fallback_abbrev(name)


def parse_int(text: str) -> int:
    text = norm_ws(text).replace(",", ".")
    m = re.search(r"\d+", text)
    return int(m.group()) if m else 0


def control_form(text: str) -> str | None:
    t = norm_ws(text).lower().rstrip(".")
    if not t or t in {"-", "немає", "нема"}:
        return None
    for key, value in CONTROL_FORM_MAP.items():
        if t.startswith(key.rstrip(".")):
            return value
    if "диф" in t:
        return "GRADED_CREDIT"
    if "спит" in t or "кзамен" in t:
        return "EXAM"
    if "алік" in t:
        return "CREDIT"
    return None


def academic_degree_id(text: str) -> int | None:
    t = norm_ws(text).lower()
    if not t:
        return None
    if "філософі" in t or "phd" in t or "ph.d" in t:
        return DEGREE_PHD
    if "кандидат" in t:
        return DEGREE_CANDIDATE
    if "доктор" in t and "наук" in t:
        return DEGREE_DOCTOR
    return None


def lecturer_position(text: str) -> str | None:
    t = norm_ws(text).lower()
    if not t:
        return None
    if any(word in t for word in NON_TEACHING):
        return None
    for key, value in POSITION_MAP:
        if key in t:
            return value
    return None


def split_full_name(full: str) -> tuple[str, str, str]:
    """'ПРИТУЛА Микола Миколайович' -> ('Притула', 'Микола', 'Миколайович')."""
    parts = [p for p in norm_ws(full).split() if p]
    parts = [p.capitalize() if p.isupper() else p for p in parts]
    if not parts:
        return "", "", ""
    if len(parts) == 1:
        return parts[0], parts[0], ""
    if len(parts) == 2:
        return parts[0], parts[1], ""
    return parts[0], parts[1], " ".join(parts[2:])


def group_year(group_name: str) -> int:
    """'ПМі-31' -> 3, 'ПМі-11' -> 1, 'ФеП-51м' -> 5."""
    m = re.search(r"-(\d)", group_name)
    return int(m.group(1)) if m else 1


def group_study_form(group_name: str) -> str:
    return "PART_TIME" if re.search(r"-\d+[зз]\b", group_name.lower()) else "FULL_TIME"


# ----------------------------------------------------------------------------
# HTTP fetching with an on-disk cache
# ----------------------------------------------------------------------------

class Fetcher:
    """Downloads pages, caching each response body under ``cache_dir``.

    The cache makes a re-run cheap (the full crawl is tens of thousands of
    requests) and makes ``--offline`` runs possible: point ``--offline`` at a
    directory laid out as ``<host>/<path>.html`` and no socket is opened at all.
    """

    def __init__(self, cache_dir: str | None, delay: float = 0.3,
                 offline_root: str | None = None, timeout: int = 30,
                 retries: int = 2):
        self.cache_dir = cache_dir
        self.delay = delay
        self.offline_root = offline_root
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session() if offline_root is None else None
        if self.session is not None:
            self.session.headers.update({"User-Agent": USER_AGENT})
        self.stats = {"cache_hits": 0, "downloads": 0, "failures": 0, "offline_misses": 0}
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)

    # -- offline -------------------------------------------------------------

    def _offline_path(self, url: str) -> str:
        p = urlparse(url)
        path = p.path.strip("/") or "index"
        if p.query:
            path += "__" + re.sub(r"[^\w=&.-]", "_", p.query)
        return os.path.join(self.offline_root, p.netloc, path + ".html")

    # -- cache ---------------------------------------------------------------

    def _cache_path(self, url: str) -> str:
        digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
        host = urlparse(url).netloc or "unknown"
        return os.path.join(self.cache_dir, host, digest + ".html")

    def get(self, url: str) -> str | None:
        if self.offline_root:
            path = self._offline_path(url)
            if os.path.exists(path):
                LOG.debug("offline hit  %s", url)
                with open(path, encoding="utf-8") as fh:
                    return fh.read()
            self.stats["offline_misses"] += 1
            LOG.debug("offline miss %s (%s)", url, path)
            return None

        if self.cache_dir:
            path = self._cache_path(url)
            if os.path.exists(path):
                self.stats["cache_hits"] += 1
                LOG.debug("cache hit    %s", url)
                with open(path, encoding="utf-8") as fh:
                    return fh.read()

        for attempt in range(self.retries + 1):
            try:
                LOG.debug("GET          %s%s", url, f" (retry {attempt})" if attempt else "")
                response = self.session.get(url, timeout=self.timeout)
                if response.status_code == 404:
                    LOG.debug("404          %s", url)
                    return None
                response.raise_for_status()
                response.encoding = response.encoding or "utf-8"
                html = response.text
                self.stats["downloads"] += 1
                if self.cache_dir:
                    path = self._cache_path(url)
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(html)
                if self.delay:
                    time.sleep(self.delay)
                return html
            except Exception as exc:  # noqa: BLE001 - network errors are expected
                if attempt >= self.retries:
                    self.stats["failures"] += 1
                    LOG.warning("FAILED       %s (%s)", url, exc)
                    return None
                time.sleep(1.5 * (attempt + 1))
        return None

    def soup(self, url: str) -> BeautifulSoup | None:
        html = self.get(url)
        if html is None:
            return None
        try:
            return BeautifulSoup(html, "lxml")
        except Exception:  # lxml not installed
            return BeautifulSoup(html, "html.parser")


# ----------------------------------------------------------------------------
# HTML helpers
# ----------------------------------------------------------------------------

CONTENT_SELECTORS = ["main", "article", ".entry-content", ".post-content",
                     "#content", ".content", ".page-content", "#main"]


def main_content(soup: BeautifulSoup) -> Tag:
    """Best-effort extraction of the page body, minus chrome.

    Every faculty runs its own WordPress theme, so instead of relying on one
    class name we try a list of usual suspects and, failing that, drop the
    navigation/aside/footer elements from <body>.
    """
    for tag in soup.find_all(["script", "style", "noscript"]):
        tag.decompose()
    for selector in CONTENT_SELECTORS:
        node = soup.select_one(selector)
        if node is not None and len(node.get_text(strip=True)) > 200:
            return node
    body = soup.body or soup
    for tag in body.find_all(["nav", "header", "footer", "aside"]):
        tag.decompose()
    return body


def table_grid(table: Tag) -> list[list[Tag | None]]:
    """Expand a table into a rectangular grid, honouring rowspan/colspan.

    Course pages put the semester and hour count in a cell that spans every
    per-group row, so a naive row-by-row read loses the alignment.
    """
    grid: list[list[Tag | None]] = []
    for r_index, row in enumerate(table.find_all("tr")):
        while len(grid) <= r_index:
            grid.append([])
        col = 0
        for cell in row.find_all(["td", "th"], recursive=False) or row.find_all(["td", "th"]):
            while col < len(grid[r_index]) and grid[r_index][col] is not None:
                col += 1
            try:
                rowspan = max(1, int(cell.get("rowspan", 1)))
                colspan = max(1, int(cell.get("colspan", 1)))
            except (TypeError, ValueError):
                rowspan = colspan = 1
            for dr in range(rowspan):
                while len(grid) <= r_index + dr:
                    grid.append([])
                target = grid[r_index + dr]
                while len(target) < col:
                    target.append(None)
                for dc in range(colspan):
                    while len(target) <= col + dc:
                        target.append(None)
                    target[col + dc] = cell
            col += colspan
    width = max((len(r) for r in grid), default=0)
    for row in grid:
        while len(row) < width:
            row.append(None)
    return grid


def cell_text(cell: Tag | None) -> str:
    return norm_ws(cell.get_text(" ", strip=True)) if cell is not None else ""


def cell_links(cell: Tag | None, base_url: str, pattern: str) -> list[tuple[str, str]]:
    """(absolute url, link text) for every <a> in the cell matching `pattern`."""
    if cell is None:
        return []
    out = []
    for a in cell.find_all("a", href=True):
        url = clean_url(urljoin(base_url, a["href"]))
        if re.search(pattern, urlparse(url).path):
            out.append((url, norm_ws(a.get_text(" ", strip=True))))
    return out


def clean_url(url: str) -> str:
    """Canonical form: https, no fragment, no query, no trailing slash."""
    parsed = urlparse(url)
    scheme = "https"
    path = parsed.path.rstrip("/") or "/"
    return f"{scheme}://{parsed.netloc}{path}"


def find_links(node: Tag, base_url: str, path_pattern: str,
               same_host_as: str | None = None) -> list[tuple[str, str]]:
    seen: dict[str, str] = {}
    host = urlparse(same_host_as).netloc if same_host_as else None
    for a in node.find_all("a", href=True):
        url = clean_url(urljoin(base_url, a["href"]))
        parsed = urlparse(url)
        if host and parsed.netloc != host:
            continue
        if not re.search(path_pattern, parsed.path):
            continue
        text = norm_ws(a.get_text(" ", strip=True))
        if url not in seen or (not seen[url] and text):
            seen[url] = text
    return list(seen.items())


def labelled_value(node: Tag, *labels: str) -> str:
    """Find 'Посада: ...' style lines and return the part after the colon."""
    lowered = tuple(label.lower() for label in labels)
    for el in node.find_all(["p", "li", "div", "span", "td"]):
        text = norm_ws(el.get_text(" ", strip=True))
        low = text.lower()
        for label in lowered:
            if low.startswith(label):
                rest = text[len(label):].lstrip(" :–-")
                if rest and len(rest) < 400:
                    return rest
    return ""


def first_email(node: Tag) -> str:
    for a in node.find_all("a", href=True):
        if a["href"].lower().startswith("mailto:"):
            email = norm_ws(a["href"][7:].split("?")[0])
            if "@" in email:
                return email.lower()
    m = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", node.get_text(" ", strip=True))
    return m.group().lower() if m else ""


def first_phone(node: Tag) -> str:
    phones = []
    for a in node.find_all("a", href=True):
        if a["href"].lower().startswith("tel:"):
            text = norm_ws(a.get_text(" ", strip=True)) or norm_ws(a["href"][4:])
            if text and text not in phones:
                phones.append(text)
    return "; ".join(phones)[:64]


# ----------------------------------------------------------------------------
# Page parsers
# ----------------------------------------------------------------------------

@dataclass
class Faculty:
    order: int
    name: str
    abbreviation: str
    website: str
    host: str
    email: str = ""
    phone: str = ""
    address: str = ""
    city: str = ""
    postal_code: str = ""
    building_name: str = ""
    stats: dict = field(default_factory=dict)


def parse_address(raw: str) -> tuple[str, str, str]:
    """'вул. Дорошенка, 41, м. Львів, 79000, Україна' -> street, city, postcode."""
    raw = norm_ws(raw)
    postal = ""
    m = re.search(r"\b(\d{5})\b", raw)
    if m:
        postal = m.group(1)
    city = ""
    m = re.search(r"м\.\s*([А-ЯІЇЄҐA-Z][\w’'-]+)", raw)
    if m:
        city = m.group(1)
    street = raw
    street = re.split(r",?\s*м\.\s*[А-ЯІЇЄҐA-Z]", street)[0]
    street = re.sub(r"\b\d{5}\b", "", street)
    street = re.sub(r",?\s*Україна\s*$", "", street, flags=re.IGNORECASE)
    street = norm_ws(street).strip(" ,")
    # A room number ("вул. Університетська 1/415") belongs to the faculty, not
    # to the building.
    street = re.sub(r"/\d+\s*$", "", street).strip(" ,")
    street = re.sub(r",\s*кімната\s*\d+\s*$", "", street, flags=re.IGNORECASE).strip(" ,")
    return street, city or "Львів", postal


def building_name_for(street: str) -> str:
    return f"Корпус на {street}"[:120] if street else ""


def building_key(street: str) -> str:
    """Identity of a physical building, ignoring punctuation and abbreviations.

    Faculties write the same address as "вул. Університетська 1" and
    "вул. Університетська, 1"; without this they would end up as two buildings
    and `buildings.name` (UNIQUE) would carry a near-duplicate row.
    """
    text = norm_ws(street).lower()
    text = re.sub(r"\b(вул|вулиця|просп|проспект|пл|площа)\b\.?", " ", text)
    text = re.sub(r"[^\w]", "", text, flags=re.UNICODE)
    return text


def parse_faculties_page(soup: BeautifulSoup) -> list[Faculty]:
    """Read the university structure page: name, site, e-mail, phone, address."""
    content = main_content(soup)
    faculties: list[Faculty] = []
    seen_hosts: set[str] = set()
    for index, item in enumerate(content.find_all(["li", "div"])):
        heading = item.find(["h2", "h3"])
        if heading is None:
            continue
        name = norm_ws(heading.get_text(" ", strip=True))
        if "факультет" not in name.lower():
            continue
        text = norm_ws(item.get_text(" ", strip=True))
        site = ""
        for a in item.find_all("a", href=True):
            href = urljoin("https://lnu.edu.ua/", a["href"])
            host = urlparse(href).netloc
            if host.endswith("lnu.edu.ua") and host not in ("lnu.edu.ua", "www.lnu.edu.ua"):
                site = f"https://{host}"
                break
        if not site:
            continue
        host = urlparse(site).netloc
        if host in seen_hosts:
            continue
        seen_hosts.add(host)
        address_raw = ""
        m = re.search(r"Адреса:\s*(.+?)(?:\s*Телефон:|\s*E-mail:|\s*Сайт:|$)", text)
        if m:
            address_raw = m.group(1)
        phone = ""
        m = re.search(r"Телефон:\s*(.+?)(?:\s*E-mail:|\s*Сайт:|$)", text)
        if m:
            phone = norm_ws(m.group(1)).replace(", ", "; ")[:128]
        street, city, postal = parse_address(address_raw)
        faculties.append(Faculty(
            order=len(faculties) + 1,
            name=name,
            abbreviation=faculty_abbreviation(name),
            website=site,
            host=host,
            email=first_email(item),
            phone=phone,
            address=street,
            city=city,
            postal_code=postal,
            building_name=building_name_for(street),
        ))
    LOG.info("Structure page: %d faculties found", len(faculties))
    return faculties


def parse_departments_page(soup: BeautifulSoup, base_url: str) -> list[dict]:
    """/about/departments -> [{url, name, email, phone}]."""
    content = main_content(soup)
    out: dict[str, dict] = {}
    for heading in content.find_all(["h2", "h3", "h4"]):
        a = heading.find("a", href=True)
        if a is None:
            continue
        url = clean_url(urljoin(base_url, a["href"]))
        if "/department/" not in urlparse(url).path:
            continue
        block = heading.parent if heading.parent is not None else heading
        out[url] = {
            "url": url,
            "name": norm_ws(a.get_text(" ", strip=True)),
            "email": first_email(block),
            "phone": first_phone(block),
        }
    # Fallback for themes that do not wrap department names in a heading.
    if not out:
        for url, text in find_links(content, base_url, r"^/department/[^/]+$", base_url):
            if text:
                out.setdefault(url, {"url": url, "name": text, "email": "", "phone": ""})
    return list(out.values())


def parse_department_page(soup: BeautifulSoup, base_url: str, fallback_name: str) -> dict:
    content = main_content(soup)
    h1 = content.find("h1")
    name = norm_ws(h1.get_text(" ", strip=True)) if h1 else ""
    if not name or len(name) < 4:
        name = fallback_name
    if name and not name.lower().startswith("кафедр"):
        name = "Кафедра " + name[0].lower() + name[1:]
    return {
        "name": name[:160],
        "email": (labelled_value(content, "Електронна пошта", "E-mail", "Email") or
                  first_email(content))[:64],
        "phone": (labelled_value(content, "Телефон") or first_phone(content))[:64],
        "staff_urls": [u for u, _ in find_links(content, base_url, r"^/employee/[^/]+$", base_url)],
    }


def parse_staff_page(soup: BeautifulSoup, base_url: str) -> dict[str, list[dict]]:
    """/about/staff -> {department match key: [{url, name, position, email}]}.

    One request per faculty returns every employee grouped under the department
    heading they belong to, which is far cheaper than crawling each department's
    own "Співробітники" tab — and it carries the position and e-mail already.
    """
    content = main_content(soup)
    by_department: dict[str, list[dict]] = {}
    current: str | None = None
    for element in content.descendants:
        if not isinstance(element, Tag):
            continue
        if element.name in ("h2", "h3", "h4"):
            text = norm_ws(element.get_text(" ", strip=True))
            link = element.find("a", href=True)
            is_department = bool(link and "/department/" in link["href"]) or \
                text.lower().startswith("кафедр")
            current = match_key(text) if is_department else None
            continue
        if element.name != "tr" or current is None:
            continue
        cells = element.find_all(["td", "th"])
        if not cells:
            continue
        links = cell_links(cells[0], base_url, r"^/employee/[^/]+$")
        if not links:
            continue
        url, full_name = links[0]
        position_text = cell_text(cells[1]) if len(cells) > 1 else ""
        if not position_text:
            position_text = cell_text(cells[0]).replace(full_name, " ")
        email = ""
        for cell in cells[1:]:
            email = first_email(cell) or email
        by_department.setdefault(current, []).append({
            "url": url,
            "full_name": full_name,
            "position_text": position_text,
            "email": email,
        })
    return by_department


def parse_employee_page(soup: BeautifulSoup, base_url: str) -> dict:
    content = main_content(soup)
    h1 = content.find("h1")
    full_name = norm_ws(h1.get_text(" ", strip=True)) if h1 else ""
    department_url = ""
    for url, _ in find_links(content, base_url, r"^/department/[^/]+$", base_url):
        department_url = url
        break
    return {
        "full_name": full_name,
        "position_text": labelled_value(content, "Посада"),
        "degree_text": labelled_value(content, "Науковий ступінь"),
        "title_text": labelled_value(content, "Вчене звання"),
        "email": (labelled_value(content, "Електронна пошта", "E-mail", "Email") or
                  first_email(content)),
        "department_url": department_url,
    }


def parse_academics_page(soup: BeautifulSoup, base_url: str, degree: str) -> list[dict]:
    """/academics/bachelor|master -> degree programme entries with curriculum page URLs.

    Degree programmes are rendered as headings like
    "### [014 Середня освіта (інформатика)](.../curriculum-education-master)".
    """
    content = main_content(soup)
    level = "bachelor" if degree == "BACHELOR" else "master"
    entries: list[dict] = []
    seen: set[str] = set()
    for a in content.find_all("a", href=True):
        url = clean_url(urljoin(base_url, a["href"]))
        path = urlparse(url).path
        if not re.match(rf"^/academics/{level}/[^/]+$", path):
            continue
        text = norm_ws(a.get_text(" ", strip=True))
        if not text or url in seen:
            continue
        m = DEGREE_PROGRAM_CODE_RE.match(text)
        if not m:
            continue
        seen.add(url)
        code, name = m.group(1), norm_ws(m.group(2))
        study_form = "PART_TIME" if re.search(r"заочн", name, re.IGNORECASE) else "FULL_TIME"
        name = re.sub(r"[.,]?\s*Заочна форма\s*$", "", name, flags=re.IGNORECASE).strip(" .,")
        entries.append({
            "code": code[:16],
            "name": name[:160],
            "degree": degree,
            "curriculum_url": url,
            "curriculum_title": text,
            "study_form": study_form,
        })
    return entries


def _semester_from_heading(text: str) -> int | None:
    m = re.search(r"(\d+)\s*-?\s*(?:й|ий|я)?\s*семестр", norm_ws(text), re.IGNORECASE)
    if m:
        return int(m.group(1))
    m = re.search(r"семестр\s*[№#]?\s*(\d+)", norm_ws(text), re.IGNORECASE)
    return int(m.group(1)) if m else None


def parse_curriculum_page(soup: BeautifulSoup, base_url: str) -> list[dict]:
    """Curriculum page -> [{semester, rows: [...]}].

    A row is either a plain course (one /course/ link in the subject cell) or an
    elective group ("Дисципліна на вибір 1:" followed by several /course/ links).
    """
    content = main_content(soup)
    semesters: list[dict] = []
    current_semester: int | None = None
    for element in content.descendants:
        if not isinstance(element, Tag):
            continue
        if element.name in ("h1", "h2", "h3", "h4", "p", "strong"):
            found = _semester_from_heading(element.get_text(" ", strip=True))
            if found:
                current_semester = found
            continue
        if element.name != "table":
            continue
        grid = table_grid(element)
        if len(grid) < 2:
            continue
        headers = [cell_text(c).lower() for c in grid[0]]
        if not any("предмет" in h or "дисциплін" in h or "назва" in h for h in headers):
            continue
        subject_col = next((i for i, h in enumerate(headers)
                            if "предмет" in h or "дисциплін" in h or "назва" in h), 0)
        hour_cols: dict[int, str] = {}
        control_col: int | None = None
        for i, h in enumerate(headers):
            if i == subject_col:
                continue
            if "звітн" in h or "контрол" in h or "форма" in h:
                control_col = i
                continue
            for needles, hour_type in HOUR_COLUMNS:
                if any(n in h for n in needles):
                    hour_cols[i] = hour_type
                    break
        semester = current_semester
        if semester is None:
            semester = _semester_from_heading(headers[0] if headers else "") or 1
        rows: list[dict] = []
        for grid_row in grid[1:]:
            subject_cell = grid_row[subject_col] if subject_col < len(grid_row) else None
            subject_text = cell_text(subject_cell)
            if not subject_text or subject_text.lower() in ("предмет", "разом", "усього", "всього"):
                continue
            links = cell_links(subject_cell, base_url, r"^/course/[^/]+$")
            hours = {}
            for col, hour_type in hour_cols.items():
                value = parse_int(cell_text(grid_row[col])) if col < len(grid_row) else 0
                if value:
                    hours[hour_type] = hours.get(hour_type, 0) + value
            cform = control_form(cell_text(grid_row[control_col])) if control_col is not None \
                and control_col < len(grid_row) else None
            low = subject_text.lower()
            is_elective = any(marker in low for marker in ELECTIVE_ROW_MARKERS)
            if is_elective and len(links) >= 1:
                label = re.split(r"[:–-]", subject_text, 1)[0]
                rows.append({
                    "kind": "elective_group",
                    "label": norm_ws(label)[:200],
                    "options": [{"name": text[:200], "course_url": url} for url, text in links],
                    "hours": hours,
                    "control_form": cform,
                })
            elif links:
                url, text = links[0]
                rows.append({
                    "kind": "course",
                    "name": (text or subject_text)[:200],
                    "course_url": url,
                    "hours": hours,
                    "control_form": cform,
                })
            else:
                rows.append({
                    "kind": "course",
                    "name": subject_text[:200],
                    "course_url": None,
                    "hours": hours,
                    "control_form": cform,
                })
        if rows:
            semesters.append({"semester": semester, "rows": rows})
    return semesters


def parse_course_page(soup: BeautifulSoup, base_url: str) -> dict:
    """/course/<slug> -> type, owning department, and the class tables.

    Lecture tables read "Семестр | К-сть годин | Лектор | Група(и)"; practical
    and lab tables read "Семестр | К-сть годин | Група | Викладач(і)" with the
    first two columns spanning every group row.
    """
    content = main_content(soup)
    h1 = content.find("h1")
    name = norm_ws(h1.get_text(" ", strip=True)) if h1 else ""
    type_text = labelled_value(content, "Тип").lower()
    if "вибірков" in type_text or "вільного вибору" in type_text:
        course_type = "ELECTIVE"
    elif "практик" in name.lower():
        course_type = "INTERNSHIP"
    elif "курсова" in name.lower():
        course_type = "COURSE_WORK"
    elif "кваліфікаційна" in name.lower() or "магістерська робота" in name.lower():
        course_type = "QUALIFICATION_WORK"
    else:
        course_type = "MANDATORY"
    department_text = labelled_value(content, "Кафедра")

    plan: list[dict] = []
    classes: list[dict] = []
    current_hour_type: str | None = None
    for element in content.descendants:
        if not isinstance(element, Tag):
            continue
        if element.name in ("h2", "h3", "h4"):
            heading = norm_ws(element.get_text(" ", strip=True)).lower()
            current_hour_type = None
            for needle, hour_type in SECTION_HOUR_TYPE:
                if needle in heading:
                    current_hour_type = hour_type
                    break
            continue
        if element.name != "table":
            continue
        grid = table_grid(element)
        if len(grid) < 2:
            continue
        headers = [cell_text(c).lower() for c in grid[0]]
        idx = {}
        for i, h in enumerate(headers):
            if "семестр" in h:
                idx.setdefault("semester", i)
            elif "кредит" in h:
                idx.setdefault("credits", i)
            elif "звітн" in h or "контрол" in h:
                idx.setdefault("control", i)
            elif "годин" in h:
                idx.setdefault("hours", i)
            elif "лектор" in h or "викладач" in h:
                idx.setdefault("lecturers", i)
            elif "груп" in h:
                idx.setdefault("groups", i)
        if "credits" in idx:  # "Навчальний план" summary table
            for grid_row in grid[1:]:
                semester = parse_int(cell_text(grid_row[idx["semester"]])) if "semester" in idx else 0
                if not semester:
                    continue
                plan.append({
                    "semester": semester,
                    "ects_credits": parse_int(cell_text(grid_row[idx["credits"]])) or None,
                    "control_form": control_form(cell_text(grid_row[idx["control"]]))
                    if "control" in idx else None,
                })
            continue
        if current_hour_type is None or "hours" not in idx:
            continue
        last_semester, last_hours = 0, 0
        for grid_row in grid[1:]:
            semester = parse_int(cell_text(grid_row[idx["semester"]])) if "semester" in idx else 0
            hours = parse_int(cell_text(grid_row[idx["hours"]]))
            semester = semester or last_semester
            hours = hours or last_hours
            last_semester, last_hours = semester, hours
            groups, lecturers = [], []
            if "groups" in idx and idx["groups"] < len(grid_row):
                groups = GROUP_RE.findall(cell_text(grid_row[idx["groups"]]))
            if "lecturers" in idx and idx["lecturers"] < len(grid_row):
                cell = grid_row[idx["lecturers"]]
                for url, text in cell_links(cell, base_url, r"^/employee/[^/]+$"):
                    lecturers.append({"url": url, "label": text})
                if not lecturers:
                    label = cell_text(cell)
                    if label:
                        lecturers.append({"url": None, "label": label})
            if not groups and not lecturers:
                continue
            classes.append({
                "hour_type": current_hour_type,
                "semester": semester or 1,
                "hours": hours,
                "groups": groups,
                "lecturers": lecturers,
            })
    return {
        "name": name[:200],
        "course_type": course_type,
        "department_text": department_text,
        "department_key": match_key(department_text) if department_text else "",
        "plan": plan,
        "classes": classes,
    }


# ----------------------------------------------------------------------------
# Crawl orchestration
# ----------------------------------------------------------------------------

class Crawler:
    def __init__(self, fetcher: Fetcher, args: argparse.Namespace):
        self.f = fetcher
        self.args = args
        self.faculties: list[dict] = []
        self.buildings: dict[str, dict] = {}
        self.building_keys: dict[str, str] = {}       # canonical address -> building name
        self.departments: list[dict] = []
        self.department_index: dict[str, dict] = {}   # url -> record
        self.lecturers: dict[str, dict] = {}          # url -> record
        self.degree_programs: list[dict] = []
        self.curricula: list[dict] = []
        self.courses: dict[str, dict] = {}            # url -> record
        self.warnings: list[str] = []

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        LOG.warning(message)

    # -- faculty ordering ----------------------------------------------------

    def order_faculties(self, faculties: list[Faculty], priority_hosts: list[str]) -> list[Faculty]:
        by_host = {f.host: f for f in faculties}
        ordered: list[Faculty] = []
        for host in priority_hosts:
            faculty = by_host.get(host)
            if faculty is None:
                self.warn(f"Priority site '{host}' is not listed on {FACULTIES_URL}; skipped")
                continue
            ordered.append(faculty)
        seen = {f.host for f in ordered}
        ordered.extend(f for f in faculties if f.host not in seen)
        for index, faculty in enumerate(ordered, start=1):
            faculty.order = index
        LOG.info("Processing order: %s", ", ".join(f.host for f in ordered))
        return ordered

    # -- per-faculty steps ---------------------------------------------------

    def crawl_faculty(self, faculty: Faculty) -> None:
        LOG.info("=" * 78)
        LOG.info("[%d] %s (%s)", faculty.order, faculty.name, faculty.host)
        LOG.info("=" * 78)
        if faculty.building_name:
            key = building_key(faculty.address)
            existing = self.building_keys.get(key)
            if existing:
                LOG.debug("  building '%s' reuses '%s'", faculty.building_name, existing)
                faculty.building_name = existing
            else:
                self.building_keys[key] = faculty.building_name
                self.buildings[faculty.building_name] = {
                    "name": faculty.building_name,
                    "address": faculty.address[:160],
                    "city": faculty.city[:64],
                    "postal_code": faculty.postal_code[:10],
                }
        record = {
            "order": faculty.order,
            "name": faculty.name[:160],
            "abbreviation": faculty.abbreviation[:32],
            "website": faculty.website[:128],
            "host": faculty.host,
            "email": faculty.email[:64],
            "phone": faculty.phone[:128],
            "building_name": faculty.building_name,
        }
        self.faculties.append(record)

        departments = self.crawl_departments(faculty)
        self.crawl_lecturers(faculty, departments)
        degree_programs = self.crawl_degree_programs(faculty)
        self.crawl_curricula(faculty, degree_programs)

        record["stats"] = {
            "departments": len(departments),
            "lecturers": sum(1 for l in self.lecturers.values()
                             if l["faculty_host"] == faculty.host),
            "degree_programs": len(degree_programs),
            "courses": sum(1 for c in self.courses.values()
                           if c["faculty_host"] == faculty.host),
        }
        LOG.info("[%d] %s done: %s", faculty.order, faculty.host, record["stats"])

    def crawl_departments(self, faculty: Faculty) -> list[dict]:
        url = f"{faculty.website}/about/departments"
        soup = self.f.soup(url)
        if soup is None:
            self.warn(f"{faculty.host}: no departments page at {url}")
            return []
        listed = parse_departments_page(soup, url)
        LOG.info("  departments page: %d links", len(listed))
        out: list[dict] = []
        for index, item in enumerate(listed, start=1):
            LOG.info("  [%d/%d] department %s", index, len(listed), item["url"])
            detail = {}
            page = self.f.soup(item["url"])
            if page is not None:
                detail = parse_department_page(page, item["url"], item["name"])
            else:
                self.warn(f"{faculty.host}: department page unreachable {item['url']}")
            name = detail.get("name") or item["name"]
            if name and not name.lower().startswith("кафедр"):
                name = "Кафедра " + name[0].lower() + name[1:]
            record = {
                "url": item["url"],
                "faculty_host": faculty.host,
                "name": name[:160],
                "match_key": match_key(name),
                "abbreviation": department_abbreviation(name),
                "email": (detail.get("email") or item["email"])[:64],
                "phone": (detail.get("phone") or item["phone"])[:64],
                "staff_urls": detail.get("staff_urls", []),
            }
            self.departments.append(record)
            self.department_index[record["url"]] = record
            out.append(record)
        return out

    def crawl_lecturers(self, faculty: Faculty, departments: list[dict]) -> None:
        """Map employees to departments, then visit each employee page."""
        by_key: dict[str, list[dict]] = {}
        staff_url = f"{faculty.website}/about/staff"
        soup = self.f.soup(staff_url)
        if soup is not None:
            by_key = parse_staff_page(soup, staff_url)
            LOG.info("  staff page: %d department blocks", len(by_key))
        else:
            LOG.info("  no /about/staff page; falling back to department pages")

        department_by_key = {d["match_key"]: d for d in departments}
        pending: list[tuple[dict, dict]] = []   # (department, staff entry)
        for key, entries in by_key.items():
            department = department_by_key.get(key)
            if department is None:
                department = next((d for d in departments
                                   if key and (key in d["match_key"] or d["match_key"] in key)), None)
            if department is None:
                LOG.debug("  staff block '%s' matches no department; skipped", key)
                continue
            for entry in entries:
                pending.append((department, entry))
        # Departments with no staff-page block: use the links on their own page.
        covered = {entry["url"] for _, entry in pending}
        for department in departments:
            for url in department["staff_urls"]:
                if url not in covered:
                    pending.append((department, {"url": url, "full_name": "",
                                                 "position_text": "", "email": ""}))
                    covered.add(url)

        LOG.info("  %d employee links to inspect", len(pending))
        imported = skipped = 0
        for index, (department, entry) in enumerate(pending, start=1):
            url = entry["url"]
            if url in self.lecturers:
                continue
            full_name = entry.get("full_name", "")
            position_text = entry.get("position_text", "")
            email = entry.get("email", "")
            degree_text = ""
            if not self.args.skip_lecturer_pages:
                page = self.f.soup(url)
                if page is not None:
                    detail = parse_employee_page(page, url)
                    full_name = detail["full_name"] or full_name
                    position_text = detail["position_text"] or position_text
                    email = detail["email"] or email
                    degree_text = detail["degree_text"]
                    if detail["department_url"] in self.department_index:
                        department = self.department_index[detail["department_url"]]
                else:
                    self.warn(f"{faculty.host}: employee page unreachable {url}")
            position = lecturer_position(position_text)
            if position is None:
                skipped += 1
                LOG.debug("  skip non-teaching '%s' (%s)", full_name, position_text)
                continue
            last, first, middle = split_full_name(full_name)
            if not last or not first:
                skipped += 1
                self.warn(f"{faculty.host}: unusable lecturer name at {url}: '{full_name}'")
                continue
            self.lecturers[url] = {
                "url": url,
                "faculty_host": faculty.host,
                "department_url": department["url"],
                "department_key": department["match_key"],
                "first_name": first[:64],
                "middle_name": (middle[:64] or None),
                "last_name": last[:64],
                "email": (email[:64] or None),
                "position": position,
                "academic_degree_id": academic_degree_id(degree_text),
                "raw_position": position_text[:120],
                "name_key": person_key(last, first, middle),
                "short_key": short_person_key(f"{last} {first[:1]} {middle[:1]}"),
            }
            imported += 1
            if index % 25 == 0:
                LOG.info("  ... %d/%d employees processed", index, len(pending))
        LOG.info("  lecturers: %d imported, %d skipped (non-teaching / unnamed)",
                 imported, skipped)

    def crawl_degree_programs(self, faculty: Faculty) -> list[dict]:
        found: list[dict] = []
        for level, degree in (("bachelor", "BACHELOR"), ("master", "MASTER")):
            url = f"{faculty.website}/academics/{level}"
            soup = self.f.soup(url)
            if soup is None:
                LOG.info("  no /academics/%s page", level)
                continue
            entries = parse_academics_page(soup, url, degree)
            LOG.info("  /academics/%s: %d degree programme entries", level, len(entries))
            found.extend(entries)

        merged: dict[tuple[str, str], dict] = {}
        for entry in found:
            key = (entry["code"], entry["degree"])
            record = merged.get(key)
            if record is None:
                record = {
                    "faculty_host": faculty.host,
                    "code": entry["code"],
                    "name": entry["name"],
                    "degree": entry["degree"],
                    "curricula": [],
                }
                merged[key] = record
                self.degree_programs.append(record)
            record["curricula"].append({
                "url": entry["curriculum_url"],
                "title": entry["curriculum_title"],
                "study_form": entry["study_form"],
            })
        LOG.info("  degree_programs after merge: %d", len(merged))
        return list(merged.values())

    def crawl_curricula(self, faculty: Faculty, degree_programs: list[dict]) -> None:
        for degree_program in degree_programs:
            for curriculum in degree_program["curricula"]:
                url = curriculum["url"]
                LOG.info("  curriculum %s %s -> %s", degree_program["code"],
                         degree_program["degree"], url)
                soup = self.f.soup(url)
                if soup is None:
                    self.warn(f"{faculty.host}: curriculum page unreachable {url}")
                    continue
                semesters = parse_curriculum_page(soup, url)
                total_rows = sum(len(s["rows"]) for s in semesters)
                LOG.info("    %d semesters, %d rows", len(semesters), total_rows)
                if not semesters:
                    self.warn(f"{faculty.host}: no curriculum table parsed at {url}")
                self.curricula.append({
                    "url": url,
                    "faculty_host": faculty.host,
                    "degree_program_code": degree_program["code"],
                    "degree_program_name": degree_program["name"],
                    "degree_program_degree": degree_program["degree"],
                    "study_form": curriculum["study_form"],
                    "semesters": semesters,
                })
                course_urls = []
                for semester in semesters:
                    for row in semester["rows"]:
                        if row["kind"] == "course" and row["course_url"]:
                            course_urls.append(row["course_url"])
                        elif row["kind"] == "elective_group":
                            course_urls.extend(o["course_url"] for o in row["options"])
                self.crawl_courses(faculty, course_urls)

    def crawl_courses(self, faculty: Faculty, urls: Iterable[str]) -> None:
        todo = [u for u in dict.fromkeys(urls) if u not in self.courses]
        if not todo:
            return
        LOG.info("    %d new course pages", len(todo))
        for index, url in enumerate(todo, start=1):
            soup = self.f.soup(url)
            if soup is None:
                self.warn(f"{faculty.host}: course page unreachable {url}")
                self.courses[url] = {
                    "url": url, "faculty_host": faculty.host, "name": "",
                    "course_type": "MANDATORY", "department_text": "",
                    "department_key": "", "plan": [], "classes": [], "reachable": False,
                }
                continue
            parsed = parse_course_page(soup, url)
            parsed["url"] = url
            parsed["faculty_host"] = faculty.host
            parsed["reachable"] = True
            self.courses[url] = parsed
            if index % 20 == 0:
                LOG.info("    ... %d/%d course pages", index, len(todo))
        LOG.info("    course pages done (%d total known)", len(self.courses))

    # -- output --------------------------------------------------------------

    def write(self, outdir: str) -> None:
        os.makedirs(outdir, exist_ok=True)

        def dump(filename: str, payload: Any) -> None:
            path = os.path.join(outdir, filename)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=False)
            LOG.info("wrote %s (%d bytes)", path, os.path.getsize(path))

        dump("faculties.json", {
            "buildings": list(self.buildings.values()),
            "faculties": self.faculties,
        })
        dump("departments.json", self.departments)
        dump("lecturers.json", list(self.lecturers.values()))
        dump("degree_programs.json", self.degree_programs)
        dump("curricula.json", self.curricula)
        dump("courses.json", list(self.courses.values()))
        dump("manifest.json", {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": FACULTIES_URL,
            "counts": {
                "buildings": len(self.buildings),
                "faculties": len(self.faculties),
                "departments": len(self.departments),
                "lecturers": len(self.lecturers),
                "degree_programs": len(self.degree_programs),
                "curricula": len(self.curricula),
                "courses": len(self.courses),
            },
            "http": self.f.stats,
            "warnings": self.warnings,
        })


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def read_priority_file(path: str) -> list[str]:
    if not os.path.exists(path):
        LOG.warning("Priority file %s not found; using the site order only", path)
        return []
    hosts = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#")[0].strip()
            if not line:
                continue
            host = urlparse(line if "//" in line else "https://" + line).netloc
            hosts.append(host.lower())
    LOG.info("Priority faculties (%d): %s", len(hosts), ", ".join(hosts))
    return hosts


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-o", "--out", default=os.path.join(HERE, "data"),
                   help="directory for the JSON output (default: ./data)")
    p.add_argument("--priority-file", default=os.path.join(HERE, "priority_faculties.txt"),
                   help="file listing faculty sites to process first, one per line")
    p.add_argument("--faculties", default="",
                   help="comma-separated hosts to crawl (overrides everything else)")
    p.add_argument("--limit-faculties", type=int, default=0,
                   help="stop after N faculties (0 = all)")
    p.add_argument("--cache-dir", default=os.path.join(HERE, ".cache"),
                   help="on-disk HTTP cache; makes re-runs cheap (default: ./.cache)")
    p.add_argument("--no-cache", action="store_true", help="disable the HTTP cache")
    p.add_argument("--offline", default=None, metavar="ROOT",
                   help="read pages from ROOT/<host>/<path>.html instead of the network")
    p.add_argument("--delay", type=float, default=0.3,
                   help="seconds to sleep between downloads (default: 0.3)")
    p.add_argument("--skip-lecturer-pages", action="store_true",
                   help="do not open each /employee/ page (loses academic degrees)")
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    p.add_argument("--log-file", default=None, help="also write the log to this file")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if args.log_file:
        handlers.append(logging.FileHandler(args.log_file, encoding="utf-8"))
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
    )

    started = time.time()
    LOG.info("LNU scrape starting (out=%s, offline=%s)", args.out, args.offline or "no")

    fetcher = Fetcher(
        cache_dir=None if (args.no_cache or args.offline) else args.cache_dir,
        delay=args.delay,
        offline_root=args.offline,
    )
    crawler = Crawler(fetcher, args)

    soup = fetcher.soup(FACULTIES_URL)
    if soup is None:
        LOG.error("Could not load %s — aborting", FACULTIES_URL)
        return 1
    faculties = parse_faculties_page(soup)
    if not faculties:
        LOG.error("No faculties parsed from %s — aborting", FACULTIES_URL)
        return 1

    if args.faculties:
        wanted = [h.strip().lower() for h in args.faculties.split(",") if h.strip()]
        ordered = crawler.order_faculties([f for f in faculties if f.host in wanted], wanted)
    else:
        ordered = crawler.order_faculties(faculties, read_priority_file(args.priority_file))
    if args.limit_faculties:
        ordered = ordered[:args.limit_faculties]
        LOG.info("Limited to the first %d faculties", len(ordered))

    for faculty in ordered:
        try:
            crawler.crawl_faculty(faculty)
        except KeyboardInterrupt:
            LOG.warning("Interrupted — writing what has been collected so far")
            break
        except Exception as exc:  # noqa: BLE001 - one bad site must not kill the run
            crawler.warn(f"{faculty.host}: crawl failed ({exc.__class__.__name__}: {exc})")
            LOG.exception("Unhandled error while crawling %s", faculty.host)

    crawler.write(args.out)
    LOG.info("-" * 78)
    LOG.info("Done in %.1fs | http: %s", time.time() - started, fetcher.stats)
    LOG.info("buildings=%d faculties=%d departments=%d lecturers=%d degree_programs=%d "
             "curricula=%d courses=%d warnings=%d",
             len(crawler.buildings), len(crawler.faculties), len(crawler.departments),
             len(crawler.lecturers), len(crawler.degree_programs), len(crawler.curricula),
             len(crawler.courses), len(crawler.warnings))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
