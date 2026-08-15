# Deployment (`scripts/deploy`)

Runs the packaged jar as a service on a Linux host, keeps it running, and keeps it current with a
branch. Three scripts and one command:

```bash
sudo scripts/deploy/install-service.sh          # prompts for the credentials, without echo
```

That builds the current checkout, installs a systemd unit, starts it, and adds a cron job that
watches the branch. Everything below is what it did and why.

Everything it asks for can also be given on the command line, which is what a provisioning script
wants:

```bash
sudo scripts/deploy/install-service.sh <db_username> <db_password> <jwt_secret> \
    --mail-username timetable@lnu.edu.ua \
    --mail-password '<app password>' \
    --base-url https://timetable.lnu.edu.ua
```

The last three are optional and are what turns on [self-service registration and password
recovery](../../timetable/README.md#self-service-registration-and-password-recovery); the service
runs perfectly well without them and simply cannot send a link.

| | |
|---|---|
| `install-service.sh` | the one-shot configurator. Writes the credentials, the unit, the cron entry and the logrotate config; idempotent, so re-running it is how you change any of them |
| `update.sh` | fetch → pull → build → deploy → restart, if and only if the branch moved. Cron runs this every ten minutes |
| `run-service.sh` | what the unit executes. Resolves a JRE, checks it is 25, and `exec`s the jar |
| `build-with-toolchain.sh` | puts nvm/sdkman on `PATH` before calling `build-app.sh` — see *The toolchain problem* |

## What gets installed where

| Path | What |
|---|---|
| `/etc/lnu-timetable/service.env` | the database credentials, the JWT secret, the port, the detected `JAVA_HOME`, and — when they were given — the mailbox credentials and the public base URL. Root-owned, mode 600 |
| `/etc/lnu-timetable/build.env` | optional, and yours to write: sourced before every build when the toolchain cannot be found automatically |
| `/etc/systemd/system/lnu-timetable.service` | the unit |
| root's crontab | `update.sh`, every ten minutes |
| `/etc/logrotate.d/lnu-timetable` | weekly rotation of `run/update.log` |
| `run/timetable.jar` | the deployed artifact — see *The deployed jar* below |
| `run/update.log` | what the update job has been doing |

`run/` is git-ignored. Nothing secret is written inside the repository, which matters here more than
usual: the update job runs `git pull` against this working tree every ten minutes.

## Why systemd rather than a pidfile and a cron health check

A pidfile plus a periodic "is that pid still alive, and if not start it again" job is the shape this
started as. systemd does the same thing better in three ways, and the difference is not stylistic:

- **It restarts on the process dying, not on the next tick.** A polling check restarts a crashed
  service an average of half its interval later. `Restart=always` does it in about ten seconds.
- **It survives a reboot.** `WantedBy=multi-user.target` is one line; the cron equivalent is an
  `@reboot` entry that has to duplicate the whole start sequence.
- **Its log rotates itself.** `nohup ... > timetable.log` grows without limit until a disk fills.
  journald has quotas and compaction already.

So there is no pidfile and no health-check job. `systemctl status lnu-timetable` answers what the
pidfile was for, and `journalctl -u lnu-timetable -f` replaces `tail -f timetable.log`. Cron's only
remaining job is watching git.

## The deployed jar

`run/timetable.jar` is a copy, and the unit runs the copy rather than
`timetable/target/timetable-*.jar` directly. That indirection buys two things.

`scripts/build-app.sh` begins with `mvn clean`, which deletes `target/` before it rebuilds. If the
unit pointed there, a build that failed halfway would leave the service with no file to restart
from — the running JVM would carry on happily, and the next restart, whenever it came, would fail.
Copying only a finished, verified jar into `run/` means the file the unit points at is always a
complete one.

And it gives the update job something to roll back to. `update.sh` keeps the outgoing jar as
`run/timetable.jar.prev`, so there are three outcomes rather than two:

| What happens | What the service ends up running |
|---|---|
| the build fails | the old jar, still running, never restarted |
| the build succeeds and the new jar comes up | the new jar |
| the build succeeds but the new jar will not come up | the old jar, restored and restarted |

A bad commit on `main` therefore costs a restart, not an outage. The third row is the one worth
having: a jar that packages cleanly and then dies on a missing migration or a schema mismatch is
exactly the failure an automatic deployment invites.

## What `update.sh` will not do

It pulls with `--ff-only`. A working tree that has diverged from the remote, or that has local
changes in the way, stops the update with an explanation in `run/update.log` and leaves the running
service alone. Nothing here rebases, merges or resets: an unattended job resolving a conflict
against a production checkout is a worse outcome than a deployment that pauses until somebody looks
at it.

It also distinguishes *behind* from *different*. A tree carrying a local commit that was never
pushed differs from the remote, and rebuilding on that basis would rebuild every ten minutes
forever; only a fetched head that is not already an ancestor of `HEAD` counts as new work.

Two runs never overlap. `flock` on `run/update.lock` makes a tick that arrives while a build is
still going stand down, because a build can outlast the ten-minute interval and two Mavens in one
tree is not a state worth reasoning about.

## The toolchain problem

The first thing that goes wrong on a real machine is `npm not found`, on a machine where `npm -v`
answers perfectly well.

Nothing is broken. `nvm` is not a program on your `PATH` — it is a shell function defined by
`~/.nvm/nvm.sh`, sourced from `~/.bashrc`, and `~/.bashrc` returns immediately when the shell is not
interactive. sdkman works the same way, and `sudo` clears `PATH` to `secure_path` besides. A
deployment reaches the build through `sudo` → `runuser` → later `cron`, none of which is an
interactive login shell, so a toolchain that is unmistakably present when you type at a prompt is
unmistakably absent when the update job builds.

`build-with-toolchain.sh` is the answer: it sources nvm and sdkman itself, in the *building user's*
home, before handing off to `build-app.sh`. `update.sh` calls it instead of calling `build-app.sh`
directly, and `install-service.sh` runs it with `--check` before it writes anything, so a machine
missing a piece says so in a few seconds rather than a few minutes into a Maven run:

```bash
sudo -u zanevych scripts/deploy/build-with-toolchain.sh --check
```

If your toolchain is somewhere neither nvm nor sdkman knows about, write the paths down once:

```bash
sudo mkdir -p /etc/lnu-timetable
sudo tee /etc/lnu-timetable/build.env >/dev/null <<'ENV'
PATH=/opt/node-v24/bin:/opt/maven/bin:$PATH
JAVA_HOME=/opt/jdk-25
ENV
```

That file is sourced first and wins over everything the script would otherwise work out.

Two related traps, both handled here and both invisible until the first scheduled run:

- **`runuser` is in `/usr/sbin`**, which is not on cron's `PATH` for root (`/usr/bin:/bin`). The
  installed cron line therefore states `PATH` explicitly. Without that, every scheduled update would
  have died on `runuser: command not found` while the same script run by hand worked.
- **systemd starts the service with a minimal `PATH` too**, so a JDK that only sdkman knows about
  would be as invisible at run time as at build time. The installer detects `JAVA_HOME` during the
  preflight and writes it into `service.env`, which the unit passes to the JVM.

## Privileges

The unit runs as root, because port 80 is privileged. The git and Maven/npm work inside `update.sh`
is done as the user who owns the working tree — via `runuser`, when the script is running as root —
so that an automatic build never leaves root-owned files in `target/`, `node_modules/` or `dist/`
for that user to trip over the next time they build by hand. Root also gets `safe.directory` set for
the tree, without which git refuses to touch a checkout it does not own.

If you would rather not run as root, serve on a high port (`--port 8080`) and put nginx in front.
Nothing here assumes 80 beyond the default.

## The profile, and what the service does *not* inherit

`run-service.sh` starts the jar with `--spring.profiles.active=` — deliberately empty. That drops
`application-loc.properties`, which travels *inside* the jar and is active by default, and which
carries the development database password, the development JWT secret, and `DEBUG` logging for
`io.r2dbc.postgresql.PARAM`. That last one logs every bound parameter of every statement, including
the ones passed to `login`. Dropping the profile is most of what distinguishes this from a
developer's laptop.

What it does not drop: `spring.r2dbc.url` and the Flyway settings live in `application.properties`
and stay in force, so the service still points at `localhost:5432/lnu-timetable` unless you override
it. Set `SPRING_R2DBC_URL` and `SPRING_FLYWAY_URL` in `/etc/lnu-timetable/service.env` to move it —
[and change them together](../../timetable/README.md#migrations-flyway), or Flyway will migrate a
different database than the one the application reads.

The credentials reach the JVM as environment variables from `EnvironmentFile=`, not as command-line
arguments, so they do not show up in `ps` for anyone with a shell on the machine. Re-running the
installer rewrites the four keys it owns — the two credentials, the JWT secret and the port — and
keeps every other line in that file, so overrides you add by hand survive a credential change.

### Outgoing mail

Self-service registration and password recovery send a link from a mailbox. Three options configure
it, and all three are optional — the service starts without them and reports «не вдалося надіслати
листа» on the first attempt rather than refusing to boot:

| Option | Becomes | What it is |
|---|---|---|
| `--mail-username ADDR` | `MAIL_USERNAME` | the mailbox to send from, e.g. `timetable@lnu.edu.ua` |
| `--mail-password PASS` | `MAIL_PASSWORD` | its password, or an app password |
| `--base-url URL` | `APP_BASEURL` | the public address this instance answers on |

Interactively the installer asks for them too, after the credentials, and Enter skips them.

The third is not optional in practice, and the installer says so at the end if mail is configured
without it. `app.base-url` is what the links inside those messages are built from and it defaults to
`http://localhost:8080`, so without it every link in every inbox is a link to the reader's own
machine.

**A run that says nothing about mail leaves mail alone.** The set of keys the installer rewrites is
not fixed: the five it always owns, plus `MAIL_USERNAME`/`MAIL_PASSWORD` only when
`--mail-username` was given, plus `APP_BASEURL` only when `--base-url` was. Everything else in the
file is preserved as before. So re-running the installer to change the port or rotate the JWT secret
keeps a mailbox configured months ago, instead of quietly switching registration off — and removing
a mailbox is an edit to `/etc/lnu-timetable/service.env`, which is a deliberate act rather than a
side effect. `--mail-username` and `--mail-password` must be given together; half a mailbox cannot
authenticate.

See the service README's [Self-service registration and password
recovery](../../timetable/README.md#self-service-registration-and-password-recovery) for what those
links are, and for the two things Microsoft's side decides about whether that mailbox may
authenticate with a password at all.

## Day to day

```bash
systemctl status lnu-timetable            # running? since when? last exit status?
journalctl -u lnu-timetable -f            # the application log
journalctl -u lnu-timetable -n 200        # the last 200 lines, e.g. after a failed start
systemctl restart lnu-timetable           # by hand
tail -f run/update.log                    # what the ten-minute job has been doing

scripts/deploy/update.sh --force          # pull, rebuild, redeploy, restart, now
scripts/deploy/update.sh --no-pull        # rebuild and redeploy this checkout, no git
sudo scripts/deploy/install-service.sh --uninstall
```

Re-run `install-service.sh` to change a credential, the port (`--port`), the branch (`--branch`),
the interval (`--interval`) or the mailbox (`--mail-username`/`--mail-password`/`--base-url`); it
overwrites in place, and leaves alone whatever the run did not mention. `--uninstall` removes the unit, the cron entry
and the logrotate config, and deliberately leaves `/etc/lnu-timetable/service.env` and `run/` alone.

## Prerequisites on the host

JDK 25 and Maven (the update job builds on the machine it deploys to), Node.js 20+, PostgreSQL
reachable with the credentials you give the installer, and the schema already created — `schema.sql`
and `data.sql` are still applied by hand, exactly as the root README's *Known limitations* says.
Nothing here creates a database.

They have to be reachable from a *non-interactive* shell belonging to the user who owns the working
tree, which is not the same thing as being installed. `build-with-toolchain.sh --check` is how you
find out which, and *The toolchain problem* above is what to do when the answer is no.

## Known limitations

- **The build happens on the deployment host.** That is what makes one command enough, and it is
  also why an update costs a few minutes of CPU and a restart. A build server producing an artifact
  this host merely fetches would be the next step, and none of the three scripts would need to
  change much: `update.sh`'s build step is one call.
- **A restart is a brief outage.** There is no second instance and no connection draining. For a
  faculty timetable being edited by a handful of people this is the right trade; for anything with
  real traffic it is not.
- **`--force` deploys whatever is in the tree**, including uncommitted changes. That is what makes
  it useful for testing a fix on the host, and it means the deployed jar can be a build of something
  no commit describes.
- **The health check only asks whether the connector answers** on `/`, which it does as soon as the
  context is up. It says nothing about whether queries work, so a database that goes away *after*
  startup, or a pool that is exhausted, passes it. What it does catch is the failure that matters
  most here — a jar that will not start at all, which is also what an unreachable database looks
  like, because Flyway runs before the context is ready and a failed migration stops the boot.
