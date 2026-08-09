#!/usr/bin/env bash
#
# Put the build toolchain on PATH, then run scripts/build-app.sh. Every argument is passed
# straight through to it.
#
# This exists because of where the build actually runs from. When you build by hand, npm, mvn and
# java are on your PATH because your shell startup files put them there — nvm in particular works
# by defining a shell function in ~/.bashrc, and ~/.bashrc returns immediately for a
# non-interactive shell. An automatic deployment reaches the build through sudo, then runuser, then
# (later) cron, and none of those three is an interactive login shell. So the toolchain that is
# obviously present when you type "npm -v" is obviously absent here, and the build fails with
# "npm not found" on a machine where npm plainly exists.
#
# Usage (run from anywhere):
#   scripts/deploy/build-with-toolchain.sh                # resolve the toolchain, then build
#   scripts/deploy/build-with-toolchain.sh --skip-tests   # ...passing this to build-app.sh
#   scripts/deploy/build-with-toolchain.sh --check        # resolve and report; do not build
#
# Where it looks, in order. Each step only fills in what the previous ones did not provide:
#
#   1. /etc/lnu-timetable/build.env, if it exists. A plain shell file, sourced. Anything you put
#      here wins — set PATH, JAVA_HOME, or source something exotic. This is the escape hatch for a
#      toolchain the two steps below cannot find.
#   2. nvm ($NVM_DIR, or ~/.nvm): sourced, then "nvm use default". This is what makes a
#      node installed with nvm reachable from cron.
#   3. sdkman ($SDKMAN_DIR, or ~/.sdkman): sourced. A common way to have JDK 25 and Maven
#      on Ubuntu, and it has exactly the same non-interactive-shell problem.
#
# If npm, node, mvn or java is still missing after all that, it says which, and where it looked,
# rather than letting build-app.sh fail with a message that sounds like the tool is not installed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_ENV_FILE="${TIMETABLE_BUILD_ENV:-/etc/lnu-timetable/build.env}"

CHECK_ONLY=false
BUILD_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --check)   CHECK_ONLY=true ;;
        -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)         BUILD_ARGS+=("$arg") ;;
    esac
done

# runuser and cron can both leave HOME pointing at root's home, or unset. nvm and sdkman live under
# the *building* user's home, so take it from the passwd entry rather than from the environment —
# that is right in every case, including the ordinary one.
HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
[[ -n "$HOME" && -d "$HOME" ]] || { echo "Error: no home directory for uid $(id -u)" >&2; exit 1; }
export HOME

SOURCES=()

# ---- 1. the explicit escape hatch --------------------------------------------------------------
if [[ -r "$BUILD_ENV_FILE" ]]; then
    set +u
    # shellcheck source=/dev/null  # a deployment-specific file, written by install-service.sh
    source "$BUILD_ENV_FILE"
    set -u
    SOURCES+=("$BUILD_ENV_FILE")
fi

# ---- 2. nvm ------------------------------------------------------------------------------------
# nvm.sh is written for an interactive shell and reads unset variables freely, so "set -u" has to
# come off around it or it aborts on something harmless.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if ! command -v npm >/dev/null 2>&1 && [[ -s "$NVM_DIR/nvm.sh" ]]; then
    set +u
    # shellcheck disable=SC1091  # nvm's own script, not ours
    source "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1 || true
    # "default" is the alias nvm sets when you install a version; "node" is the newest installed,
    # and is the sane fallback for a machine where nobody ever ran "nvm alias default".
    nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
    set -u
    command -v npm >/dev/null 2>&1 && SOURCES+=("nvm ($NVM_DIR)")
fi

# ---- 3. sdkman ---------------------------------------------------------------------------------
export SDKMAN_DIR="${SDKMAN_DIR:-$HOME/.sdkman}"
if { ! command -v mvn >/dev/null 2>&1 || ! command -v java >/dev/null 2>&1; } \
   && [[ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ]]; then
    set +u
    # shellcheck disable=SC1091  # sdkman's own script, not ours
    source "$SDKMAN_DIR/bin/sdkman-init.sh" >/dev/null 2>&1 || true
    set -u
    SOURCES+=("sdkman ($SDKMAN_DIR)")
fi

# ---- did that work? ----------------------------------------------------------------------------
MISSING=()
for cmd in node npm mvn java; do
    command -v "$cmd" >/dev/null 2>&1 || MISSING+=("$cmd")
done

if (( ${#MISSING[@]} > 0 )); then
    {
        echo "Error: the build toolchain is incomplete for user '$(id -un)': ${MISSING[*]} not found."
        echo
        echo "This is about *where* the build runs, not whether the tools are installed. A"
        echo "deployment builds through sudo/runuser/cron, none of which reads the shell startup"
        echo "files that put nvm or sdkman on your PATH. Running '${MISSING[0]} -v' in your own"
        echo "terminal proving it exists is exactly the situation this message is for."
        echo
        echo "Looked in: HOME=$HOME"
        echo "           $BUILD_ENV_FILE $( [[ -r "$BUILD_ENV_FILE" ]] && echo '(read)' || echo '(absent)')"
        echo "           \$NVM_DIR=$NVM_DIR $( [[ -s "$NVM_DIR/nvm.sh" ]] && echo '(found nvm.sh)' || echo '(no nvm.sh)')"
        echo "           \$SDKMAN_DIR=$SDKMAN_DIR $( [[ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ]] && echo '(found)' || echo '(absent)')"
        echo
        echo "Fix it by naming the paths explicitly, as that user:"
        echo
        echo "  sudo mkdir -p $(dirname "$BUILD_ENV_FILE")"
        echo "  sudo tee $BUILD_ENV_FILE >/dev/null <<'ENV'"
        echo "  PATH=/path/to/node/bin:/path/to/maven/bin:\$PATH"
        echo "  JAVA_HOME=/path/to/jdk-25"
        echo "  ENV"
        echo
        echo "To find those paths, run in your normal shell:  command -v node mvn java; echo \$JAVA_HOME"
    } >&2
    exit 1
fi

JAVA_MAJOR="$(java -version 2>&1 | grep -Eo 'version "[0-9]+' | head -n1 | grep -Eo '[0-9]+' || true)"
NODE_MAJOR="$(node -v 2>/dev/null | grep -Eo '[0-9]+' | head -n1 || true)"

# build-app.sh asks /usr/libexec/java_home when JAVA_HOME is unset, which exists only on macOS. On
# Linux, derive it from the java on PATH — both so Maven gets an explicit toolchain, and so that
# --check can hand install-service.sh a JAVA_HOME to put in the unit's environment. systemd starts
# the service with a minimal PATH of its own, so a JDK that only sdkman knows about would be just
# as invisible at run time as it is at build time.
if [[ -z "${JAVA_HOME:-}" ]]; then
    JAVA_REAL="$(readlink -f "$(command -v java)" 2>/dev/null || true)"
    [[ -n "$JAVA_REAL" && "$JAVA_REAL" == */bin/java ]] && export JAVA_HOME="${JAVA_REAL%/bin/java}"
fi

if [[ "$CHECK_ONLY" == true ]]; then
    echo "toolchain for $(id -un):"
    echo "  node  $(node -v)  ($(command -v node))"
    echo "  npm   $(npm -v)   ($(command -v npm))"
    echo "  mvn   $(mvn -v 2>/dev/null | head -n1 | cut -d' ' -f1-3)  ($(command -v mvn))"
    echo "  java  ${JAVA_MAJOR:-unknown}  ($(command -v java))  JAVA_HOME=${JAVA_HOME:-<unset>}"
    (( ${#SOURCES[@]} > 0 )) && echo "  via   ${SOURCES[*]}"
    [[ "${NODE_MAJOR:-0}" -ge 20 ]] || { echo "  WARNING: build-ui.sh needs Node 20+" >&2; exit 1; }
    [[ "${JAVA_MAJOR:-0}" -ge 25 ]] || { echo "  WARNING: build-app.sh needs JDK 25" >&2; exit 1; }
    exit 0
fi

exec "$REPO_ROOT/scripts/build-app.sh" "${BUILD_ARGS[@]}"
