#!/usr/bin/env bash
#
# Run the packaged application in the foreground. This is what the systemd unit executes; it is
# not meant to be run by hand except for debugging a startup failure.
#
# It runs run/timetable.jar — the *deployed* artifact — and deliberately not the jar in
# timetable/target/. scripts/build-app.sh starts with "mvn clean", which deletes target/ before it
# rebuilds; if the service pointed there, a build that failed halfway would leave the unit with no
# jar to restart from. scripts/deploy/update.sh copies a jar into run/ only after it has been
# built and verified, so the file this script runs is always a complete one.
#
# Usage (run from anywhere):
#   scripts/deploy/run-service.sh                       # the deployed jar, on $SERVER_PORT or 80
#   scripts/deploy/run-service.sh --server.port=8081    # extra arguments are passed to the jar
#
# Environment:
#   SERVER_PORT   port to listen on (default 80)
#   JAVA_HOME     a JRE/JDK 25 install; otherwise "java" from PATH is used
#   JAVA_OPTS     extra JVM options, e.g. "-Xmx1g"
#
# The credentials are NOT set here. systemd supplies them from /etc/lnu-timetable/service.env as
# SPRING_R2DBC_USERNAME, SPRING_R2DBC_PASSWORD and APP_SECURITY_JWTSECRET, so that they never
# appear in a command line and never become visible in "ps".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
JAR="$REPO_ROOT/run/timetable.jar"
REQUIRED_JAVA=25

for arg in "$@"; do
    case "$arg" in
        -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    esac
done

if [[ ! -f "$JAR" ]]; then
    echo "Error: $JAR does not exist." >&2
    echo "       Nothing has been deployed yet — run scripts/deploy/install-service.sh," >&2
    echo "       or scripts/deploy/update.sh --force to build and deploy the current checkout." >&2
    exit 1
fi

JAVA_BIN="java"
[[ -n "${JAVA_HOME:-}" ]] && JAVA_BIN="$JAVA_HOME/bin/java"

if ! command -v "$JAVA_BIN" >/dev/null 2>&1 && [[ ! -x "$JAVA_BIN" ]]; then
    echo "Error: no java found at '$JAVA_BIN'. Set JAVA_HOME to a JRE $REQUIRED_JAVA install." >&2
    exit 1
fi

# Same version probe as build-app.sh: grep the whole of "java -version" rather than its first
# line, because JAVA_TOOL_OPTIONS makes the JVM print a "Picked up ..." line ahead of it.
JAVA_MAJOR="$("$JAVA_BIN" -version 2>&1 | grep -Eo 'version "[0-9]+' | head -n1 | grep -Eo '[0-9]+' || true)"
if [[ ! "$JAVA_MAJOR" =~ ^[0-9]+$ ]] || (( JAVA_MAJOR < REQUIRED_JAVA )); then
    echo "Error: this application needs Java $REQUIRED_JAVA, but '$JAVA_BIN' is Java ${JAVA_MAJOR:-unknown}." >&2
    exit 1
fi

# --spring.profiles.active= (empty) drops application-loc.properties, which travels inside the jar
# and is active by default. That file carries the development database password, the development
# JWT secret, and DEBUG logging for io.r2dbc.postgresql.PARAM — which logs every bound parameter,
# including the ones passed to login. Dropping it is what makes this a deployment rather than a
# developer's laptop. What it does not drop: spring.r2dbc.url and the Flyway settings, which live
# in application.properties and stay in force.
#
# --app.apollo-sandbox.enabled=false is then redundant (FrontendController is @ConditionalOnBoolean
# Property(..., matchIfMissing = true), so an absent property already serves the Angular client)
# but it is cheap and it states the intent where a reader will look for it.
# JAVA_OPTS is a string of options, so it has to be split on whitespace to become several
# arguments — but an unquoted expansion would glob as well as split. Reading it into an array does
# the one without the other.
JVM_ARGS=()
if [[ -n "${JAVA_OPTS:-}" ]]; then
    read -r -a JVM_ARGS <<< "$JAVA_OPTS"
fi

exec "$JAVA_BIN" "${JVM_ARGS[@]}" -jar "$JAR" \
    --spring.profiles.active= \
    --app.apollo-sandbox.enabled=false \
    --server.port="${SERVER_PORT:-80}" \
    "$@"
