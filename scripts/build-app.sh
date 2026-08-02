#!/usr/bin/env bash
#
# Build the whole application into one deployable artifact: run scripts/build-ui.sh to put the
# Angular bundle in the service's static resources, then package the Spring Boot jar around it.
#
# The result — timetable/target/timetable-<version>.jar — serves the GraphQL API on /graphql and
# the Angular client on everything else, from a single process. It needs nothing but a JRE 25 and
# a reachable PostgreSQL.
#
# Usage (run from anywhere):
#   scripts/build-app.sh
#   scripts/build-app.sh --skip-tests    # skip SchemaBuildTest
#   scripts/build-app.sh --skip-ui       # package the frontend already in static/, do not rebuild it
#
# Requires JDK 25 and Maven (plus Node.js 20+ unless --skip-ui). If JAVA_HOME is unset, the script
# asks /usr/libexec/java_home for a JDK 25 on macOS.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_DIR="$REPO_ROOT/timetable"
STATIC_DIR="$SERVICE_DIR/src/main/resources/static"
REQUIRED_JAVA=25

SKIP_TESTS=false
SKIP_UI=false
for arg in "$@"; do
    case "$arg" in
        --skip-tests) SKIP_TESTS=true ;;
        --skip-ui)    SKIP_UI=true ;;
        -h|--help)    sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Error: unknown argument '$arg' (try --skip-tests, --skip-ui or --help)" >&2; exit 1 ;;
    esac
done

if ! command -v mvn >/dev/null 2>&1; then
    echo "Error: mvn not found. Install Maven first." >&2
    exit 1
fi

# ---- locate a JDK 25 --------------------------------------------------------------------------
if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then
    JAVA_HOME="$(/usr/libexec/java_home -v "$REQUIRED_JAVA" 2>/dev/null || true)"
    [[ -n "$JAVA_HOME" ]] && echo "==> JAVA_HOME resolved to $JAVA_HOME"
fi

JAVA_BIN="java"
[[ -n "${JAVA_HOME:-}" ]] && JAVA_BIN="$JAVA_HOME/bin/java"

if ! command -v "$JAVA_BIN" >/dev/null 2>&1 && [[ ! -x "$JAVA_BIN" ]]; then
    echo "Error: no java found at '$JAVA_BIN'. Set JAVA_HOME to a JDK $REQUIRED_JAVA install." >&2
    exit 1
fi

# Grep the whole of "java -version" for the version token rather than reading the first line:
# with JAVA_TOOL_OPTIONS or _JAVA_OPTIONS set, the JVM prints a "Picked up ..." line ahead of it.
JAVA_MAJOR="$("$JAVA_BIN" -version 2>&1 | grep -Eo 'version "[0-9]+' | head -n1 | grep -Eo '[0-9]+' || true)"
if [[ ! "$JAVA_MAJOR" =~ ^[0-9]+$ ]] || (( JAVA_MAJOR < REQUIRED_JAVA )); then
    echo "Error: this project targets Java $REQUIRED_JAVA, but '$JAVA_BIN' is Java ${JAVA_MAJOR:-unknown}." >&2
    echo "       Set JAVA_HOME to a JDK $REQUIRED_JAVA install, e.g." >&2
    echo "       export JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-$REQUIRED_JAVA.jdk/Contents/Home" >&2
    exit 1
fi

# ---- 1. frontend ------------------------------------------------------------------------------
if [[ "$SKIP_UI" == true ]]; then
    if [[ ! -f "$STATIC_DIR/index.html" ]]; then
        echo "Error: --skip-ui was given but $STATIC_DIR/index.html does not exist." >&2
        echo "       Run scripts/build-ui.sh at least once first." >&2
        exit 1
    fi
    echo "==> [1/2] skipping the frontend build; packaging what is already in static/"
else
    echo "==> [1/2] building the frontend"
    "$SCRIPT_DIR/build-ui.sh"
fi

# ---- 2. service -------------------------------------------------------------------------------
echo
echo "==> [2/2] packaging the service"
cd "$SERVICE_DIR"

MVN_ARGS=(clean package)
[[ "$SKIP_TESTS" == true ]] && MVN_ARGS+=(-DskipTests)

if [[ -n "${JAVA_HOME:-}" ]]; then
    JAVA_HOME="$JAVA_HOME" mvn "${MVN_ARGS[@]}"
else
    mvn "${MVN_ARGS[@]}"
fi

JAR="$(find "$SERVICE_DIR/target" -maxdepth 1 -name '*.jar' ! -name '*.original' -print 2>/dev/null | head -n1)"
if [[ -z "$JAR" ]]; then
    echo "Error: no jar found in $SERVICE_DIR/target" >&2
    exit 1
fi

# Sanity check: the frontend really is inside the artifact, not merely next to it.
if ! unzip -l "$JAR" 2>/dev/null | grep -q 'BOOT-INF/classes/static/index.html'; then
    echo "Error: $JAR does not contain BOOT-INF/classes/static/index.html — the frontend was not packaged." >&2
    exit 1
fi

JAR_NAME="$(basename "$JAR")"
JAR_SIZE="$(du -h "$JAR" | cut -f1 | tr -d ' ')"

cat <<EOF

Done. $JAR_NAME ($JAR_SIZE)
      $JAR

Run it — GraphQL on /graphql, the client on everything else:

  java -jar timetable/target/$JAR_NAME --app.apollo-sandbox.enabled=false

  --app.apollo-sandbox.enabled=false is what switches "/" from the Apollo Sandbox redirect to the
  Angular client. It is needed because application-loc.properties, which is baked into the jar and
  active by default, sets the property to true for local development.

Point it at the deployment database by overriding the same properties on the command line:

  java -jar timetable/target/$JAR_NAME \\
      --app.apollo-sandbox.enabled=false \\
      --spring.r2dbc.url=r2dbc:postgresql://HOST:5432/lnu-timetable \\
      --spring.r2dbc.username=USER \\
      --spring.r2dbc.password=PASSWORD \\
      --app.security.jwt-secret=<a fresh secret of at least 32 bytes> \\
      --server.port=8080

The schema is not created on startup: run schema.sql and data.sql against that database once
(timetable/scripts/reset_db.sh does both against the local one).
EOF
