#!/usr/bin/env bash
#
# Bring the running deployment up to date with the remote branch: fetch, and if there is anything
# new, pull it, rebuild, deploy the jar and restart the service. Does nothing at all — and says so
# in one line — when the branch has not moved, which is the normal case for most of its runs.
#
# scripts/deploy/install-service.sh installs this in root's crontab, every ten minutes.
#
# Usage (run from anywhere):
#   scripts/deploy/update.sh                # the cron entry point: update only if the branch moved
#   scripts/deploy/update.sh --force        # rebuild and redeploy even if it did not
#   scripts/deploy/update.sh --no-pull      # rebuild and redeploy the current checkout, no git
#   scripts/deploy/update.sh --no-restart   # build and deploy the jar, but leave the service alone
#   scripts/deploy/update.sh --skip-tests   # pass --skip-tests through to build-app.sh
#
# Two things it will not do. It never rebases or merges: the pull is --ff-only, so a working tree
# that has diverged from the remote stops the update with an explanation instead of resolving it.
# And it never leaves the service down to save a broken build — see "the deployed jar" below.
#
# The deployed jar
# ----------------
# run/timetable.jar is what the service runs, and it is only ever replaced by a jar that has been
# built and verified in full. The previous one is kept as run/timetable.jar.prev. If the new build
# fails, the old jar is still in place and the service keeps running it; if the new build succeeds
# but the service does not come back up healthy, this script puts the old jar back and restarts.
# So a bad commit on main costs a restart, not an outage.
#
# Privileges
# ----------
# Run as root (that is how cron runs it), because restarting the service needs root. The git and
# Maven/npm work is done as the user who owns the working tree, so that a build never leaves
# root-owned files in target/, node_modules/ or dist/ for that user to trip over afterwards.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_DIR="$REPO_ROOT/run"
DEPLOYED_JAR="$RUN_DIR/timetable.jar"
PREVIOUS_JAR="$RUN_DIR/timetable.jar.prev"
LOCK_FILE="$RUN_DIR/update.lock"

SERVICE_NAME="${TIMETABLE_SERVICE_NAME:-lnu-timetable}"
ENV_FILE="/etc/lnu-timetable/service.env"
GIT_REMOTE="${TIMETABLE_GIT_REMOTE:-origin}"
GIT_BRANCH="${TIMETABLE_GIT_BRANCH:-main}"
HEALTH_TIMEOUT=120

FORCE=false
NO_PULL=false
NO_RESTART=false
BUILD_ARGS=()

for arg in "$@"; do
    case "$arg" in
        --force)      FORCE=true ;;
        --no-pull)    NO_PULL=true ;;
        --no-restart) NO_RESTART=true ;;
        --skip-tests) BUILD_ARGS+=(--skip-tests) ;;
        -h|--help)    sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Error: unknown argument '$arg' (try --force, --no-pull, --skip-tests or --help)" >&2; exit 1 ;;
    esac
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { log "ERROR: $*"; exit 1; }

# ---- one at a time ----------------------------------------------------------------------------
# A build can outlast the ten-minute cron interval. flock makes the next run stand down rather
# than start a second Maven against the same tree.
mkdir -p "$RUN_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "another update is still running; skipping this run"
    exit 0
fi

# ---- who does the unprivileged work -----------------------------------------------------------
REPO_OWNER="$(stat -c '%U' "$REPO_ROOT")"
# runuser lives in /usr/sbin, which is not on cron's PATH for root on Ubuntu. Resolve it once,
# by absolute path if need be, rather than discovering at 3am that every scheduled run died on
# "runuser: command not found".
RUNUSER="$(command -v runuser || true)"
[[ -n "$RUNUSER" ]] || for c in /usr/sbin/runuser /sbin/runuser; do [[ -x "$c" ]] && RUNUSER="$c" && break; done

if [[ "$(id -u)" -eq 0 && "$REPO_OWNER" != "root" ]]; then
    [[ -n "$RUNUSER" ]] || die "runuser not found (looked on PATH and in /usr/sbin), and this is running as root against a tree owned by $REPO_OWNER"
    as_owner() { "$RUNUSER" -u "$REPO_OWNER" -- "$@"; }
else
    as_owner() { "$@"; }
fi

# Git refuses to operate on a tree owned by somebody else ("detected dubious ownership"). That is
# not a problem while as_owner is doing the git, but --no-pull runs and manual invocations can
# still land here as root, so make it explicit rather than mysterious.
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$REPO_ROOT" \
    || git config --global --add safe.directory "$REPO_ROOT" 2>/dev/null || true

cd "$REPO_ROOT"

# ---- 1. is there anything new? ----------------------------------------------------------------
NEW_COMMITS=false
if [[ "$NO_PULL" == false ]]; then
    as_owner git fetch --quiet "$GIT_REMOTE" "$GIT_BRANCH" || die "git fetch $GIT_REMOTE $GIT_BRANCH failed"

    LOCAL_REV="$(as_owner git rev-parse HEAD)"
    REMOTE_REV="$(as_owner git rev-parse FETCH_HEAD)"

    # "different" is not the same as "behind": a tree carrying a local commit that was never
    # pushed also differs from the remote, and rebuilding for that on every ten-minute tick would
    # be a rebuild loop. Only a FETCH_HEAD that is not already an ancestor of HEAD is new work.
    if [[ "$LOCAL_REV" != "$REMOTE_REV" ]] && ! as_owner git merge-base --is-ancestor FETCH_HEAD HEAD; then
        NEW_COMMITS=true
        COUNT="$(as_owner git rev-list --count HEAD..FETCH_HEAD 2>/dev/null || echo '?')"
        log "$GIT_REMOTE/$GIT_BRANCH moved: $COUNT new commit(s), ${LOCAL_REV:0:8} -> ${REMOTE_REV:0:8}"
    fi
fi

if [[ "$NEW_COMMITS" == false && "$FORCE" == false ]]; then
    log "no new commits on $GIT_REMOTE/$GIT_BRANCH; nothing to do"
    exit 0
fi

# ---- 2. pull ----------------------------------------------------------------------------------
if [[ "$NEW_COMMITS" == true ]]; then
    if ! as_owner git pull --ff-only "$GIT_REMOTE" "$GIT_BRANCH"; then
        die "git pull --ff-only failed. The working tree has diverged from $GIT_REMOTE/$GIT_BRANCH, or has local changes in the way. Resolve it by hand; the service keeps running the jar it already has."
    fi
    log "pulled to $(as_owner git rev-parse --short HEAD) — $(as_owner git log -1 --pretty=%s)"
fi

# ---- 3. build ---------------------------------------------------------------------------------
# Not build-app.sh directly: the toolchain wrapper first puts nvm/sdkman on PATH, because none of
# sudo, runuser or cron reads the shell startup files that normally do that.
log "building (scripts/deploy/build-with-toolchain.sh ${BUILD_ARGS[*]:-})"
if ! as_owner "$SCRIPT_DIR/build-with-toolchain.sh" "${BUILD_ARGS[@]}"; then
    die "the build failed. The service is untouched and still running the previously deployed jar."
fi

BUILT_JAR="$(find "$REPO_ROOT/timetable/target" -maxdepth 1 -name '*.jar' ! -name '*.original' -print 2>/dev/null | head -n1)"
[[ -n "$BUILT_JAR" ]] || die "the build reported success but no jar is in timetable/target"

# ---- 4. deploy --------------------------------------------------------------------------------
[[ -f "$DEPLOYED_JAR" ]] && cp -p "$DEPLOYED_JAR" "$PREVIOUS_JAR"
# Copy beside the target and rename, so that the service never sees a half-written jar: rename
# within a filesystem is atomic, plain cp over a running file's path is not.
cp -p "$BUILT_JAR" "$DEPLOYED_JAR.new"
mv -f "$DEPLOYED_JAR.new" "$DEPLOYED_JAR"
log "deployed $(basename "$BUILT_JAR") ($(du -h "$DEPLOYED_JAR" | cut -f1 | tr -d ' ')) to run/timetable.jar"

# ---- 5. restart, and check it actually came back ----------------------------------------------
restart_and_wait() {
    systemctl restart "$SERVICE_NAME" || return 1

    local port deadline
    port=80
    [[ -r "$ENV_FILE" ]] && port="$(sed -n 's/^SERVER_PORT=//p' "$ENV_FILE" | tail -n1)"
    [[ -n "$port" ]] || port=80

    deadline=$(( SECONDS + HEALTH_TIMEOUT ))
    while (( SECONDS < deadline )); do
        systemctl is-active --quiet "$SERVICE_NAME" || return 1
        # Any HTTP response at all means the connector is up and serving; the status code does not
        # matter, because "/" redirects and /graphql rejects a GET.
        if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null \
           || curl -sS -o /dev/null --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null; then
            return 0
        fi
        sleep 3
    done
    return 1
}

# install-service.sh builds through this script before the unit exists, so there is a case where
# deploying the jar is the whole job.
if [[ "$NO_RESTART" == true ]]; then
    log "jar deployed; leaving $SERVICE_NAME alone as asked"
    exit 0
fi

log "restarting $SERVICE_NAME"
if restart_and_wait; then
    log "update complete; $SERVICE_NAME is serving"
    exit 0
fi

# ---- 6. roll back -----------------------------------------------------------------------------
log "ERROR: $SERVICE_NAME did not come back up within ${HEALTH_TIMEOUT}s of the restart"
if [[ -f "$PREVIOUS_JAR" ]]; then
    log "rolling back to the previous jar"
    cp -p "$PREVIOUS_JAR" "$DEPLOYED_JAR"
    if restart_and_wait; then
        log "rolled back; $SERVICE_NAME is serving the previous build. The new commits are in the working tree but are NOT deployed — investigate with: journalctl -u $SERVICE_NAME -n 200"
        exit 1
    fi
    log "ERROR: the rollback did not come up either. This is not a bad build; check the database and the port."
else
    log "ERROR: no previous jar to roll back to"
fi
log "diagnose with: journalctl -u $SERVICE_NAME -n 200 --no-pager"
exit 1
