# Tooling Session Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tools/preview.sh` the sole owner of a nested Mutter Dev Kit session, recallable to change the extension's shape live, and fold the screenshot grid into `tools/e2e.sh`.

**Architecture:** A named session publishes its bus, pid, log and applied shape to a stable directory under `$XDG_RUNTIME_DIR`, so a second invocation attaches instead of booting a second shell. `preview.sh` owns start/attach/shape/capture/stop; `e2e.sh` starts a detached session and drives shape through `preview.sh` one exec per state, keeping its own `shell_eval` probes. Sourced-only scripts move to `tools/lib/`.

**Tech Stack:** Bash (the Bash tool runs `/bin/bash`, not the user's fish), `node --test` for unit tests, gnome-shell 50 with `--devkit` / `--headless`, gdbus, ImageMagick.

## Global Constraints

- **No WHAT comments.** A comment must document a non-obvious WHY or be deleted. Existing WHY comments in the moved files are preserved verbatim.
- **No blank lines inside a function body.** Extract a sub-function instead.
- Bash only, POSIX-ish; every script keeps `set -euo pipefail`.
- Every dconf write stays inside the session's `dbus-run-session`; `XDG_CONFIG_HOME` alone does not sandbox dconf.
- Nested shells are killed by pid only, never by name.
- `shellcheck` must pass on every file under `tools/` and `tools/lib/`.
- `npm test` runs with `TZ=UTC`; it is pinned in the script.
- Session directory name is the session name; the default session is `preview`.
- Virtual monitor is `1440x900`.
- Commits are signed (`git commit -S`) and carry no `Co-Authored-By` trailer (workspace rule for e7d app repos).
- Never edit a `.sh` file while a watcher is running it — bash re-reads by byte offset.

---

### Task 1: Move sourced libraries into `tools/lib/`

**Files:**
- Move: `tools/devkit.sh` → `tools/lib/devkit.sh`
- Move: `tools/indicator.sh` → `tools/lib/indicator.sh`
- Move: `tools/capture.sh` → `tools/lib/capture.sh`
- Move: `tools/assert.sh` → `tools/lib/assert.sh`
- Move: `tools/contrast.js` → `tools/lib/contrast.js`
- Move: `tools/attribution.js` → `tools/lib/attribution.js`
- Modify: `tools/preview.sh:7-12`, `tools/dev.sh:6-7`, `tools/e2e.sh:7-14`, `tools/a11y.sh:5-6` (source paths)
- Modify: `tools/a11y.js:6`, `tools/quota-attribution.js:6` (import paths)
- Modify: `tools/lib/contrast.js:1` (`../lib/theme.js` → `../../lib/theme.js`)
- Test: `test/assert.test.js:6`, `test/contrast.test.js:7`, `test/attribution.test.js:4`

**Interfaces:**
- Consumes: nothing.
- Produces: `tools/lib/` holding the four shell libraries and two JS libraries. `ROOT` still resolves to the repository root from inside `tools/lib/devkit.sh`.

- [ ] **Step 1: Update the three test files to the new paths and watch them fail**

`test/assert.test.js` line 6:

```javascript
const LIB = fileURLToPath(new URL('../tools/lib/assert.sh', import.meta.url));
```

`test/contrast.test.js` line 7 — change only the module specifier on the `from` line:

```javascript
} from '../tools/lib/contrast.js';
```

`test/attribution.test.js` line 4:

```javascript
import {DEFAULT_WINDOW_MINUTES, hourlyRows, verdict} from '../tools/lib/attribution.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '.../tools/lib/contrast.js'` and `.../tools/lib/attribution.js`, plus `assert.test.js` failing every case because sourcing a missing file aborts each `run()`.

- [ ] **Step 3: Move the six files with git**

```bash
mkdir -p tools/lib
git mv tools/devkit.sh tools/indicator.sh tools/capture.sh tools/assert.sh tools/lib/
git mv tools/contrast.js tools/attribution.js tools/lib/
```

- [ ] **Step 4: Fix `ROOT` in `tools/lib/devkit.sh`**

Line 4 climbs one directory and must now climb two. Replace:

```bash
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
```

with:

```bash
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
```

This is load-bearing: `INSTALLED`, `capture.sh`'s `OUT="$ROOT/preview"` and `dev.sh`'s `sources()` all hang off it, and a wrong `ROOT` makes `require_install` fail with a confusing message about the symlink.

- [ ] **Step 5: Fix `tools/lib/contrast.js` line 1**

```javascript
import {relativeLuminance} from '../../lib/theme.js';
```

- [ ] **Step 6: Fix the JS entrypoint imports**

`tools/a11y.js` line 6:

```javascript
import {scanImage, tickFindings, toHex} from './lib/contrast.js';
```

`tools/quota-attribution.js` line 6:

```javascript
import {CLUSTER_FRACTION, DEFAULT_WINDOW_MINUTES, SPREAD_FRACTION, hourlyRows, verdict} from './lib/attribution.js';
```

`tools/quota-attribution.js` line 5 (`from '../lib/attempts.js'`) is unchanged — that is the shipped `lib/`, not the tooling one, and `quota-attribution.js` has not moved.

- [ ] **Step 7: Fix every `source` line in the four shell entrypoints**

In `tools/preview.sh`, `tools/dev.sh`, `tools/e2e.sh` and `tools/a11y.sh`, each pair of lines takes the form:

```bash
# shellcheck source=tools/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/devkit.sh"
```

Rewrite both halves for each of `devkit.sh`, `indicator.sh`, `capture.sh`, `assert.sh`:

```bash
# shellcheck source=tools/lib/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/devkit.sh"
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, same count as before the move (151 at time of writing).

- [ ] **Step 9: Run shellcheck**

Run: `shellcheck tools/*.sh tools/lib/*.sh`
Expected: no output, exit 0. A `SC1091` about a sourced file means a `source=` directive still points at the old path.

- [ ] **Step 10: Prove the shell tooling still boots**

Run: `npm run e2e -- --group=lifecycle --dark-only`
Expected: `lifecycle:` followed by `ok` lines and `N passed, 0 failed`. This is the cheapest group that starts a real shell, so it proves `ROOT`, `INSTALLED` and the source paths together.

- [ ] **Step 11: Confirm the host session is untouched**

Run: `sha256sum ~/.config/dconf/user; gsettings get org.gnome.shell enabled-extensions | wc -c`
Expected: same digest and same length as before the run. Record them before Step 10 if not already known.

- [ ] **Step 12: Commit**

```bash
git add tools test
git commit -S -m "refactor(tools): move sourced libraries under tools/lib

The top of tools/ mixed four entrypoints with six files that only ever get
sourced or imported, so nothing said which of them was meant to be run."
```

---

### Task 2: Session registry in `tools/lib/devkit.sh`

**Files:**
- Modify: `tools/lib/devkit.sh:6-10` (paths), `:35-38` (cleanup), `:157` (trap)
- Test: `test/devkit.test.js` (create)

**Interfaces:**
- Consumes: Task 1's `tools/lib/` layout.
- Produces:
  - `use_session <name>` — sets `RUN`, `CFG`, `BUS_FILE`, `PID_FILE`, `LOG`, `STATE_FILE` for that session. Called with `$DEVKIT_NAME` at the bottom of `devkit.sh` so existing sourcers keep working.
  - `session_live` — returns 0 when `PID_FILE` names a live process.
  - `reap_session` — removes the session directory when it is not live; no-op when it is.
  - `attach_session` — returns 1 when not live, otherwise exports `DBUS_SESSION_BUS_ADDRESS` from `BUS_FILE`.
  - `release_session` — `stop_shell` then remove the session directory.
  - `own_session` — installs the EXIT/INT/TERM trap that calls `release_session`.
  - Root of the registry is `${CLAUDE_QUOTA_RUNTIME:-${XDG_RUNTIME_DIR:-/tmp}/claude-quota}`; the override exists so tests never touch a real session.

- [ ] **Step 1: Write the failing test**

Create `test/devkit.test.js`:

```javascript
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, existsSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const LIB = fileURLToPath(new URL('../tools/lib/devkit.sh', import.meta.url));

function run(script, runtime) {
    const env = {...process.env, CLAUDE_QUOTA_RUNTIME: runtime};
    try {
        const stdout = execFileSync('bash', ['-c', `set -euo pipefail\n. "${LIB}"\n${script}`],
            {encoding: 'utf8', env});
        return {status: 0, stdout};
    } catch (error) {
        return {status: error.status, stdout: error.stdout ?? ''};
    }
}

function runtimeRoot() {
    return mkdtempSync(join(tmpdir(), 'claude-quota-test-'));
}

test('use_session puts every path under the named session', () => {
    const root = runtimeRoot();
    const {stdout} = run('use_session shots\necho "$RUN"\necho "$BUS_FILE"\necho "$STATE_FILE"', root);
    const [runDir, bus, state] = stdout.trim().split('\n');
    assert.equal(runDir, join(root, 'shots'));
    assert.equal(bus, join(root, 'shots', 'bus'));
    assert.equal(state, join(root, 'shots', 'state'));
});

test('a session with no pid file is not live', () => {
    const root = runtimeRoot();
    const {status} = run('use_session ghost\nsession_live', root);
    assert.equal(status, 1);
});

test('a session whose pid is alive is live', () => {
    const root = runtimeRoot();
    const {status} = run('use_session mine\nmkdir -p "$RUN"\necho $$ > "$PID_FILE"\nsession_live', root);
    assert.equal(status, 0);
});

test('reap_session removes a directory whose process is gone', () => {
    const root = runtimeRoot();
    mkdirSync(join(root, 'stale'));
    writeFileSync(join(root, 'stale', 'pid'), '2\n');
    run('use_session stale\nreap_session', root);
    assert.equal(existsSync(join(root, 'stale')), false);
});

test('reap_session leaves a live session alone', () => {
    const root = runtimeRoot();
    const {status} = run('use_session mine\nmkdir -p "$RUN"\necho $$ > "$PID_FILE"\nreap_session\n[ -d "$RUN" ]', root);
    assert.equal(status, 0);
});

test('attach_session refuses a session that is not running', () => {
    const root = runtimeRoot();
    const {status} = run('use_session ghost\nattach_session', root);
    assert.equal(status, 1);
});

test('attach_session exports the recorded bus address', () => {
    const root = runtimeRoot();
    const script = `use_session mine
        mkdir -p "$RUN"
        echo $$ > "$PID_FILE"
        echo 'unix:path=/run/fake-bus' > "$BUS_FILE"
        attach_session
        echo "$DBUS_SESSION_BUS_ADDRESS"`;
    const {status, stdout} = run(script, root);
    assert.equal(status, 0);
    assert.match(stdout, /unix:path=\/run\/fake-bus/);
});
```

Note the pid `2` in the stale test: pid 2 is `kthreadd` on Linux and `kill -0 2` fails for an unprivileged user, so it reads as dead without the flakiness of guessing an unused pid.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep -A3 'devkit'`
Expected: FAIL — `use_session: command not found`.

- [ ] **Step 3: Replace the path block in `tools/lib/devkit.sh`**

Delete lines 6–10 (`RUN`, `CFG`, `BUS_FILE`, `PID_FILE`, `LOG`) and put in their place:

```bash
RUNTIME_ROOT="${CLAUDE_QUOTA_RUNTIME:-${XDG_RUNTIME_DIR:-/tmp}/claude-quota}"

use_session() {
    RUN="$RUNTIME_ROOT/$1"
    CFG="$RUN/config"
    BUS_FILE="$RUN/bus"
    PID_FILE="$RUN/pid"
    LOG="$RUN/shell.log"
    STATE_FILE="$RUN/state"
}
```

- [ ] **Step 4: Add the session predicates below `use_session`**

```bash
session_live() {
    [ -s "$PID_FILE" ] || return 1
    kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

reap_session() {
    session_live && return 0
    rm -rf "$RUN"
    return 0
}

attach_session() {
    session_live || return 1
    DBUS_SESSION_BUS_ADDRESS="$(cat "$BUS_FILE")"
    export DBUS_SESSION_BUS_ADDRESS
}
```

- [ ] **Step 5: Replace `cleanup` and the trap**

`cleanup` at lines 35–38 becomes `release_session`, and the unconditional trap at the bottom is removed in favour of an explicit installer, so an attaching process cannot tear down a session it does not own:

```bash
release_session() {
    stop_shell
    rm -rf "$RUN"
}

own_session() {
    trap release_session EXIT INT TERM
}
```

Delete the final `trap cleanup EXIT INT TERM` line.

- [ ] **Step 6: Default the session at the bottom of the file**

Add as the last line, so a sourcer that never calls `use_session` still has working paths:

```bash
use_session "$DEVKIT_SESSION"
```

and add its default beside the other `:` defaults near the top:

```bash
: "${DEVKIT_SESSION:=$DEVKIT_NAME}"
```

- [ ] **Step 7: Make `start_shell` create the directory**

`mktemp -d` used to create it. Add as the first line of `start_shell`, before `local backend`:

```bash
mkdir -p "$RUN"
```

`isolate_dconf` already does `mkdir -p "$CFG/dconf"`, so it needs no change.

- [ ] **Step 8: Install the trap in the three current owners**

`tools/preview.sh`, `tools/dev.sh` and `tools/e2e.sh` each call `own_session` immediately before their `start_shell` call. `tools/a11y.sh` never starts a shell and must not call it.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, seven new tests.

- [ ] **Step 10: Prove a real session still boots and cleans up**

```bash
ls "${XDG_RUNTIME_DIR}/claude-quota" 2>/dev/null || echo 'no registry yet'
npm run e2e -- --group=lifecycle --dark-only
ls "${XDG_RUNTIME_DIR}/claude-quota" 2>/dev/null || echo 'registry cleaned'
```

Expected: the group passes, and the registry is empty or absent afterwards — the EXIT trap removed the session directory.

- [ ] **Step 11: Run shellcheck**

Run: `shellcheck tools/*.sh tools/lib/*.sh`
Expected: no output.

- [ ] **Step 12: Commit**

```bash
git add tools test
git commit -S -m "feat(tools): publish each nested session to a stable registry

A private mktemp dir meant nothing could find a session it had not started
itself, so every look at a second state cost a fresh boot."
```

---

### Task 3: Record the applied shape, and name a tile from it

**Files:**
- Modify: `tools/lib/devkit.sh` (state helpers, after `attach_session`)
- Modify: `tools/lib/capture.sh:41-68` (`capture` loses its render step and gains its name from the state)
- Test: `test/devkit.test.js` (extend)

**Interfaces:**
- Consumes: Task 2's `use_session`, `STATE_FILE`.
- Produces:
  - `state_set <key> <value>` — writes one `key=value` line, replacing any previous line for that key.
  - `state_get <key>` — echoes the recorded value, or the empty string.
  - `tile_name` — echoes `<theme|default>-<scenario|live>`, from the recorded `theme` and `data` keys.
  - `capture <name>` — one argument now; the caller renders the state first.

- [ ] **Step 1: Write the failing tests**

Append to `test/devkit.test.js`:

```javascript
test('state_get returns empty for a key never written', () => {
    const root = runtimeRoot();
    const {stdout} = run('use_session mine\nmkdir -p "$RUN"\necho "[$(state_get theme)]"', root);
    assert.match(stdout, /\[\]/);
});

test('state_set then state_get round-trips a value', () => {
    const root = runtimeRoot();
    const {stdout} = run('use_session mine\nmkdir -p "$RUN"\nstate_set theme dark\nstate_get theme', root);
    assert.equal(stdout.trim(), 'dark');
});

test('state_set replaces a previous value rather than appending', () => {
    const root = runtimeRoot();
    const script = `use_session mine
        mkdir -p "$RUN"
        state_set theme dark
        state_set theme light
        state_get theme
        wc -l < "$STATE_FILE"`;
    const {stdout} = run(script, root);
    const [value, lines] = stdout.trim().split('\n');
    assert.equal(value, 'light');
    assert.equal(lines.trim(), '1');
});

test('state_set keeps the other keys', () => {
    const root = runtimeRoot();
    const script = `use_session mine
        mkdir -p "$RUN"
        state_set theme dark
        state_set data normal
        state_set theme light
        echo "$(state_get theme)/$(state_get data)"`;
    const {stdout} = run(script, root);
    assert.equal(stdout.trim(), 'light/normal');
});

test('tile_name joins the recorded theme and data', () => {
    const root = runtimeRoot();
    const script = `use_session mine
        mkdir -p "$RUN"
        state_set theme dark
        state_set data error
        tile_name`;
    const {stdout} = run(script, root);
    assert.equal(stdout.trim(), 'dark-error');
});

test('tile_name calls an unforced theme default', () => {
    const root = runtimeRoot();
    const script = `use_session mine
        mkdir -p "$RUN"
        state_set data live
        tile_name`;
    const {stdout} = run(script, root);
    assert.equal(stdout.trim(), 'default-live');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -c 'state_set: command not found'`
Expected: a non-zero count.

- [ ] **Step 3: Implement the state helpers in `tools/lib/devkit.sh`**

Add after `attach_session`:

```bash
state_get() {
    [ -f "$STATE_FILE" ] || return 0
    sed -n "s/^$1=//p" "$STATE_FILE"
}

state_set() {
    local kept="$RUN/state.next"
    [ -f "$STATE_FILE" ] && grep -v "^$1=" "$STATE_FILE" > "$kept" || : > "$kept"
    echo "$1=$2" >> "$kept"
    mv "$kept" "$STATE_FILE"
}

tile_name() {
    echo "$(state_get theme || echo default)-$(state_get data)"
}
```

`grep -v` exits 1 when it filters everything out, which under `set -e` would kill the caller — the `|| : > "$kept"` covers that, and is the same class as the documented `grep`-as-a-filter trap.

- [ ] **Step 4: Make `tile_name` fall back when the theme was never forced**

`state_get theme` succeeds with empty output rather than failing, so `|| echo default` never fires. Use a variable instead:

```bash
tile_name() {
    local theme
    theme="$(state_get theme)"
    echo "${theme:-default}-$(state_get data)"
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, six further tests.

- [ ] **Step 6: Take the render out of `capture`**

In `tools/lib/capture.sh`, `capture` currently takes a name and a scenario and renders the scenario itself. Under `--live` there is no scenario to render, so the caller owns rendering. Change the signature and drop the first line of the body:

```bash
capture() {
    local name="$1" box rect panel
    close_menu
```

Everything from `close_menu` down is unchanged, including the WHY comment above the function about the menu never repositioning itself.

- [ ] **Step 7: Fix the one existing caller**

`tools/e2e.sh:201` currently reads `capture "$theme-$scenario" "$scenario"`. It becomes two statements, preserving today's behaviour exactly:

```bash
render_state "$scenario"
capture "$theme-$scenario"
```

- [ ] **Step 8: Prove the capture path still produces a tile**

Run: `npm run e2e -- --group=state --dark-only --scenario=normal && magick identify preview/dark-normal.png`
Expected: assertions pass and `identify` reports a PNG several hundred pixels tall — the three states smushed.

- [ ] **Step 9: Run shellcheck and commit**

```bash
shellcheck tools/*.sh tools/lib/*.sh
git add tools test
git commit -S -m "feat(tools): record the shape a session is in

A tile's name and a watch restart both need to know what was last applied,
and capture cannot re-render a live session the way it re-renders a scenario."
```

---

### Task 4: `preview.sh` becomes the session driver

**Files:**
- Rewrite: `tools/preview.sh`
- Test: manual, plus `npm run e2e` in Task 7

**Interfaces:**
- Consumes: `use_session`, `session_live`, `reap_session`, `attach_session`, `release_session`, `own_session`, `state_set`, `state_get` from `lib/devkit.sh`; `SCENARIOS`, `select_scenarios`, `freeze`, `set_theme`, `render_state`, `open_menu`, `close_menu`, `point_at` from `lib/indicator.sh`.
- Produces: `tools/preview.sh` accepting `--session=`, `--windowed`, `--headless`, `--dark`, `--light`, `--scenario=`, `--live`, `--close`, `--hover`, `--open`, `--detach`, `--stop`, `-h`. `--capture` and `--watch` arrive in Tasks 5 and 6.

- [ ] **Step 1: Write the new `tools/preview.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

DEVKIT_NAME='preview'
DEVKIT_SETUP='gsettings set org.gnome.desktop.interface font-name "Cantarell 11"'
DEVKIT_HEADLESS=0
# shellcheck source=tools/lib/devkit.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/devkit.sh"
# shellcheck source=tools/lib/indicator.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/indicator.sh"

SESSION='preview'
WANT_THEME=''
WANT_DATA=''
WANT_POPUP=''
WANT_BACKEND=''
DETACH=0
STOP=0

usage() {
    cat <<USAGE
Usage: tools/preview.sh [options]

Owns one nested GNOME shell and sets the shape of the extension inside it. Called
again while that session is up, it changes the shape live instead of restarting.

Options:
  --session=<name>   Name the session (default preview)
  --windowed         Show the session in a Mutter devkit window (default)
  --headless         Run with no window, driven over D-Bus
  --dark, --light    Force a colour scheme
  --scenario=<name>  Render a fabricated state
  --live             Render real data (default)
  --close            Leave the popup closed and the pointer away (default)
  --hover            Leave the pointer on the panel button
  --open             Leave the popup open
  --detach           Start the session and return instead of blocking
  --stop             Tear the session down
  -h, --help         Show this message

An option you leave out is left alone: preview.sh --light repaints and changes
nothing else. On a fresh session the defaults above apply.

Scenarios:
  ${SCENARIOS[*]}

Needs gnome-shell with this checkout symlinked at
$INSTALLED
USAGE
}

for arg in "$@"; do
    case "$arg" in
        --session=*) SESSION="${arg#*=}" ;;
        --windowed) WANT_BACKEND=windowed ;;
        --headless) WANT_BACKEND=headless ;;
        --dark|--light) WANT_THEME="${arg#--}" ;;
        --scenario=*) WANT_DATA="${arg#*=}"; PICKED=("${arg#*=}") ;;
        --live) WANT_DATA=live ;;
        --close|--hover|--open) WANT_POPUP="${arg#--}" ;;
        --detach) DETACH=1 ;;
        --stop) STOP=1 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option $arg" ;;
    esac
done
```

`PICKED` is set alongside `WANT_DATA` so `select_scenarios` can validate the name against `SCENARIOS` and die on a typo rather than rendering nothing.

- [ ] **Step 2: Add the shape appliers**

Append to `tools/preview.sh`:

```bash
apply_theme() {
    [ -n "$WANT_THEME" ] || return 0
    set_theme "$WANT_THEME"
    state_set theme "$WANT_THEME"
}

apply_data() {
    [ -n "$WANT_DATA" ] || return 0
    if [ "$WANT_DATA" = 'live' ]; then
        unfreeze
    else
        freeze
        render_state "$WANT_DATA"
    fi
    state_set data "$WANT_DATA"
}

apply_popup() {
    [ -n "$WANT_POPUP" ] || return 0
    case "$WANT_POPUP" in
        close) close_menu; point_at away ;;
        hover) close_menu; point_at pill ;;
        open) point_at away; open_menu ;;
    esac
    state_set popup "$WANT_POPUP"
}

apply_shape() {
    apply_theme
    apply_data
    apply_popup
}
```

`--open` moves the pointer away first because the session's first pointer motion closes a menu it lands inside — the same reason `e2e.sh` has `reopen_menu`.

- [ ] **Step 3: Add `unfreeze` to `tools/lib/indicator.sh`**

Beside `freeze`, so both halves of the same decision live together:

```bash
unfreeze() {
    shell_eval "const i = Main.panel.statusArea['$UUID'];
        delete i._refresh; i._refresh('manual'); 'ok'" >/dev/null
}
```

`freeze` sets `_refresh` as an own property, so `delete` restores the prototype method — the same move `e2e.sh`'s `unfreeze_refresh` makes.

- [ ] **Step 4: Add the defaults and the main flow**

```bash
fresh_defaults() {
    : "${WANT_THEME:=}"
    : "${WANT_DATA:=live}"
    : "${WANT_POPUP:=close}"
    : "${WANT_BACKEND:=windowed}"
}

start() {
    require_install
    reap_session
    fresh_defaults
    [ "$WANT_BACKEND" = 'headless' ] && DEVKIT_HEADLESS=1
    isolate_dconf
    [ "$DETACH" -eq 1 ] || own_session
    start_shell
    wait_for_indicator
    hide_overview
    state_set backend "$WANT_BACKEND"
    apply_shape
}

main() {
    use_session "$SESSION"
    select_scenarios
    if [ "$STOP" -eq 1 ]; then
        session_live && release_session
        exit 0
    fi
    if attach_session; then
        apply_shape
        exit 0
    fi
    start
    [ "$DETACH" -eq 1 ] && { echo "preview: session '$SESSION' up, detached"; exit 0; }
    echo "preview: session '$SESSION' up, Ctrl-C to stop"
    echo "preview: log $LOG"
    wait
}

main
```

`[ "$WANT_BACKEND" = 'headless' ] && DEVKIT_HEADLESS=1` as the last command of a function would make the function return 1 under `set -e`; it is mid-function here, followed by more commands, so it is safe. The same shape at the end of `main` is guarded by the explicit `exit 0` inside the braces.

- [ ] **Step 5: Handle a backend change on a live session**

Inside `main`, replace the bare `if attach_session; then` block with one that restarts when the backend no longer matches:

```bash
    if attach_session; then
        if [ -n "$WANT_BACKEND" ] && [ "$WANT_BACKEND" != "$(state_get backend)" ]; then
            echo "preview: $WANT_BACKEND needs a new shell, restarting session '$SESSION'"
            replay_backend
        else
            apply_shape
        fi
        exit 0
    fi
```

and define `replay_backend` above `main`:

```bash
replay_backend() {
    WANT_THEME="${WANT_THEME:-$(state_get theme)}"
    WANT_DATA="${WANT_DATA:-$(state_get data)}"
    WANT_POPUP="${WANT_POPUP:-$(state_get popup)}"
    stop_shell
    start
}
```

A silent restart would read as a hang, which is why it prints before doing it.

- [ ] **Step 6: Verify a fresh windowed session comes up**

Run: `npm run preview -- --dark --scenario=critical`
Expected: a Mutter Development Kit window opens showing the panel with the extension, dark, in the `critical` state; the terminal prints `preview: session 'preview' up, Ctrl-C to stop` and blocks. Leave it running.

- [ ] **Step 7: Verify a recall changes the shape without restarting**

In a second terminal:

```bash
npm run preview -- --light
npm run preview -- --open
npm run preview -- --scenario=error
```

Expected: each returns immediately, the window never blinks or reopens, and it shows in turn light theme, the popup open, then the error state with the popup still open — proving an omitted flag is left alone.

- [ ] **Step 8: Verify `--stop` and Ctrl-C both clean up**

```bash
npm run preview -- --stop
ls "${XDG_RUNTIME_DIR}/claude-quota" 2>/dev/null || echo 'registry cleaned'
```

Expected: the window closes, the blocking terminal returns, and the registry is empty. Repeat with Ctrl-C in the blocking terminal instead of `--stop` and expect the same.

- [ ] **Step 9: Confirm the host session is untouched**

Run: `sha256sum ~/.config/dconf/user; gsettings get org.gnome.shell enabled-extensions | wc -c`
Expected: unchanged from the values recorded in Task 1.

- [ ] **Step 10: Run shellcheck and commit**

```bash
shellcheck tools/*.sh tools/lib/*.sh
git add tools
git commit -S -m "feat(tools): make preview.sh own a session and reshape it live

Looking at a second state meant killing the window and paying a full boot,
because nothing could reach a session it had not started."
```

---

### Task 5: `preview.sh --capture`

**Files:**
- Modify: `tools/preview.sh` (source `lib/capture.sh`, parse `--capture`, shoot in `apply_shape`)

**Interfaces:**
- Consumes: `capture <name>` (Task 3), `tile_name` (Task 3), `OUT` and `prepare_out` from `lib/capture.sh`.
- Produces: `--capture` writes `preview/<tile_name>.png` and prints that path on stdout, so a caller in another process can collect it.

- [ ] **Step 1: Source the capture library**

In `tools/preview.sh`, after the `indicator.sh` source line:

```bash
# shellcheck source=tools/lib/capture.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/capture.sh"
```

- [ ] **Step 2: Parse the flag**

Add `CAPTURE=0` beside the other defaults, and a case beside `--open`:

```bash
        --capture) CAPTURE=1 ;;
```

Add the line to `usage`, above `--detach`:

```
  --capture          Shoot preview/<theme>-<scenario>.png of the shape applied
```

- [ ] **Step 3: Shoot between the data and the popup**

`capture` drives its own close → hover → open cycle, so it must run before `apply_popup` leaves the session in the shape the caller asked for. In `apply_shape`:

```bash
apply_shape() {
    apply_theme
    apply_data
    shoot_tile
    apply_popup
}

shoot_tile() {
    [ "$CAPTURE" -eq 1 ] || return 0
    require_commands magick
    mkdir -p "$OUT"
    capture "$(tile_name)"
}
```

`capture` already echoes the path it wrote as its last line (`echo "  $OUT/$name.png"`), which would give a caller a two-space-indented string. Change that line in `tools/lib/capture.sh` to print the bare path:

```bash
    echo "$OUT/$name.png"
```

and let `e2e.sh` do its own indenting when it echoes progress (Task 7).

- [ ] **Step 4: Verify a capture lands and prints its path**

```bash
npm run preview -- --headless --detach --dark --scenario=warning
npm run preview -- --capture
npm run preview -- --stop
```

Expected: the second call prints `.../preview/dark-warning.png` and nothing else, and `magick identify preview/dark-warning.png` reports a PNG.

- [ ] **Step 5: Verify a live capture names itself**

```bash
npm run preview -- --headless --detach --light --live --capture
npm run preview -- --stop
```

Expected: the first call prints a path ending `light-live.png`.

- [ ] **Step 6: Verify the popup flag survives the capture**

```bash
npm run preview -- --headless --detach --dark --scenario=normal
npm run preview -- --capture --open
[ "$(npm run --silent preview -- --session=preview --scenario=normal >/dev/null; echo done)" = done ]
npm run preview -- --stop
```

Expected: no error. The meaningful check is by eye in windowed mode — repeat the first two commands with `--windowed` instead of `--headless --detach` in another terminal and confirm the popup is open when the capture returns.

- [ ] **Step 7: Run shellcheck and commit**

```bash
shellcheck tools/*.sh tools/lib/*.sh
git add tools
git commit -S -m "feat(tools): let preview.sh shoot the shape it just applied

The tile a grid run collects and the shape a human is looking at are the same
thing, so the driver that sets one should be able to shoot the other."
```

---

### Task 6: `--watch`, and `dev.sh` folds in

**Files:**
- Modify: `tools/preview.sh` (`--watch`, `sources`, `signature`)
- Delete: `tools/dev.sh`
- Modify: `package.json:7-11`

**Interfaces:**
- Consumes: Task 4's `start`, `replay_backend`, `stop_shell`.
- Produces: `--watch`; `npm run dev` and `npm run dev:watch` as aliases.

- [ ] **Step 1: Move `sources` and `signature` over**

Copy both functions from `tools/dev.sh:49-61` into `tools/preview.sh` verbatim, WHY comment included:

```bash
sources() {
    find "$ROOT/extension.js" "$ROOT/stylesheet.css" "$ROOT/metadata.json" \
        "$ROOT/lib" "$ROOT/icons" -type f 2>/dev/null | sort
}

# sha256sum digests empty input to a real-looking constant, leaving the watcher
# silently never firing.
signature() {
    local list="$RUN/sources"
    sources > "$list"
    [ -s "$list" ] || die 'no source files matched; watch would never fire'
    xargs stat -c '%n %Y' < "$list" | sha256sum | cut -d' ' -f1
}
```

- [ ] **Step 2: Parse `--watch` and add the loop**

`WATCH=0` beside the other defaults, `--watch) WATCH=1 ;;` beside `--detach`, and in `usage` above `--detach`:

```
  --watch            Restart the shell on a source change, replaying the shape
```

Then replace the tail of `main` — the `wait` — with:

```bash
    if [ "$WATCH" -eq 0 ]; then
        wait
        exit 0
    fi
    watch_sources
```

and define, above `main`:

```bash
# Shell caches extension modules for the life of the process, so a disable/enable
# cycle would silently re-run the old code.
watch_sources() {
    require_commands find stat sha256sum xargs
    local last now
    last="$(signature)"
    while true; do
        sleep 1
        now="$(signature)"
        [ "$now" = "$last" ] && continue
        last="$now"
        echo 'preview: source changed, restarting'
        replay_backend
    done
}
```

`replay_backend` already stops the shell, re-reads the recorded shape and starts again, which is exactly a watch restart.

- [ ] **Step 3: Verify the watcher restarts and replays**

Run `npm run dev:watch -- --dark --scenario=critical` in one terminal, then in another:

```bash
touch stylesheet.css
```

Expected: the first terminal prints `preview: source changed, restarting` and the window comes back dark, in `critical` — the shape survived the restart. Ctrl-C to finish.

- [ ] **Step 4: Delete `dev.sh`**

```bash
git rm tools/dev.sh
```

- [ ] **Step 5: Repoint the npm scripts**

`package.json` scripts become:

```json
  "scripts": {
    "test": "TZ=UTC node --test",
    "dev": "tools/preview.sh --windowed",
    "dev:watch": "tools/preview.sh --windowed --watch",
    "preview": "tools/preview.sh",
    "e2e": "tools/e2e.sh",
    "a11y": "tools/a11y.sh",
    "attribution": "node tools/quota-attribution.js"
  }
```

- [ ] **Step 6: Verify both aliases still work**

Run: `npm run dev -- --scenario=normal`
Expected: a window opens on the `normal` state; Ctrl-C closes it and clears the registry.

- [ ] **Step 7: Run shellcheck and commit**

```bash
shellcheck tools/*.sh tools/lib/*.sh
git add tools package.json
git commit -S -m "feat(tools): fold dev.sh into preview.sh --watch

Two scripts held two copies of the same launch-and-restart loop, and only one
of them could put the extension into a given state."
```

---

### Task 7: `e2e.sh` absorbs the grid

**Files:**
- Modify: `tools/e2e.sh:16-22` (shoot mode), `:31-52` (usage), `:54-64` (parsing), `:91-97` (`shoots`), `:192-210` (`group_state`), `:474-491` (`main`)

**Interfaces:**
- Consumes: `tools/preview.sh` as a subprocess; `attach_session`, `use_session`, `release_session` from `lib/devkit.sh`; `normalize`, `overview`, `prepare_out` from `lib/capture.sh`.
- Produces: `tools/e2e.sh` shooting every scenario by default, `--a11y` for the scored subset, `--assert` for none.

- [ ] **Step 1: Turn `SHOOT` into a mode**

Replace line 20 (`SHOOT=(...)`) with the scored subset under a clearer name, plus the mode:

```bash
A11Y_SHOTS=(normal warning critical model-scoped error service-major over-pace rate-limited rate-limited-day no-data)
SHOOT_MODE=all
```

- [ ] **Step 2: Parse the two new flags**

Beside `--group=*` in the argument loop:

```bash
        --a11y) SHOOT_MODE=a11y ;;
        --assert) SHOOT_MODE=none ;;
```

- [ ] **Step 3: Rewrite `shoots` against the mode**

```bash
shoots() {
    local name
    case "$SHOOT_MODE" in
        all) return 0 ;;
        none) return 1 ;;
    esac
    for name in "${A11Y_SHOTS[@]}"; do
        [ "$name" = "$1" ] && return 0
    done
    return 1
}
```

- [ ] **Step 4: Update the usage text**

Replace the `Options:` block's screenshot note and add the two flags:

```
  --a11y               Shoot only the subset npm run a11y scores
  --assert             Shoot nothing, leaving preview/ alone
```

and replace the paragraph beginning `Screenshots belong to the state group` with:

```
Every scenario is shot by default, which costs minutes; narrow with --group,
--scenario or --dark-only while iterating, or pass --assert to shoot nothing.
Screenshots belong to the state group, so a run that excludes it leaves
preview/ alone and npm run a11y would score whatever was already there.
```

- [ ] **Step 5: Drive shape through `preview.sh` in `group_state`**

```bash
PREVIEW="$ROOT/tools/preview.sh"

group_state() {
    prepare_out "$(subset_kind)"
    prove_state
    local theme scenario shot
    for theme in "${THEMES[@]}"; do
        "$PREVIEW" --session=e2e "--$theme" >/dev/null
        echo "$theme:"
        for scenario in "${SCENARIOS[@]}"; do
            if shoots "$scenario"; then
                shot="$("$PREVIEW" --session=e2e --scenario="$scenario" --capture)"
                SHOTS+=("$shot")
                echo "  $shot"
            else
                "$PREVIEW" --session=e2e --scenario="$scenario" >/dev/null
            fi
            assert_state "$theme-$scenario"
        done
    done
    assert_theme_differs
    [ "${#SHOTS[@]}" -eq 0 ] || { normalize; overview; }
}
```

The theme is set once per row rather than per scenario: `set_theme` sleeps 2 seconds, and an omitted flag is left alone, so paying it 23 times a row would add three quarters of a minute for nothing.

- [ ] **Step 6: Start the session through `preview.sh` in `main`**

```bash
main() {
    require_install
    require_commands magick
    select_scenarios
    select_groups
    use_session e2e
    reap_session
    own_session
    "$PREVIEW" --session=e2e --headless --detach --live >/dev/null
    attach_session || die 'preview.sh did not publish a session'
    freeze
    runs_group state && group_state
    runs_group hover && group_hover
    runs_group refresh && group_refresh
    runs_group lifecycle && group_lifecycle
    assert_summary
}
```

`isolate_dconf`, `start_shell`, `wait_for_indicator` and `hide_overview` all move into `preview.sh`'s `start`, so they come out of here. `freeze` stays: the groups other than `state` fabricate their own states and must not be answered by a real poll.

- [ ] **Step 7: Verify the default shoots everything**

Run: `npm run e2e -- --group=state --dark-only 2>&1 | tail -5; ls preview/*.png | wc -l`
Expected: assertions pass and 23 PNGs plus `overview.png` — every scenario in the dark row.

- [ ] **Step 8: Verify `--a11y` shoots ten and `--assert` shoots none**

```bash
rm -f preview/*.png
npm run e2e -- --group=state --dark-only --a11y >/dev/null && ls preview/*.png | wc -l
rm -f preview/*.png
npm run e2e -- --group=state --dark-only --assert >/dev/null && ls preview/*.png 2>/dev/null | wc -l
```

Expected: `11` (ten tiles plus `overview.png`), then `0`.

- [ ] **Step 9: Verify the negative controls still fire**

Run: `npm run e2e -- --group=state --dark-only --assert 2>&1 | grep -c '^prove '`
Expected: `5` — one line per control in `prove_state`. A `control …` line on stderr with a non-zero exit means an assertion is dead and must be fixed, never the control.

- [ ] **Step 10: Run the whole suite**

Run: `npm run e2e`
Expected: every group passes, `N passed, 0 failed`, and `preview/` holds 48 tiles plus `overview.png`. Then `npm run a11y` exits 0.

- [ ] **Step 11: Confirm the host session is untouched, run shellcheck, commit**

```bash
sha256sum ~/.config/dconf/user; gsettings get org.gnome.shell enabled-extensions | wc -c
shellcheck tools/*.sh tools/lib/*.sh
git add tools
git commit -S -m "feat(tools): shoot every scenario from the assertion suite

The grid and the state group were the same loop over theme by scenario and
differed only in which of them they shot, so a screenshot could reach preview/
without anything having asserted it."
```

---

### Task 8: A monitor big enough for three quotas

**Files:**
- Modify: `tools/lib/devkit.sh:14` (`DEVKIT_MONITOR`)

**Interfaces:**
- Consumes: nothing.
- Produces: a `1440x900` virtual monitor, and a recorded finding about whether the devkit window can be sized.

- [ ] **Step 1: Reproduce the truncation**

```bash
npm run preview -- --headless --detach --scenario=model-scoped --capture
npm run preview -- --stop
magick identify preview/default-model-scoped.png
```

Expected: a tile whose panel row reads `S 30% · W 44% · O 72%` truncated with ellipses at `1280x800`. Keep the file to compare against.

- [ ] **Step 2: Widen the virtual monitor**

`tools/lib/devkit.sh` line 14:

```bash
DEVKIT_MONITOR='1440x900'
```

- [ ] **Step 3: Verify the headless backend honours it**

```bash
npm run preview -- --headless --detach --scenario=model-scoped --capture
npm run preview -- --stop
```

Expected: the same tile, now with all three quotas spelled out, no ellipsis.

- [ ] **Step 4: Probe whether the devkit window can be sized**

`--devkit` brings its own window and takes no size argument, and pairing it with `--virtual-monitor` strands the panel on a display the viewer never shows — the WHY comment above `devkit_flag` says so. Probe, in this order, stopping at the first that works:

```bash
gnome-shell --help-all 2>&1 | grep -iE 'devkit|monitor|virtual'
MUTTER_DEBUG_DUMMY_MODE_SPECS=1440x900 npm run preview -- --windowed --scenario=model-scoped
```

Expected: either the window comes up at 1440x900, or it does not. Record which in the commit message. If an environment variable works, set it beside `DEVKIT_SETUP` in `start_shell`'s environment; if none does, leave the window at its native size and note it in `docs/development.md` in Task 9 — a windowed session showing a truncated panel is then a known limit, not a bug to chase.

- [ ] **Step 5: Reshoot the grid so `preview/` is consistent**

Run: `npm run e2e >/dev/null && npm run a11y`
Expected: `a11y` exits 0. Tile dimensions change with the monitor, so a mixed `preview/` would give `normalize` two different widths to reconcile.

- [ ] **Step 6: Commit**

```bash
git add tools
git commit -S -m "fix(tools): give the harness a monitor wide enough for three quotas

At 1280x800 the panel ellipsized as soon as a model-scoped quota appeared, so
the harness truncated the very thing it exists to show."
```

---

### Task 9: Documentation

**Files:**
- Modify: `AGENTS.md` (shape-of-the-code table, § Checking your work, § Things that will bite you)
- Modify: `README.md` § Development
- Modify: `docs/development.md` §§ Seeing what rendered, Asserting what it does

**Interfaces:**
- Consumes: the finished CLI surface of Tasks 4–8.
- Produces: documentation matching the tools, with no reference to `dev.sh`, `--dark-only` on `preview.sh`, or `tools/*.sh` paths for the moved libraries.

- [ ] **Step 1: Find every stale reference**

```bash
grep -rn 'dev\.sh\|tools/devkit\.sh\|tools/indicator\.sh\|tools/capture\.sh\|tools/assert\.sh\|tools/contrast\.js\|tools/attribution\.js\|npm run preview' \
    README.md AGENTS.md docs/development.md
```

Expected: a list to work through. Everything it prints must be corrected or deleted; nothing outside `docs/superpowers/specs/` may keep an old path.

- [ ] **Step 2: Update the `AGENTS.md` shape-of-the-code table**

The `tools/*.sh`, `tools/*.js` row becomes two:

```markdown
| `tools/*.sh`, `tools/*.js` | Your machine | Entrypoints. Never shipped to users. |
| `tools/lib/*` | Your machine | Sourced or imported by the entrypoints, never run directly. |
```

- [ ] **Step 3: Rewrite `AGENTS.md` § Checking your work**

The two fast paths change. Replace the preview paragraph and its command block with:

```markdown
**When a change affects what the popup or panel looks like, put the state on screen and look at it.**

    npm run preview -- --dark --scenario=loading

That opens a Mutter devkit window and blocks. Recall it from another terminal to
change the shape live — `--light`, `--open`, `--scenario=no-data` — and only what
you name changes. `--headless --detach --capture` shoots the tile instead of
showing it, which is the form to reach for when nobody is watching.

**For a screenshot that is also asserted, narrow the suite instead:**

    npm run e2e -- --group=state --dark-only --scenario=loading
```

and in the e2e paragraph, note that a bare `npm run e2e` now shoots all 48 tiles and costs minutes, `--a11y` shoots the scored ten, `--assert` shoots none.

- [ ] **Step 4: Fix the `AGENTS.md` bite-you note about editing a running script**

`tools/dev.sh` no longer exists:

```markdown
**Editing a running `.sh` corrupts it.** Bash re-reads the script by byte offset, so stop a watcher (`npm run dev:watch`) before editing `tools/preview.sh`.
```

- [ ] **Step 5: Rewrite `README.md` § Development**

Read the section first (`README.md:102-205`) and keep its existing voice and heading depth. Document three entrypoints and their flags: `preview.sh` (the full option list from `usage`), `e2e.sh` (including `--a11y` and `--assert`), `a11y.sh`. Delete the `dev.sh` subsection and fold its content into `preview.sh --windowed --watch`, keeping the existing note that a nested session leaves the host untouched.

- [ ] **Step 6: Rewrite `docs/development.md` § Seeing what rendered**

Read the section first (`docs/development.md:32-54`). Same content as the README section but from the day-to-day angle: the recall loop, what an omitted flag means, where tiles land, and the note from Task 8 Step 4 about the devkit window's size if it could not be set.

- [ ] **Step 7: Update `docs/development.md` § Asserting what it does**

Add the shoot modes and correct any `tools/assert.sh` path to `tools/lib/assert.sh`.

- [ ] **Step 8: Verify no stale reference survives**

Run the grep from Step 1 again.
Expected: hits only inside `docs/superpowers/`, which is a record of what was decided and is not rewritten.

- [ ] **Step 9: Verify every documented command actually runs**

```bash
npm run preview -- --help
npm run e2e -- --help
```

Expected: the usage text matches what the docs claim, flag for flag.

- [ ] **Step 10: Commit**

```bash
git add README.md AGENTS.md docs/development.md
git commit -S -m "docs: document the session driver and the shoot modes

The two fast paths changed shape: preview.sh shows one state and is recalled to
change it, and every screenshot now comes out of the assertion suite."
```

---

## Final verification

- [ ] `npm test` — every unit test passes, including the new `test/devkit.test.js`.
- [ ] `shellcheck tools/*.sh tools/lib/*.sh` — silent.
- [ ] `npm run e2e` — all four groups pass, 48 tiles plus `overview.png` in `preview/`.
- [ ] `npm run a11y` — exits 0.
- [ ] `npm run preview -- --windowed --scenario=full`, recalled from a second terminal with `--light`, `--open` and `--scenario=error`, changes the window each time without restarting it; `--stop` closes it and empties the registry.
- [ ] `sha256sum ~/.config/dconf/user` and `gsettings get org.gnome.shell enabled-extensions | wc -c` match the values recorded before Task 1.
- [ ] `ls "${XDG_RUNTIME_DIR}/claude-quota"` is empty or absent — no session leaked.
