#!/usr/bin/env bash
#
# Recreate the 'lnu-timetable' database schema and repopulate it with the
# test data checked into the repo, i.e. run schema.sql followed by data.sql.
#
# WARNING: schema.sql starts with "DROP SCHEMA public CASCADE", so this
# destroys and rebuilds the entire public schema. Do not point this at a
# database you care about keeping.
#
# Credentials/connection info are read from src/main/resources/application.properties
# (spring.r2dbc.url / spring.r2dbc.username / spring.r2dbc.password).
#
# Usage (run from anywhere, or from the "timetable" project root):
#   scripts/reset_db.sh
#
# Requires the PostgreSQL client tools (psql) to be installed locally.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROPERTIES_FILE="$PROJECT_ROOT/src/main/resources/application.properties"
DB_DIR="$PROJECT_ROOT/src/main/resources/db"
SCHEMA_FILE="$DB_DIR/schema.sql"
DATA_FILE="$DB_DIR/data.sql"

if ! command -v psql >/dev/null 2>&1; then
    echo "Error: psql not found. Install the PostgreSQL client tools first." >&2
    exit 1
fi

for f in "$PROPERTIES_FILE" "$SCHEMA_FILE" "$DATA_FILE"; do
    if [[ ! -f "$f" ]]; then
        echo "Error: required file not found: $f" >&2
        exit 1
    fi
done

# Pull a "key=value" line out of application.properties (ignores blank/# lines).
read_prop() {
    local key="$1"
    grep -E "^${key}=" "$PROPERTIES_FILE" | tail -n1 | cut -d'=' -f2- | tr -d '\r'
}

DB_URL="$(read_prop 'spring\.r2dbc\.url')"
DB_USER="$(read_prop 'spring\.r2dbc\.username')"
DB_PASSWORD="$(read_prop 'spring\.r2dbc\.password')"

if [[ -z "$DB_URL" ]]; then
    echo "Error: spring.r2dbc.url not found in $PROPERTIES_FILE" >&2
    exit 1
fi

# DB_URL looks like: r2dbc:postgresql://HOST:PORT/DBNAME
CONN="${DB_URL#r2dbc:postgresql://}"
DB_HOST_PORT="${CONN%%/*}"
DB_NAME="${CONN#*/}"
DB_HOST="${DB_HOST_PORT%%:*}"
DB_PORT="${DB_HOST_PORT##*:}"

if [[ -t 0 ]]; then
    read -r -p "This will DROP and recreate the public schema of '$DB_NAME' on $DB_HOST:$DB_PORT. Continue? [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi
fi

export PGPASSWORD="$DB_PASSWORD"

run_psql() {
    psql \
        --host="$DB_HOST" \
        --port="$DB_PORT" \
        --username="$DB_USER" \
        --dbname="$DB_NAME" \
        --set=ON_ERROR_STOP=1 \
        --quiet \
        --file="$1"
}

echo "Applying schema.sql to '$DB_NAME' on $DB_HOST:$DB_PORT..."
run_psql "$SCHEMA_FILE"

echo "Applying data.sql to '$DB_NAME' on $DB_HOST:$DB_PORT..."
run_psql "$DATA_FILE"

unset PGPASSWORD

echo "Done. Schema recreated and test data loaded into '$DB_NAME'."
