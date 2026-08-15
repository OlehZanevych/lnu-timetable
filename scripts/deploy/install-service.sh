#!/usr/bin/env bash
#
# Configure this machine to run the application as a service and keep it up to date. One command,
# run once; running it again is how you change a credential or the port, not something to avoid.
#
# Usage (run as root, from anywhere):
#   sudo scripts/deploy/install-service.sh <db_username> <db_password> <jwt_secret>
#   sudo scripts/deploy/install-service.sh                  # prompts for each, without echo
#   sudo scripts/deploy/install-service.sh <db_username> <db_password> <jwt_secret> \
#       --mail-username timetable@lnu.edu.ua --mail-password '<app password>' \
#       --base-url https://timetable.lnu.edu.ua
#
# Options:
#   --port N              port to serve on (default 80)
#   --branch NAME         branch to track (default main)
#   --remote NAME         remote to track (default origin)
#   --interval MINUTES    how often to check for new commits (default 10)
#   --service-name NAME   systemd unit name (default lnu-timetable)
#   --skip-build          install everything, but keep the jar already in run/
#   --uninstall           stop and remove the unit, the cron entry and the logrotate config
#
# Outgoing mail (optional — it is what sends the registration and password-recovery links):
#   --mail-username ADDR  the mailbox to send from, e.g. timetable@lnu.edu.ua
#   --mail-password PASS  its password (or app password); goes together with --mail-username
#   --base-url URL        the public address this instance answers on, e.g.
#                         https://timetable.lnu.edu.ua — what the links in those messages are
#                         built from. Without it they point at http://localhost:8080.
#
# These three are named options rather than further positional arguments, so that mail can be
# configured, changed or left alone independently of the credentials. A run that names none of them
# does not touch whatever is already in the env file: mail is optional, the service starts without
# it, and self-service registration then reports "не вдалося надіслати листа" rather than failing to
# boot. Giving one of --mail-username / --mail-password without the other is an error, since a
# half-configured mailbox cannot authenticate.
#
# Passing the secrets as arguments puts them in your shell history and, for the moment the script
# runs, in "ps" output. Run it with no arguments and it prompts for each without echoing — including
# for the mail settings, which may be skipped by pressing Enter — which is the better habit on a
# machine that anyone else can log in to.
#
# What it installs
# ----------------
#   /etc/lnu-timetable/service.env         the secrets and the port, root-owned, mode 600
#   /etc/systemd/system/<name>.service     the unit: runs scripts/deploy/run-service.sh, restarts
#                                          on failure, starts at boot
#   root's crontab                         scripts/deploy/update.sh every N minutes
#   /etc/logrotate.d/<name>                weekly rotation for run/update.log
#
# Nothing secret is written into the repository. The credentials reach the JVM as environment
# variables (SPRING_R2DBC_USERNAME, SPRING_R2DBC_PASSWORD, APP_SECURITY_JWTSECRET, MAIL_USERNAME,
# MAIL_PASSWORD) rather than as command-line arguments, so they do not appear in "ps" for the life
# of the process.
#
# Why systemd and not a pidfile
# -----------------------------
# systemd restarts the process the moment it dies, rather than up to half a minute later; it starts
# it again after a reboot; and its log is journald's, which rotates itself. So there is no pidfile
# here and no health-check cron job: "systemctl status <name>" answers what a pidfile was for, and
# the only thing left for cron to do is watch git.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_DIR="$REPO_ROOT/run"

PORT=80
GIT_BRANCH=main
GIT_REMOTE=origin
INTERVAL=10
SERVICE_NAME=lnu-timetable
SKIP_BUILD=false
UNINSTALL=false
MAIL_USERNAME=""
MAIL_PASSWORD=""
BASE_URL=""
# "Did this run decide these keys?" — not "are they non-empty". A run that says nothing about mail
# must leave whatever is already in the env file alone, and that is a different question from
# whether the value happens to be blank.
MAIL_GIVEN=false
BASE_URL_GIVEN=false
POSITIONAL=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)         PORT="${2:?--port needs a value}"; shift 2 ;;
        --branch)       GIT_BRANCH="${2:?--branch needs a value}"; shift 2 ;;
        --remote)       GIT_REMOTE="${2:?--remote needs a value}"; shift 2 ;;
        --interval)     INTERVAL="${2:?--interval needs a value}"; shift 2 ;;
        --service-name) SERVICE_NAME="${2:?--service-name needs a value}"; shift 2 ;;
        --skip-build)   SKIP_BUILD=true; shift ;;
        --uninstall)    UNINSTALL=true; shift ;;
        --mail-username) MAIL_USERNAME="${2:?--mail-username needs a value}"; MAIL_GIVEN=true; shift 2 ;;
        --mail-password) MAIL_PASSWORD="${2:?--mail-password needs a value}"; MAIL_GIVEN=true; shift 2 ;;
        --base-url)      BASE_URL="${2:?--base-url needs a value}"; BASE_URL_GIVEN=true; shift 2 ;;
        -h|--help)      sed -n '2,52p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*)             echo "Error: unknown option '$1' (try --help)" >&2; exit 1 ;;
        *)              POSITIONAL+=("$1"); shift ;;
    esac
done

ENV_DIR=/etc/lnu-timetable
ENV_FILE="$ENV_DIR/service.env"
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
LOGROTATE_FILE="/etc/logrotate.d/$SERVICE_NAME"
CRON_MARK="# $SERVICE_NAME-update (installed by scripts/deploy/install-service.sh)"

say() { echo "==> $*"; }
die() { echo "Error: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "this needs root (it writes /etc/systemd/system and root's crontab). Re-run with sudo."

# ---- uninstall ---------------------------------------------------------------------------------
if [[ "$UNINSTALL" == true ]]; then
    say "stopping and disabling $SERVICE_NAME"
    systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$UNIT_FILE" "$LOGROTATE_FILE"
    systemctl daemon-reload
    say "removing the cron entry"
    (crontab -l 2>/dev/null || true) | grep -vF "$CRON_MARK" | crontab - || true
    cat <<EOF

Removed the unit, the cron entry and the logrotate config.

Left alone on purpose: $ENV_FILE (your credentials) and $RUN_DIR
(the deployed jar and the update log). Delete them by hand if you mean to.
EOF
    exit 0
fi

# ---- sanity ------------------------------------------------------------------------------------
[[ -x "$REPO_ROOT/scripts/build-app.sh" ]] || die "$REPO_ROOT does not look like the lnu-timetable repository (no scripts/build-app.sh)"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number, got '$PORT'"
# A mailbox needs both halves to authenticate, so half of one is always a mistake rather than a
# choice. Caught here, before anything is written, rather than as an SMTP authentication failure in
# the journal the first time somebody tries to register.
if [[ -n "$MAIL_USERNAME" && -z "$MAIL_PASSWORD" ]] || [[ -z "$MAIL_USERNAME" && -n "$MAIL_PASSWORD" ]]; then
    die "--mail-username and --mail-password go together; give both or neither"
fi
if [[ -n "$BASE_URL" && ! "$BASE_URL" =~ ^https?:// ]]; then
    die "--base-url must be a full URL including the scheme, e.g. https://timetable.lnu.edu.ua (got '$BASE_URL')"
fi
if [[ ! "$INTERVAL" =~ ^[0-9]+$ ]] || (( INTERVAL < 1 || INTERVAL > 59 )); then
    die "--interval must be 1-59 minutes, got '$INTERVAL'"
fi

for cmd in systemctl crontab curl git flock runuser; do
    command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' not found; install it first"
done

REPO_OWNER="$(stat -c '%U' "$REPO_ROOT")"

RUNUSER="$(command -v runuser || true)"
[[ -n "$RUNUSER" ]] || for c in /usr/sbin/runuser /sbin/runuser; do [[ -x "$c" ]] && RUNUSER="$c" && break; done
[[ -n "$RUNUSER" ]] || die "runuser not found on PATH or in /usr/sbin"
as_owner() { if [[ "$REPO_OWNER" == "root" ]]; then "$@"; else "$RUNUSER" -u "$REPO_OWNER" -- "$@"; fi; }

# ---- the toolchain, as the user who will actually build ----------------------------------------
# Before anything is written. A toolchain that only exists inside an interactive shell is the most
# likely reason this script fails, and finding out now costs nothing.
say "checking the build toolchain as $REPO_OWNER"
if ! TOOLCHAIN="$(as_owner "$SCRIPT_DIR/build-with-toolchain.sh" --check 2>&1)"; then
    printf '%s\n' "$TOOLCHAIN" >&2
    die "the build toolchain is not usable from a non-interactive shell (see above). Nothing has been changed."
fi
printf '%s\n' "$TOOLCHAIN" | sed 's/^/    /'
DETECTED_JAVA_HOME="$(printf '%s\n' "$TOOLCHAIN" | sed -n 's/.*JAVA_HOME=//p' | tail -n1)"
[[ "$DETECTED_JAVA_HOME" == "<unset>" ]] && DETECTED_JAVA_HOME=""

# ---- credentials --------------------------------------------------------------------------------
if (( ${#POSITIONAL[@]} == 3 )); then
    DB_USERNAME="${POSITIONAL[0]}"; DB_PASSWORD="${POSITIONAL[1]}"; JWT_SECRET="${POSITIONAL[2]}"
elif (( ${#POSITIONAL[@]} == 0 )); then
    read -r  -p 'Database username: ' DB_USERNAME
    read -rs -p 'Database password: ' DB_PASSWORD; echo
    read -rs -p 'JWT secret (>= 32 bytes): ' JWT_SECRET; echo
    # Mail is asked for last and may be skipped, because it is the one part of this the service
    # runs without. Skipping leaves whatever is already in the env file untouched rather than
    # clearing it, so re-running to change the port does not switch mail off.
    if [[ "$MAIL_GIVEN" == false ]]; then
        echo
        echo 'Outgoing mail sends the registration and password-recovery links. Press Enter to'
        echo 'skip it — the service runs without, and self-service registration then reports that'
        echo 'the message could not be sent.'
        read -r -p 'Mail username (e.g. timetable@lnu.edu.ua), or Enter to skip: ' MAIL_USERNAME
        if [[ -n "$MAIL_USERNAME" ]]; then
            read -rs -p 'Mail password: ' MAIL_PASSWORD; echo
            [[ -n "$MAIL_PASSWORD" ]] || die "the mail password may not be empty"
            MAIL_GIVEN=true
        fi
    fi
    if [[ "$BASE_URL_GIVEN" == false && "$MAIL_GIVEN" == true ]]; then
        read -r -p 'Public base URL for the links (e.g. https://timetable.lnu.edu.ua): ' BASE_URL
        if [[ -n "$BASE_URL" ]]; then
            [[ "$BASE_URL" =~ ^https?:// ]] || die "the base URL must include the scheme, e.g. https://timetable.lnu.edu.ua"
            BASE_URL_GIVEN=true
        fi
    fi
else
    die "expected either three arguments (db_username db_password jwt_secret) or none at all; got ${#POSITIONAL[@]}"
fi

[[ -n "$DB_USERNAME" && -n "$DB_PASSWORD" && -n "$JWT_SECRET" ]] || die "none of the three values may be empty"
# HS256 needs a key of at least 256 bits, and the application refuses to start without one. Catch
# it here rather than in a stack trace four steps later.
(( ${#JWT_SECRET} >= 32 )) || die "the JWT secret must be at least 32 characters (HS256 needs a 256-bit key); got ${#JWT_SECRET}"

if [[ "$JWT_SECRET" == "vFhvq86LU85HrhoVaf7i4P5GErwPZnAIe3rFF5c8-Ch0jmzce3DRwHMIn_pi3pjL" ]]; then
    die "that is the development secret checked into application-loc.properties. Generate a fresh one: openssl rand -base64 48"
fi

# ---- run/ ----------------------------------------------------------------------------------------
say "preparing $RUN_DIR"
mkdir -p "$RUN_DIR"
chown "$REPO_OWNER" "$RUN_DIR"

# ---- /etc/lnu-timetable/service.env ---------------------------------------------------------------
say "writing $ENV_FILE"
mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"
# This file is rewritten on every run, and it is also the documented place to put any other
# property the deployment overrides — SPRING_R2DBC_URL to point at a database that is not on
# localhost, for one. Rewriting it wholesale would delete those silently on the next credential
# change, so keep every line whose key this run does not own.
#
# Which keys those are is not a constant, and that is the whole of how mail can be left alone. The
# five below are rewritten every time; MAIL_USERNAME / MAIL_PASSWORD / APP_BASEURL join them only
# when this run was told about them, so a re-run to change the port or the JWT secret preserves a
# mailbox configured months ago instead of quietly switching self-service registration off.
OWNED_KEYS=(SPRING_R2DBC_USERNAME SPRING_R2DBC_PASSWORD APP_SECURITY_JWTSECRET SERVER_PORT JAVA_HOME)
[[ "$MAIL_GIVEN" == true ]] && OWNED_KEYS+=(MAIL_USERNAME MAIL_PASSWORD)
[[ "$BASE_URL_GIVEN" == true ]] && OWNED_KEYS+=(APP_BASEURL)
OWNED_RE="^($(IFS='|'; printf '%s' "${OWNED_KEYS[*]}"))="

PRESERVED=""
if [[ -f "$ENV_FILE" ]]; then
    PRESERVED="$(grep -vE '^[[:space:]]*(#|$)' "$ENV_FILE" \
        | grep -vE "$OWNED_RE" || true)"
    [[ -n "$PRESERVED" ]] && say "keeping $(printf '%s\n' "$PRESERVED" | wc -l | tr -d ' ') setting(s) already in $ENV_FILE"
fi

# Create it empty with the right mode first: writing the secrets into a file that is briefly
# world-readable and then chmod-ing it is a race, however short.
install -m 600 /dev/null "$ENV_FILE"
cat > "$ENV_FILE" <<EOF
# Written by scripts/deploy/install-service.sh. Read by the systemd unit, never by git.
# Relaxed binding maps these onto spring.r2dbc.username, spring.r2dbc.password,
# app.security.jwt-secret and server.port.
SPRING_R2DBC_USERNAME=$DB_USERNAME
SPRING_R2DBC_PASSWORD=$DB_PASSWORD
APP_SECURITY_JWTSECRET=$JWT_SECRET
SERVER_PORT=$PORT
EOF
if [[ -n "$DETECTED_JAVA_HOME" ]]; then
    cat >> "$ENV_FILE" <<EOF

# systemd starts the service with a PATH of its own, which will not include a JDK installed by
# sdkman or unpacked into a home directory. This is the one detected at install time.
JAVA_HOME=$DETECTED_JAVA_HOME
EOF
fi
if [[ "$MAIL_GIVEN" == true ]]; then
    cat >> "$ENV_FILE" <<EOF

# The mailbox the registration and password-recovery links are sent from. These two are read by
# the placeholders in application.properties (spring.mail.username=\${MAIL_USERNAME:}) rather than
# by relaxed binding, which is why they are not spelled SPRING_MAIL_*.
MAIL_USERNAME=$MAIL_USERNAME
MAIL_PASSWORD=$MAIL_PASSWORD
EOF
fi
if [[ "$BASE_URL_GIVEN" == true ]]; then
    cat >> "$ENV_FILE" <<EOF

# What the links inside those messages are built from (app.base-url). Its default is
# http://localhost:8080, which in somebody else's inbox is a link to their own machine.
APP_BASEURL=$BASE_URL
EOF
fi
if [[ -n "$PRESERVED" ]]; then
    cat >> "$ENV_FILE" <<EOF

# Kept from the previous version of this file. Anything this run did not set survives it; add
# further overrides here rather than to the unit.
$PRESERVED
EOF
fi
chmod 600 "$ENV_FILE"

# What the file ends up saying about mail, read back rather than inferred — the answer may have
# come from this run, from a previous one, or from a line somebody added by hand.
MAIL_CONFIGURED=false; grep -qE '^MAIL_USERNAME=.' "$ENV_FILE" && MAIL_CONFIGURED=true
BASE_URL_CONFIGURED=false; grep -qE '^APP_BASEURL=.' "$ENV_FILE" && BASE_URL_CONFIGURED=true

# ---- build and deploy ------------------------------------------------------------------------------
if [[ "$SKIP_BUILD" == true ]]; then
    [[ -f "$RUN_DIR/timetable.jar" ]] || die "--skip-build was given but $RUN_DIR/timetable.jar does not exist"
    say "keeping the jar already in run/"
else
    say "building and deploying the current checkout (this takes a few minutes)"
    TIMETABLE_SERVICE_NAME="$SERVICE_NAME" TIMETABLE_GIT_REMOTE="$GIT_REMOTE" TIMETABLE_GIT_BRANCH="$GIT_BRANCH" \
        "$SCRIPT_DIR/update.sh" --force --no-pull --no-restart \
        || die "the build failed; nothing has been started. Fix the build and re-run."
fi

# ---- the unit ----------------------------------------------------------------------------------------
say "writing $UNIT_FILE"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=LNU Timetable (GraphQL service and Angular client, one jar)
Documentation=file://$REPO_ROOT/scripts/deploy/README.md
After=network-online.target postgresql.service
Wants=network-online.target
# Ten failures inside five minutes is a broken build or a missing database, not a blip. Stop
# trying at that point so the journal says why, instead of scrolling one crash loop forever.
# These two belong in [Unit], not [Service] — systemd moved them, and the old placement is
# quietly ignored, which looks identical to working.
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=exec
# Root, because $PORT is a privileged port. Everything the service writes goes to journald;
# it does not write files outside the database.
User=root
WorkingDirectory=$REPO_ROOT
EnvironmentFile=$ENV_FILE
ExecStart=$REPO_ROOT/scripts/deploy/run-service.sh
# The JVM takes a moment to close its connection pool; give it time before SIGKILL.
TimeoutStopSec=60
Restart=always
RestartSec=10
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF

say "enabling and starting $SERVICE_NAME"
systemctl daemon-reload
systemctl enable --quiet "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ---- did it come up? ---------------------------------------------------------------------------------
say "waiting for it to serve on port $PORT"
HEALTHY=false
for _ in $(seq 1 40); do
    if ! systemctl is-active --quiet "$SERVICE_NAME"; then break; fi
    if curl -sS -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null; then HEALTHY=true; break; fi
    sleep 3
done

# ---- cron --------------------------------------------------------------------------------------------
say "installing the update job in root's crontab (every $INTERVAL minutes)"
# PATH is stated explicitly because cron's default for root is /usr/bin:/bin, which does not
# include /usr/sbin — where runuser lives. Without this the scheduled runs would all die on
# "runuser: command not found" while a hand-run of the same script worked perfectly.
CRON_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
CRON_LINE="*/$INTERVAL * * * * PATH=$CRON_PATH TIMETABLE_SERVICE_NAME=$SERVICE_NAME TIMETABLE_GIT_REMOTE=$GIT_REMOTE TIMETABLE_GIT_BRANCH=$GIT_BRANCH $SCRIPT_DIR/update.sh >> $RUN_DIR/update.log 2>&1 $CRON_MARK"
{ (crontab -l 2>/dev/null || true) | grep -vF "$CRON_MARK"; echo "$CRON_LINE"; } | crontab -

# ---- logrotate ---------------------------------------------------------------------------------------
say "writing $LOGROTATE_FILE"
cat > "$LOGROTATE_FILE" <<EOF
$RUN_DIR/update.log {
    weekly
    rotate 8
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su root root
}
EOF

# ---- report ------------------------------------------------------------------------------------------
echo
if [[ "$MAIL_CONFIGURED" == true ]]; then
    echo "Outgoing mail: $(sed -n 's/^MAIL_USERNAME=//p' "$ENV_FILE" | tail -n1)"
    if [[ "$BASE_URL_CONFIGURED" == true ]]; then
        echo "Links point at: $(sed -n 's/^APP_BASEURL=//p' "$ENV_FILE" | tail -n1)"
    else
        echo
        echo "Warning: mail is configured but APP_BASEURL is not, so every registration and"
        echo "         password-recovery link will point at http://localhost:8080 — a dead link in"
        echo "         anybody's inbox but your own. Re-run with --base-url https://<public address>."
    fi
else
    echo "Outgoing mail is not configured, so self-service registration and password recovery will"
    echo "report that the message could not be sent. Re-run with --mail-username, --mail-password"
    echo "and --base-url to enable them."
fi

echo
if [[ "$HEALTHY" == true ]]; then
    echo "Done. $SERVICE_NAME is running and answering on port $PORT."
else
    echo "Installed, but the service is NOT answering on port $PORT yet."
    echo "Look at:  journalctl -u $SERVICE_NAME -n 100 --no-pager"
    echo "The usual causes are a database it cannot reach, wrong credentials, or port $PORT already in use."
fi
cat <<EOF

  systemctl status $SERVICE_NAME        is it running, and since when
  journalctl -u $SERVICE_NAME -f        the application log (this replaces timetable.log)
  systemctl restart $SERVICE_NAME       restart it by hand
  tail -f $RUN_DIR/update.log
                                        what the ten-minute update job has been doing
  $SCRIPT_DIR/update.sh --force
                                        pull, rebuild and redeploy right now

It restarts itself if it dies, and starts again after a reboot. Every $INTERVAL minutes it checks
$GIT_REMOTE/$GIT_BRANCH; when that branch moves it pulls, rebuilds, redeploys and restarts, and if the new
build will not come up it puts the previous jar back.

Re-run this script to change a credential, the port or the interval — it overwrites in place. A
re-run that says nothing about mail leaves the mailbox settings exactly as they were.
EOF
