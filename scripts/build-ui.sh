#!/usr/bin/env bash
#
# Build the Angular client (timetable-ui) and copy the result into the service's static
# resources, so that "mvn package" in timetable/ produces one jar carrying both halves of
# the system.
#
# The bundle lands in timetable/src/main/resources/static/, which is where Spring Boot serves
# classpath static resources from with no extra configuration. FrontendController then answers
# the client-side routes (/faculty/3 and the like) with index.html; see its javadoc.
#
# The static/ directory is build output, not source: it is listed in timetable/.gitignore and
# this script wipes it before every copy, so a renamed or deleted asset never lingers.
#
# Usage (run from anywhere):
#   scripts/build-ui.sh
#   scripts/build-ui.sh --clean     # reinstall node_modules from package-lock.json first
#
# Requires Node.js 20+ and npm.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UI_DIR="$REPO_ROOT/timetable-ui"
SERVICE_DIR="$REPO_ROOT/timetable"
STATIC_DIR="$SERVICE_DIR/src/main/resources/static"

CLEAN_INSTALL=false
for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN_INSTALL=true ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Error: unknown argument '$arg' (try --clean or --help)" >&2; exit 1 ;;
    esac
done

if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm not found. Install Node.js 20+ first." >&2
    exit 1
fi

if [[ ! -f "$UI_DIR/package.json" ]]; then
    echo "Error: $UI_DIR/package.json not found — is this the lnu-timetable repository?" >&2
    exit 1
fi

cd "$UI_DIR"

if [[ "$CLEAN_INSTALL" == true ]]; then
    echo "==> npm ci (clean install from package-lock.json)"
    npm ci
elif [[ ! -d node_modules ]]; then
    echo "==> node_modules missing; npm ci"
    npm ci
else
    echo "==> node_modules present; skipping install (pass --clean to reinstall)"
fi

echo "==> npm run build (ng build, production configuration)"
npm run build

# @angular/build:application writes the browser bundle to dist/<project>/browser. Locate it by
# looking for the index.html rather than trusting that path, so a change in angular.json's
# outputPath does not silently produce an empty copy.
DIST_ROOT="$UI_DIR/dist"
BROWSER_DIR="$DIST_ROOT/timetable-ui/browser"

if [[ ! -f "$BROWSER_DIR/index.html" ]]; then
    BROWSER_DIR="$(find "$DIST_ROOT" -maxdepth 3 -name index.html -type f -print0 2>/dev/null \
        | xargs -0 -n1 dirname 2>/dev/null | head -n1 || true)"
fi

if [[ -z "$BROWSER_DIR" || ! -f "$BROWSER_DIR/index.html" ]]; then
    echo "Error: no index.html found under $DIST_ROOT — did the Angular build produce output?" >&2
    exit 1
fi

echo "==> copying $(basename "$(dirname "$BROWSER_DIR")")/$(basename "$BROWSER_DIR") -> timetable/src/main/resources/static"
rm -rf "$STATIC_DIR"
mkdir -p "$STATIC_DIR"
cp -R "$BROWSER_DIR"/. "$STATIC_DIR"/

FILE_COUNT="$(find "$STATIC_DIR" -type f | wc -l | tr -d ' ')"
TOTAL_SIZE="$(du -sh "$STATIC_DIR" | cut -f1 | tr -d ' ')"

echo "Done. $FILE_COUNT files ($TOTAL_SIZE) in $STATIC_DIR"
echo "      Package the jar with scripts/build-app.sh."
