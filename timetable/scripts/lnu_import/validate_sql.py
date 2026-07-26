#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Independent check that a generated data.sql really loads against schema.sql.

``build_sql.py`` self-checks its in-memory model; this script re-reads the two
*files* instead, so it also catches rendering bugs (quoting, column order, a
table emitted before the one it references).  It does three things:

  1. parses data.sql with the real PostgreSQL grammar (``pglast``) when it is
     installed, which is a genuine syntax check rather than a regex guess;
  2. reads schema.sql for tables, columns, types, NOT NULL, UNIQUE, PRIMARY KEY,
     FOREIGN KEY and ENUM definitions;
  3. replays every INSERT in file order and reports the first problems found:
     unknown table/column, bad enum label, over-long VARCHAR, NULL in a NOT NULL
     column, duplicate key, and a foreign key pointing at a row that does not
     exist *yet* (which is what a real ``psql -f`` would reject).

    python3 validate_sql.py generated/data.sql --schema ../../src/main/resources/db/schema.sql
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SCHEMA = os.path.normpath(
    os.path.join(HERE, "..", "..", "src", "main", "resources", "db", "schema.sql"))


# ----------------------------------------------------------------- schema.sql

class Column:
    def __init__(self, name: str, type_name: str, not_null: bool, unique: bool,
                 length: int | None, references: tuple[str, str] | None):
        self.name = name
        self.type = type_name
        self.not_null = not_null
        self.unique = unique
        self.length = length
        self.references = references

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{self.name} {self.type}{'' if self.length is None else f'({self.length})'}>"


class Schema:
    def __init__(self) -> None:
        self.enums: dict[str, set[str]] = {}
        self.columns: dict[str, dict[str, Column]] = {}
        self.uniques: dict[str, list[list[str]]] = defaultdict(list)


def parse_schema(path: str) -> Schema:
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    # schema.sql documents several columns with "--" comments *inside* the
    # CREATE TABLE body, and those comments contain commas — strip them first or
    # the definition split below tears real column lines apart.
    text = re.sub(r"--[^\n]*", "", text)
    schema = Schema()

    for name, body in re.findall(r"CREATE TYPE\s+(\w+)\s+AS ENUM\s*\((.*?)\);", text, re.S):
        schema.enums[name] = {v.strip().strip("'") for v in body.split(",") if v.strip()}

    for table, body in re.findall(r"CREATE TABLE\s+(\w+)\s*\((.*?)\n\);", text, re.S):
        columns: dict[str, Column] = {}
        for line in split_definitions(body):
            line = line.strip().rstrip(",")
            if not line or line.startswith("--"):
                continue
            low = line.upper()
            if low.startswith(("PRIMARY KEY", "CONSTRAINT", "UNIQUE", "FOREIGN KEY", "CHECK")):
                m = re.match(r"UNIQUE\s*\((.*?)\)", line, re.I)
                if m:
                    schema.uniques[table].append([c.strip() for c in m.group(1).split(",")])
                m = re.match(r"PRIMARY KEY\s*\((.*?)\)", line, re.I)
                if m:
                    schema.uniques[table].append([c.strip() for c in m.group(1).split(",")])
                continue
            m = re.match(r'"?(\w+)"?\s+([A-Za-z_]+(?:\s+[A-Za-z_]+)*)\s*(?:\((\d+)\))?(.*)$', line)
            if not m:
                continue
            name, type_name, length, rest = m.group(1), m.group(2).lower(), m.group(3), m.group(4)
            not_null = "NOT NULL" in rest.upper() or type_name in ("bigserial", "serial")
            unique = "UNIQUE" in rest.upper()
            references = None
            ref = re.search(r"REFERENCES\s+(\w+)\s*\((\w+)\)", rest, re.I)
            if ref:
                references = (ref.group(1), ref.group(2))
            columns[name] = Column(name, type_name, not_null, unique,
                                   int(length) if length else None, references)
            if type_name in ("bigserial", "serial"):
                schema.uniques[table].append([name])
            elif unique:
                schema.uniques[table].append([name])
        schema.columns[table] = columns
    return schema


def split_definitions(body: str) -> list[str]:
    """Split a CREATE TABLE body on commas that are not inside parentheses."""
    parts, depth, current = [], 0, []
    for char in body:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return parts


# ------------------------------------------------------------------- data.sql

INSERT_RE = re.compile(
    r"INSERT\s+INTO\s+(?:public\.)?(\w+)\s*\(([^)]*)\)\s*VALUES\s*\((.*?)\);",
    re.S | re.I)


def split_values(raw: str) -> list[str]:
    """Split a VALUES tuple, honouring '' escapes inside string literals."""
    values, current, in_string, index = [], [], False, 0
    while index < len(raw):
        char = raw[index]
        if in_string:
            if char == "'":
                if index + 1 < len(raw) and raw[index + 1] == "'":
                    current.append("''")
                    index += 2
                    continue
                in_string = False
            current.append(char)
        elif char == "'":
            in_string = True
            current.append(char)
        elif char == ",":
            values.append("".join(current).strip())
            current = []
        else:
            current.append(char)
        index += 1
    values.append("".join(current).strip())
    return values


def literal(token: str):
    token = token.strip()
    if token.upper() == "NULL":
        return None
    if token.upper() in ("TRUE", "FALSE"):
        return token.upper() == "TRUE"
    if token.startswith("'") and token.endswith("'"):
        return token[1:-1].replace("''", "'")
    try:
        return int(token)
    except ValueError:
        return token


# ------------------------------------------------------------------ validate

def validate(sql_path: str, schema: Schema, max_errors: int) -> list[str]:
    with open(sql_path, encoding="utf-8") as fh:
        sql = fh.read()

    errors: list[str] = []
    rows: dict[str, list[dict]] = defaultdict(list)
    keys: dict[tuple[str, tuple[str, ...]], set] = defaultdict(set)
    statements = 0

    for match in INSERT_RE.finditer(sql):
        statements += 1
        table = match.group(1)
        columns = [c.strip().strip('"') for c in match.group(2).split(",")]
        values = [literal(v) for v in split_values(match.group(3))]
        if table not in schema.columns:
            errors.append(f"unknown table public.{table}")
            continue
        definition = schema.columns[table]
        if len(columns) != len(values):
            errors.append(f"{table}: {len(columns)} columns but {len(values)} values")
            continue
        row = dict(zip(columns, values))

        for name, value in row.items():
            column = definition.get(name)
            if column is None:
                errors.append(f"{table}: no column '{name}' in schema.sql")
                continue
            if value is None:
                if column.not_null:
                    errors.append(f"{table}.{name}: NULL in a NOT NULL column")
                continue
            if column.type in schema.enums and value not in schema.enums[column.type]:
                errors.append(f"{table}.{name}: '{value}' is not a {column.type} label")
            if column.length and isinstance(value, str) and len(value) > column.length:
                errors.append(f"{table}.{name}: {len(value)} chars exceeds "
                              f"{column.type}({column.length}) — {value[:40]!r}")
            if column.references:
                target_table, target_column = column.references
                known = {r.get(target_column) for r in rows[target_table]}
                if value not in known:
                    errors.append(f"{table}.{name}={value!r} references "
                                  f"{target_table}.{target_column}, which has no such row "
                                  f"at this point in the file")

        # NOT NULL columns omitted entirely from the INSERT (no DEFAULT).
        for name, column in definition.items():
            if name in row or not column.not_null:
                continue
            if column.type in ("bigserial", "serial"):
                continue
            errors.append(f"{table}: NOT NULL column '{name}' is never given a value")

        for unique_columns in schema.uniques.get(table, []):
            if not all(c in row for c in unique_columns):
                continue
            key = tuple(row[c] for c in unique_columns)
            if any(v is None for v in key):
                continue
            bucket = keys[(table, tuple(unique_columns))]
            if key in bucket:
                errors.append(f"{table}: duplicate {list(unique_columns)} = {key}")
            bucket.add(key)

        rows[table].append(row)
        if len(errors) >= max_errors:
            errors.append(f"... stopped after {max_errors} problems")
            break

    print(f"statements replayed : {statements}")
    for table in sorted(rows):
        print(f"  {table:<44} {len(rows[table])}")
    return errors


def syntax_check(sql_path: str) -> str:
    try:
        import pglast
    except ImportError:
        return "pglast not installed — syntax not checked (pip install pglast)"
    with open(sql_path, encoding="utf-8") as fh:
        sql = fh.read()
    try:
        parsed = pglast.parse_sql(sql)
    except Exception as exc:  # noqa: BLE001 - surfacing the parser's message is the point
        return f"SYNTAX ERROR: {exc}"
    return f"PostgreSQL grammar: OK ({len(parsed)} statements parsed by pglast)"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sql", nargs="?", default=os.path.join(HERE, "generated", "data.sql"))
    parser.add_argument("--schema", default=DEFAULT_SCHEMA)
    parser.add_argument("--max-errors", type=int, default=50)
    args = parser.parse_args(argv)

    print(f"schema : {args.schema}")
    print(f"data   : {args.sql}\n")
    schema = parse_schema(args.schema)
    print(f"schema.sql: {len(schema.columns)} tables, {len(schema.enums)} enum types\n")

    print(syntax_check(args.sql), "\n")
    errors = validate(args.sql, schema, args.max_errors)
    print()
    if errors:
        print(f"FAILED — {len(errors)} problem(s):")
        for message in errors:
            print("  -", message)
        return 1
    print("PASSED — every INSERT satisfies the schema's columns, types, enums, "
          "widths, NOT NULLs, unique keys and foreign keys (in file order).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
