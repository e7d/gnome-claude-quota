# End-to-end harness — design

## TL;DR

- **What:** `tools/e2e.sh`, a nested-shell suite that asserts what the extension renders and how it reacts, and that emits the screenshots `npm run a11y` scores.
- **Key move:** assertions and screenshots are decoupled. An assertion is a property read over `Eval` (~0.3s); a screenshot is three `ScreenshotArea` calls, four settle sleeps and a `magick` smush (~6–8s). So every scenario is asserted, and only a colour-distinct subset is shot.
- **Shared tooling:** `preview.sh` splits into two libraries — `tools/indicator.sh` (drive the extension) and `tools/capture.sh` (turn a state into a PNG) — layered on the existing `tools/devkit.sh` exactly as `devkit.sh` is shared by `preview.sh` and `dev.sh` today.
- **Coverage:** state rendering, theme, hover/affordance, refresh behaviour, lifecycle.
- **CI:** the `preview` step becomes an `e2e` step; `a11y` follows unchanged and scores what e2e produced.
- **Out of scope:** golden per-scenario text (unit tests own that), visual regression diffing, `lib/usage.js` network behaviour.

## Context

`tools/devkit.sh` already isolates the session concern: it boots a throwaway nested GNOME shell, sandboxes dconf inside a private `dbus-run-session`, and exposes `shell_eval`, `wait_for_indicator`, `hide_overview`, `unwrap`, `stop_shell`. Both `dev.sh` and `preview.sh` source it and stay small.

`preview.sh` has since grown a second concern of its own — a scenario table, a state-injection layer, menu control and a virtual pointer — none of which is about screenshots. That layer is exactly what an assertion suite needs, so it is extracted rather than duplicated.

CI today runs `preview.sh` over six scenarios and then `a11y`. The screenshots are never uploaded, so the preview step only proves that six states render without throwing. Every assertion in this design is therefore new coverage, not a re-check.

## Layering

| File | Job | Sources | Needs |
| --- | --- | --- | --- |
| `tools/devkit.sh` | GNOME session lifecycle | — | gnome-shell, dbus-run-session, gdbus |
| `tools/indicator.sh` | drive the extension: scenarios, render, menus, pointer | devkit | — |
| `tools/capture.sh` | turn a rendered state into a PNG | indicator | magick |
| `tools/assert.sh` | assertions, counters, negative controls | — | — |
| `tools/preview.sh` | human driver: shoot the whole matrix | capture | — |
| `tools/e2e.sh` | assertion driver: assert all, shoot a subset | capture, assert | — |
| `tools/dev.sh` | interactive nested shell | devkit | — |

Each driver sources its libraries explicitly and in order, matching how `preview.sh` sources `devkit.sh` today. No double-source guards and no implicit chains, so `shellcheck -x` keeps resolving every path.

### What moves into `indicator.sh`

`SCENARIOS`, `QUOTA`, `service_status`, `setup_quotas`, `setup_for`, `render_state`, `open_menu`, `close_menu`, `freeze`, `set_theme`, `select_scenarios`, and `point_at`.

`point_at` is generalised. It currently hardcodes two targets by name; the primitive becomes `point_at_actor <js-expr>`, which moves the virtual pointer to the centre of whatever actor the expression resolves to, and `point_at pill|away` become two callers of it. e2e needs to point at popup rows, which have no name in the current form.

`render_state`, `open_menu` and `close_menu` each end in a `sleep 1` today. Those sleeps exist to let a frame paint before a screenshot, which is a capture concern, so they move to `capture()`. The state functions become synchronous and the assertion pass pays nothing for settling it does not need.

### What moves into `capture.sh`

`popup_box`, `panel_height`, `shoot`, `capture`, `normalize`, `overview`, the `OUT` path, and the `subset()` wipe rule as `prepare_out`.

`prepare_out` keeps today's behaviour: a full run clears `preview/*.png` first so the contact sheet and the contrast scan describe one run; a narrowed run leaves the other shots alone.

### What stays in `preview.sh`

Usage text, flag parsing, and the theme × scenario loop. Roughly 60 lines, down from 283. Its flags and its behaviour do not change.

## e2e.sh

One shell boot, two passes, then the artifacts.

### Pass 1 — state matrix

23 scenarios × 2 themes, asserted. No sleeps: `_render()` assigns label text synchronously, and this pass reads actor properties rather than pixels.

Per state, four assertions:

| Assertion | Catches |
| --- | --- |
| every visible `QuotaBlock` renders three non-empty rows — name/percent, bar, caption | the regression fixed in `803c5e6`, where an expired window hid its caption and the block lost a line |
| no rendered string contains `null`, `undefined` or `NaN` | a formatter returning a non-finite value into a template |
| block count equals the scenario's quota count | a model-scoped quota silently dropped |
| panel pill text matches the `percentLine` rule | the panel and the popup disagreeing |

A shape sweep, deliberately, not a golden string per scenario. `test/format.test.js` already pins exact output for these cases, and a second copy in bash would drift from it.

Theme coverage rides the same loop: for a state with a non-normal severity, the resolved severity colour is read in both schemes and asserted to differ and to match `theme.js`. Pixel-level contrast stays with `a11y`, which is the tool that measures it properly.

### Shot list

Nine scenarios are also captured, in both themes — 18 PNGs:

`normal`, `warning`, `critical`, `model-scoped`, `error`, `service-major`, `over-pace`, `rate-limited`, `no-data`.

The first six are today's CI set. The last three each contribute a colour combination nothing else in the set produces: the pace verdict (`theme.js` picks it independently of severity), the blocked-until row, and empty-state text on the popup card. The remaining fourteen scenarios add no colour a11y has not already scored — the five `service-*` states share one code path and differ by an emoji and a string.

The same list applies locally and in CI, so a green CI run means what a green local run means. `--scenario=` overrides it for the eyeball loop.

### Pass 2 — interaction

Theme-independent, so it runs once, after the matrix.

**Hover.** The rule: everything in the panel that is not a button has no hover.

| Actor | Assertion |
| --- | --- |
| the indicator | with the pointer on it, `hover`, style pseudo-class and background match `Main.panel.statusArea.quickSettings` under the same treatment — compared live, never against hardcoded colours |
| `_body`, `_message` | `track_hover === false`, and no `hover` or `active` pseudo-class with the pointer over them |
| `_issueItem` (the `Claude status` row) | `track_hover === true`, and it does take the hover pseudo-class — the positive case, or the suite passes trivially with every row dead |

**Refresh.** `freeze` stubs the instance's `_refresh`, so this group first deletes that own property to restore the prototype method, then stubs `_fetchCycle` with a promise that never resolves.

| Phase | Assertion |
| --- | --- |
| after `_refreshButton.emit('clicked')` | `menu.isOpen === true` — the button lives inside a `PopupBaseMenuItem` built with `activate: false`, and that is what keeps the menu open |
| during | `_refreshButton.child.get_transition('spin')` is non-null; `_refreshButton.reactive === false` |
| after restoring `_fetchCycle` and re-rendering | no `spin` transition, and `rotation_angle_z === 0` |

**Lifecycle.** Runs last: it destroys the indicator, and every earlier group needs one.

A reference to the live indicator is parked on `globalThis` before `Main.extensionManager.disableExtension(uuid)`, because the assertions are about the object the shell has let go of:

| After disable | After re-enable |
| --- | --- |
| `_timerId === null` | exactly one entry in `Main.panel.statusArea` for the uuid |
| `_destroyed === true` | `_timerId` non-null — one timer, not two |
| `_cancellable.is_cancelled() === true` | the parked pre-disable indicator is still destroyed |
| the uuid is gone from `Main.panel.statusArea` | |

GNOME caches an extension's modules for the life of the shell process, so a disable/enable cycle re-runs the *same* module's `disable()` and `enable()`. That is precisely the code under test here, so the cache is not a limitation for this group — it would be one only if the suite tried to reload edited source.

### Artifacts

After both passes: `normalize`, then `overview`. `npm run a11y` runs next and scores exactly the set e2e produced.

## Negative controls

Every assertion must be proven able to fail. `assert.sh` exposes:

```
prove <label> <break-js> <restore-js> <assertion-fn>
```

which runs the assertion (expects pass), injects the break through `shell_eval`, runs it again (expects **fail**), restores, and runs a third time (expects pass). Any other outcome aborts the suite immediately — a control that cannot fail, or that fails to restore, invalidates everything after it.

`extension.js` is never edited to stage a failure. Breaks are runtime mutations: `track_hover = true` on a display row, a blanked label, a removed block.

**Granularity: each distinct assertion is proven once, not once per state.** The matrix applies four assertion functions across 46 states; proving those four gives the same guarantee as proving them 184 times, at a fraction of the cost. Every interaction assertion is unique, so each is proven individually.

## Interface

```
tools/e2e.sh [--windowed] [--dark-only|--light-only] [--scenario=<name>]... [--group=<name>]...
```

`--group` selects among `state`, `hover`, `refresh`, `lifecycle`; default is all four. Screenshots belong to the `state` group, so a run that excludes it produces none and leaves `preview/` alone — `a11y` after such a run would score whatever was already there, which is why CI never narrows the groups. `--windowed` comes from `devkit_flag`, as in the other drivers. `DEVKIT_HEADLESS=1` is the default.

Output is one line per assertion — `ok <label>` or `FAIL <label>: expected X, got Y` — then a count. Exit status is non-zero if any assertion or any control failed. Verdicts key on exit status, never on matching output text.

`package.json` gains `"e2e": "tools/e2e.sh"`. `preview` stays.

## CI

The `preview` step becomes:

```yaml
- name: e2e
  run: docker exec "$C" npm run e2e
```

with no `--scenario` flags — the shot list is the script's own. The `a11y` step is unchanged and now scores 18 shots instead of 12. `magick` is already in the CI image and is still required, by `capture.sh`.

## Documentation

`README.md` § Development, `docs/development.md`, and `AGENTS.md` § Checking your work each gain e2e alongside the existing scripts. `TODO.md` is deleted once `tools/e2e.sh` lands, as its own line 3 instructs; `HANDOFF.md` is deleted with it, its work having landed in `803c5e6`, `9316876` and `694d2ab`.

## Risks

**Runtime.** Measured on the host at completion: **1m59s** for the full suite — 186 state assertions across 46 states, 20 more across the interaction groups, ten negative controls, and 18 screenshots. It is almost entirely settle-sleep bound, at 11s of user CPU, so the shot list is the dial to turn if it ever needs to shrink.

**Flake.** The capture path's settle sleeps are pre-existing and carried over unchanged. The assertion path adds none, so it adds no new flake surface.

**`Eval` ambiguity.** `Eval` answers `(false, '')` both when locked down and when the script is wrong. Anything but a `true` reply is treated as not-ready and never as data, via the existing `is_true`.

**Host safety.** Unchanged and non-negotiable: every dconf write stays inside the private `dbus-run-session`, and nested shells are killed by pid only. After a run, `enabled-extensions` on the host must be intact.
