# Tooling: preview.sh as the Dev Kit session driver

- **Date:** 2026-08-11
- **What:** `tools/preview.sh` stops being the screenshot matrix and becomes the one thing that owns a nested Mutter Dev Kit session and sets the shape of the extension inside it. Recalling it against a running session changes that shape live.
- **Why:** three entrypoints each start their own throwaway shell and each carry their own copy of "put the extension into state X". Nothing can reshape a session that is already up, so looking at a second state means killing the window and paying the whole boot again.
- **Consumers:** the assertion suite (`tools/e2e.sh`) drives its session through the same CLI, and absorbs the screenshot grid the old `preview.sh` produced. `tools/dev.sh` disappears into `preview.sh`.

## Shape of the tooling

Scripts that are sourced rather than run move under `tools/lib/`, so the top of `tools/` lists only things a human or an npm script invokes.

```
tools/
  preview.sh  e2e.sh  a11y.sh                    entrypoints
  a11y.js  quota-attribution.js                  entrypoints (node)
  lib/
    devkit.sh  indicator.sh  capture.sh  assert.sh
    contrast.js  attribution.js
```

| Path | Job | Depends on |
| --- | --- | --- |
| `lib/devkit.sh` | session lifecycle, registry, `attach_session`, `shell_eval` | gnome-shell, dbus-run-session, gdbus |
| `lib/indicator.sh` | `SCENARIOS`, `render_state`, pointer, `freeze` | devkit |
| `lib/capture.sh` | `shoot`, `normalize`, `overview` | devkit, magick |
| `lib/assert.sh` | assertions, counters, negative controls | — |
| `preview.sh` | own a session; set its shape; shoot one tile | devkit, indicator, capture |
| `e2e.sh` | assert the grid, shoot as much of it as asked | preview.sh, devkit, capture, assert |
| `a11y.sh` | score the contrast of whatever is in `preview/` | a11y.js |

`tools/contrast.js` and `tools/attribution.js` are imported and never run, so they move too. `a11y.js` and `quota-attribution.js` stay at the top: both are entrypoints, one behind `a11y.sh`, one behind `npm run attribution`.

## Session registry

Today each script's `RUN` is a private `mktemp -d`, which is why nothing can find a session it did not start. `RUN` becomes:

```
$XDG_RUNTIME_DIR/claude-quota/<session>/{bus,pid,log,state}
```

`state` records the shape currently applied — theme, scenario-or-live, popup, backend — so `--watch` can replay it after a restart. Sessions are isolated by name, so a grid run and the window you are watching coexist; the same name twice attaches rather than starting a second shell. A directory whose pid is dead is stale and is reaped on the next start.

`attach_session <name>` is the new devkit entry point for a caller that wants `shell_eval` against a session someone else started: read `bus`, assert the pid is alive, export `DBUS_SESSION_BUS_ADDRESS`.

## preview.sh

```
tools/preview.sh [options]

  --session=<name>        default 'preview'
  --windowed | --headless default windowed
  --dark | --light        omit for the GNOME default
  --scenario=<name>       fabricated state; implies freeze
  --live                  real data; implies unfreeze (default)
  --close | --hover | --open   popup state, default --close
  --capture               shoot a tile of the shape just applied
  --watch                 restart on source change, replay the recorded shape
  --detach                start and return instead of blocking
  --stop                  tear the session down
  -h, --help
```

**An omitted flag leaves that dimension alone on a recall.** `preview.sh --light` repaints and touches nothing else. On a fresh start, omitted flags take the defaults above. This rule is what makes the recall loop worth having, and it is why the shape is recorded rather than recomputed.

`--scenario` and `--live` are the same dimension and are mutually exclusive; passing both is an error. `--scenario` stubs the instance's `_refresh` exactly as `freeze` does today, because a real poll must never answer over a fabricated state. `--live` deletes that stub.

### Capturing

`--capture` writes the canonical three-state tile — resting, hovered, then pressed with the popup open, smushed vertically — to `preview/<theme>-<scenario>.png`, because that tile is what `preview/` holds and what `a11y.sh` scores. It therefore drives its own close → hover → open cycle internally, and a `--close`/`--hover`/`--open` given in the same call is applied *after* the shot, leaving the session in the shape that was asked for.

The filename falls out of the recorded shape: `dark-error.png`, `light-live.png`, `default-normal.png` when no theme is forced. The path is printed on stdout, which is how a caller in another process collects tiles for `normalize` and `overview`.

The measure-then-shoot discipline in `lib/capture.sh` is unchanged, including re-measuring the popup after the menu has repositioned itself and refusing to shoot when the box moved between measuring and shooting.

### Backend

The backend is chosen at `gnome-shell` exec — `--devkit` against `--headless --virtual-monitor` — so it cannot change on a live session. A recall that names the other backend restarts the shell inside that session and replays the recorded shape, and says so; a silent restart would read as a hang.

`DEVKIT_MONITOR` goes from `1280x800` to `1440x900`. At the smaller size the panel ellipsizes as soon as three quotas are active — `S 5… · W 4… · F 1%` — so the harness truncates the very thing it exists to show. The headless backend takes the size straight from `--virtual-monitor`; whether the devkit window honours it is unverified and is a task in the plan, since `--devkit` brings its own window and takes no size argument.

### Lifecycle

Starting: `require_install`, reap a stale registry directory, `isolate_dconf`, `start_shell`, `wait_for_indicator`, `hide_overview`, apply the shape, then block. Ctrl-C tears the session down through the existing EXIT trap, so no orphan nested shell is possible from an interactive run.

Recalling: read the registry, assert the pid is alive, export the bus, apply only the named dimensions, return. With no session and no `--stop`, a recall starts one. `--stop` against no session is a no-op that exits 0.

`--detach` starts and returns, handing cleanup to the caller, whose own EXIT trap must `--stop`. That is how `e2e.sh` uses it.

`--watch` moves `signature()` over from `dev.sh` unchanged, empty-list guard included. A change restarts the shell — never a disable/enable cycle, which re-runs the cached module — and replays the recorded shape.

## e2e.sh absorbs the grid

The old `preview.sh` grid and the `state` group of `e2e.sh` are the same loop over theme × scenario, differing only in which scenarios they shoot — and that was already a variable, the hardcoded `SHOOT` array. They become one tool. Assertion failures do not abort the run (`assert.sh` counts and `assert_summary` exits non-zero at the end), so a grid run still produces every artifact even when something fails, which was the only real argument for keeping them apart. The gain is that nothing lands in `preview/` — and therefore nothing reaches `a11y.sh` — without having been asserted.

`SHOOT` becomes a flag, and shooting everything is the default:

```
tools/e2e.sh              assert every scenario, shoot every scenario
tools/e2e.sh --a11y       shoot only the subset a11y.sh scores
tools/e2e.sh --assert     shoot nothing, leave preview/ alone
```

Shooting everything by default makes a bare `npm run e2e` cost what the old full `npm run preview` cost — minutes rather than the two it takes today — so the documented fast path while iterating becomes a narrowed run (`--group=`, `--scenario=`, `--dark-only`) or `--assert` when only behaviour is in question.

Every other flag keeps its present meaning: `--dark-only`, `--light-only`, `--scenario=<name>` (repeatable), `--group=<name>` (repeatable), `--headless`/`--windowed`. Subset semantics are unchanged — screenshots a run did not shoot are left alone, and `overview.png` montages only what that run shot.

It keeps every group, assertion and negative control it has. What changes is that it no longer starts or drives the shell itself:

```bash
tools/preview.sh --session=e2e --headless --detach       # EXIT trap: --stop
attach_session e2e
for theme; for scenario:
    shot=$(tools/preview.sh --session=e2e --$theme --scenario=$scenario --capture)
    assert_state "$theme-$scenario"
normalize; overview
```

One exec per state change, against several seconds of settle time per capture. The `hover`, `refresh` and `lifecycle` groups drive popup and pointer state through `preview.sh` where a flag covers it, and keep their own `shell_eval` probes where none does — those need the attached session directly, which `preview.sh` does not abstract and should not.

## npm scripts

```json
"dev":       "tools/preview.sh --windowed",
"dev:watch": "tools/preview.sh --windowed --watch",
"preview":   "tools/preview.sh",
"e2e":       "tools/e2e.sh",
"a11y":      "tools/a11y.sh"
```

`dev.sh` is deleted; `npm run dev` and `dev:watch` survive as aliases so muscle memory and the docs hold. The visual fast path becomes `npm run preview -- --dark --scenario=X` for a window and `npm run e2e -- --dark-only --scenario=X` for an asserted screenshot.

## Mechanical fallout

- `shellcheck source=` directives repoint at `tools/lib/`.
- `test/assert.test.js` resolves `../tools/lib/assert.sh`; `test/contrast.test.js` and `test/attribution.test.js` import from `../tools/lib/`.
- `a11y.js` and `quota-attribution.js` import their libraries from `./lib/`.
- `AGENTS.md` § Shape of the code gains a `tools/lib/` row; § Checking your work is rewritten around the two fast paths, and § Things that will bite you loses its `dev.sh` reference.
- `README.md` § Development and `docs/development.md` re-document the three entrypoints and their flags.

## Verification

`npm run e2e` is the real proof: it exercises start, per-scenario shape, capture and teardown through the new path, and every one of its assertions is proven able to fail on each run. Alongside it:

- `shellcheck` over every file in `tools/` and `tools/lib/`.
- `npm test`, which covers the moved JS libraries and `assert.sh`.
- `npm run e2e -- --dark-only --scenario=normal` for the partial-overview path, and `--assert` for the shoot-nothing path.
- By hand: `npm run preview -- --windowed --scenario=full`, then a recall from a second terminal (`--light`, `--open`, `--scenario=error`) confirming the window changes without restarting; then `--stop`.
- After every run, the host session is intact: `sha256sum ~/.config/dconf/user` unchanged and `gsettings get org.gnome.shell enabled-extensions` unchanged in length.

## Out of scope

- Changing what any scenario renders, or adding scenarios.
- Changing assertions, groups or controls in `e2e.sh` beyond how it obtains a session and sets state.
- `a11y.sh` and the contrast scoring.
- Any change to `extension.js` or `lib/`.
