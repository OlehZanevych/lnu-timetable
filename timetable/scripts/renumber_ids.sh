#!/usr/bin/env bash
#
# Close gaps in every table's primary key sequence, e.g. ids 1, 2, 5, 6, 7, 10
# become 1, 2, 3, 4, 5, 6. All foreign keys pointing at the renumbered rows
# (including self-referencing ones, e.g. courses.parent_course_id) are updated
# to match, and each table's sequence is reset to the new max id.
#
# This is a generic, schema-driven script: it discovers every table with a
# single-column integer primary key (via pg_constraint) and every foreign key
# that references it, so it does not need to hard-code table/column names and
# will keep working as the schema evolves.
#
# Renumbering is done in two phases per table to avoid transient unique-key
# collisions, and FK triggers are disabled for the duration of the transaction
# (session_replication_role = replica) so update order across tables does not
# matter. Everything runs in a single transaction: either it all succeeds or
# nothing changes.
#
# WARNING: this changes primary key values in place. Anything outside the
# database that stores these ids (caches, external references, etc.) will be
# out of sync afterwards.
#
# Connection info is read from src/main/resources/application.properties
# (spring.r2dbc.url) and the credentials from src/main/resources/application-loc.properties
# (spring.r2dbc.username / spring.r2dbc.password). Both files are required. The
# connected role must be able to set session_replication_role (superuser, or
# the table owner on modern Postgres).
#
# Usage (run from anywhere, or from the "timetable" project root):
#   scripts/renumber_ids.sh
#
# Requires the PostgreSQL client tools (psql) to be installed locally.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$PROJECT_ROOT/src/main/resources"
PROPERTIES_FILE="$RESOURCES_DIR/application.properties"
LOCAL_PROPERTIES_FILE="$RESOURCES_DIR/application-loc.properties"

if ! command -v psql >/dev/null 2>&1; then
    echo "Error: psql not found. Install the PostgreSQL client tools first." >&2
    exit 1
fi

for f in "$PROPERTIES_FILE" "$LOCAL_PROPERTIES_FILE"; do
    if [[ ! -f "$f" ]]; then
        echo "Error: properties file not found at $f" >&2
        exit 1
    fi
done

# Pull a "key=value" line out of a .properties file (ignores blank/# lines).
read_prop() {
    local file="$1"
    local key="$2"
    # "|| true" keeps a key that is absent from tripping "set -e" before the checks below.
    { grep -E "^${key}=" "$file" || true; } | tail -n1 | cut -d'=' -f2- | tr -d '\r'
}

DB_URL="$(read_prop "$PROPERTIES_FILE" 'spring\.r2dbc\.url')"
DB_USER="$(read_prop "$LOCAL_PROPERTIES_FILE" 'spring\.r2dbc\.username')"
# A blank password is legitimate (trust/peer authentication), so only the user is required.
DB_PASSWORD="$(read_prop "$LOCAL_PROPERTIES_FILE" 'spring\.r2dbc\.password')"

if [[ -z "$DB_URL" ]]; then
    echo "Error: spring.r2dbc.url not found in $PROPERTIES_FILE" >&2
    exit 1
fi

if [[ -z "$DB_USER" ]]; then
    echo "Error: spring.r2dbc.username not found in $LOCAL_PROPERTIES_FILE" >&2
    exit 1
fi

# DB_URL looks like: r2dbc:postgresql://HOST:PORT/DBNAME
CONN="${DB_URL#r2dbc:postgresql://}"
DB_HOST_PORT="${CONN%%/*}"
DB_NAME="${CONN#*/}"
DB_HOST="${DB_HOST_PORT%%:*}"
DB_PORT="${DB_HOST_PORT##*:}"

if [[ -t 0 ]]; then
    read -r -p "This will renumber primary keys in every table of '$DB_NAME' on $DB_HOST:$DB_PORT. Continue? [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi
fi

SQL="$(cat <<'EOF'
BEGIN;
SET LOCAL session_replication_role = 'replica';

DO $do$
DECLARE
    tbl        RECORD;
    fk         RECORD;
    offset_val BIGINT;
    row_count  BIGINT;
BEGIN
    FOR tbl IN
        SELECT c.conrelid::regclass::text AS table_name,
               a.attname                  AS pk_col
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'p'
          AND array_length(c.conkey, 1) = 1
          AND a.atttypid IN ('int2'::regtype, 'int4'::regtype, 'int8'::regtype)
    LOOP
        EXECUTE format('SELECT count(*) FROM %s', tbl.table_name) INTO row_count;
        IF row_count = 0 THEN
            CONTINUE;
        END IF;

        DROP TABLE IF EXISTS _remap;
        EXECUTE format(
            'CREATE TEMP TABLE _remap AS
                 SELECT %I AS old_id, row_number() OVER (ORDER BY %I) AS new_id
                 FROM %s',
            tbl.pk_col, tbl.pk_col, tbl.table_name
        );

        SELECT max(old_id) + 1000000000 INTO offset_val FROM _remap;

        -- Phase 1: move current rows out of the way (offset ranges never collide).
        EXECUTE format(
            'UPDATE %s t SET %I = m.new_id + %s FROM _remap m WHERE t.%I = m.old_id',
            tbl.table_name, tbl.pk_col, offset_val, tbl.pk_col
        );

        FOR fk IN
            SELECT r.conrelid::regclass::text AS ref_table,
                   af.attname                  AS ref_col
            FROM pg_constraint r
            JOIN pg_attribute af
              ON af.attrelid = r.conrelid AND af.attnum = r.conkey[1]
            WHERE r.contype = 'f'
              AND r.confrelid = tbl.table_name::regclass
              AND array_length(r.conkey, 1) = 1
        LOOP
            EXECUTE format(
                'UPDATE %s c SET %I = m.new_id + %s FROM _remap m WHERE c.%I = m.old_id',
                fk.ref_table, fk.ref_col, offset_val, fk.ref_col
            );
        END LOOP;

        -- Phase 2: drop the offset, landing on the final gap-free ids.
        EXECUTE format(
            'UPDATE %s SET %I = %I - %s WHERE %I > %s',
            tbl.table_name, tbl.pk_col, tbl.pk_col, offset_val, tbl.pk_col, offset_val
        );

        FOR fk IN
            SELECT r.conrelid::regclass::text AS ref_table,
                   af.attname                  AS ref_col
            FROM pg_constraint r
            JOIN pg_attribute af
              ON af.attrelid = r.conrelid AND af.attnum = r.conkey[1]
            WHERE r.contype = 'f'
              AND r.confrelid = tbl.table_name::regclass
              AND array_length(r.conkey, 1) = 1
        LOOP
            EXECUTE format(
                'UPDATE %s SET %I = %I - %s WHERE %I > %s',
                fk.ref_table, fk.ref_col, fk.ref_col, offset_val, fk.ref_col, offset_val
            );
        END LOOP;

        EXECUTE format(
            'SELECT setval(pg_get_serial_sequence(%L, %L), (SELECT max(%I) FROM %s))',
            tbl.table_name, tbl.pk_col, tbl.pk_col, tbl.table_name
        );

        RAISE NOTICE 'Renumbered %', tbl.table_name;
    END LOOP;

    DROP TABLE IF EXISTS _remap;
END
$do$;

COMMIT;
EOF
)"

export PGPASSWORD="$DB_PASSWORD"

echo "Renumbering primary keys in '$DB_NAME' on $DB_HOST:$DB_PORT..."
echo "$SQL" | psql \
    --host="$DB_HOST" \
    --port="$DB_PORT" \
    --username="$DB_USER" \
    --dbname="$DB_NAME" \
    --set=ON_ERROR_STOP=1

unset PGPASSWORD

echo "Done. Gaps closed and sequences reset."
