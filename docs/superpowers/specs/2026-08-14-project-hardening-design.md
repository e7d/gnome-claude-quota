# Project hardening — design

Date: 2026-08-14
Branch: `chore/project-hardening`

Four items, one branch: split `extension.js`, make the coverage real and enforced,
make CI run on GitHub as well as Forgejo, and give an agent a map of the codebase.

## Why now

`extension.js` is 1099 lines. `Indicator` alone is roughly 930 of them and carries
seven concerns: actor construction, cache and attempts file IO, credential watching,
notification lifecycle, fetch and scheduling, panel fitting, and rendering.

The measured coverage picture is not what "add test coverage" usually means here:

```
lib/*.js        100.00 line   96.75 branch   99.13 funcs
tools/lib/*.js  100.00 line
```

Every module a test imports is fully covered. The gap is which modules a test can
reach at all — `extension.js` and `lib/usage.js` never appear in the report, because
nothing imports them. So coverage is not gained by writing more tests against the
same modules; it is gained by moving logic out of `extension.js` into `lib/`, where
the Node test runner can reach it. The refactor and the coverage item are one job.

`lib/usage.js` stays out by design: it wraps Soup and Gio, and `AGENTS.md` already
names it the deliberate exception.

## Architecture

Three layers, and the rule that separates them is unchanged: **`lib/` must stay free
of `gi://`**, because the Node test runner imports it alongside the shell.

```
lib/      pure       imported by node --test AND by the shell
ui/       shell      GObject classes and Gio/St wrappers, e2e-covered
extension.js         construction, wiring, render orchestration, teardown
```

### New pure modules

| module | lifted from | contract |
| --- | --- | --- |
| `lib/style.js` | `severityClass`, `quotaClass`, `barClass`, `panelScheme` | style-class string builders |
| `lib/state.js` | `_applyResult`, the decision half of `_adoptShared`, `_markSent` | `(state, result, now) → {state, effects}` |
| `lib/view.js` | decision halves of `_renderMessage`, `_renderActions`, `_renderIssue`, `_panelLabels`, `_renderHiddenNote` | `(state, settings, now) → view model` |

`lib/state.js` is the largest single win. `_applyResult` is thirty lines of rate-limit,
block-reason and streak branching with no shell dependency at all, and today not one
line of it is reachable from a test. It becomes a reducer returning the next state
plus an effects record — `{schedule, save, syncAlerts}` — which the caller performs.
The reducer decides; the Indicator acts.

`lib/view.js` returns text, visibility flags and class names. It constructs no actors
and imports no `gi://`. `ui/popup-body.js` and `ui/panel-fit.js` consume it.

### New shell modules

| module | owns |
| --- | --- |
| `ui/pace-bar.js` | `PaceBar` |
| `ui/quota-block.js` | `QuotaBlock`, `displayItem` |
| `ui/popup-body.js` | the popup's menu items; `update(viewModel)` |
| `ui/panel-fit.js` | panel cells, budget measurement, fit, laters, panel signals |
| `ui/store.js` | cache and attempts file IO |
| `ui/alerts.js` | notification source, post/withdraw/rewrite, the minute timer |
| `ui/poller.js` | fetch cycle, cancellable, poll timer, credential watching |

`ui/popup-body.js` follows the shape `QuotaBlock` already uses: a widget that owns its
actors and takes one `update({...})` call. That is what makes a view model the whole
interface between the pure layer and the actors.

### What `extension.js` keeps

Construction, the collaborator wiring, `_render()` as orchestration, `_onDestroy`, and
`ClaudeQuotaExtension`. Target is 300 lines or fewer.

Rendering stays one-way, exactly as `AGENTS.md` requires: state fields are the truth,
`_render()` derives a view model from them, and hands it to the widgets. No actor is
mutated outside a render path.

## Data flow

```
poller ── result ──► lib/state.js reducer ──► state + effects
                                              │
                          effects.save ───────┼──► ui/store.js
                          effects.syncAlerts ─┼──► ui/alerts.js
                          effects.schedule ───┘

_render() ── state + settings + now ──► lib/view.js ──► view model
                                                        │
                                        ┌───────────────┴──────────────┐
                                        ▼                              ▼
                                 ui/popup-body.js               ui/panel-fit.js
```

## Coverage gate

```
npm run coverage
  node --test --experimental-test-coverage
       --test-coverage-lines=100
       --test-coverage-branches=95
       --test-coverage-functions=100
```

Thresholds alone are not a check. **A module with no test does not appear in the
coverage report and therefore passes every threshold** — which is precisely the
failure this repo has today. So the gate also censuses `lib/*.js` against the report
and fails on any file missing from it. `lib/usage.js` is the single declared
exclusion, named in the gate rather than silently absent.

The census gets one deliberately-inverted run: add an untested module, confirm the
gate fires, remove it. A check that has never failed is not known to be a check.

## CI

`.github/workflows/ci.yml` is Forgejo-only today. It logs in to `git.lan.e7d.io`,
pulls a cached CI image or builds and pushes one, and uses `secrets.REGISTRY_TOKEN`.
A GitHub runner cannot reach that LAN host and does not hold that secret.

The fix keeps the file byte-identical across both forges:

- `login` runs only when `github.server_url != 'https://github.com'`
- the image step pulls-or-builds everywhere, but pushes only where the registry is
  reachable
- every later step is unchanged, so the two forges run the same checks
- a `coverage` step is added after `test`

Forgejo is unreachable until 2026-08-15, so the GitHub half is validated now by
pushing the branch to the `github` remote and reading the Actions run. The Forgejo
half is the unchanged path and is re-validated when the host returns.

## Documentation

`docs/architecture.md`, new: the module map, the render data flow, per-module
invariants, and a "where do I add X" table. `AGENTS.md` gains one index line pointing
at it, and `README.md` § Development gains one for `npm run coverage`.

This follows the tiering already in force in this setup — an index stays resident, the
detail is read when its topic is in play. The map does not restate rules that
`AGENTS.md` already carries; it points at them.

## Testing

Each slice ends on `npm test && npm run lint && npm run e2e`.

New pure modules ship with their tests in the same commit. The `ui/` extractions carry
no new unit tests by design — they are `gi://`-bound — and are covered by the existing
e2e suite.

## Risks

**`extension.js` has no unit tests, so the e2e suite is the entire net under this
refactor.** It is a good net — 31 scenarios shot in both themes, every assertion proven
able to fail on every run — but it is the only one. The 337 unit tests protect `lib/`,
which is exactly the code this refactor is *adding to*, not the code it is moving.
Slices stay small and each is verified before the next begins.

**Moving `_()` calls into `ui/` is invisible to `xgettext` until `tools/i18n.sh` names
the new paths.** `npm run i18n:check` is blind to an empty `msgstr`, so a missed path
does not fail the check — it ships an English string. `tools/i18n.sh` is updated in the
same slice as the first `ui/` file, and the catalog diff is read rather than assumed.

**A new top-level directory has consumers beyond the shell.** `.oxlintrc.json`,
`tools/i18n.sh`, and any e2e `Eval` probe that reaches into `extension.js` internals
must be checked for path assumptions before the first `ui/` file lands.

## Order

1. CI portability, validated against GitHub Actions
2. `lib/style.js`, `lib/view.js` and their tests
3. `lib/state.js` and its tests
4. `ui/pace-bar.js`, `ui/quota-block.js`, `ui/popup-body.js`
5. `ui/store.js`, `ui/alerts.js`, `ui/poller.js`, `ui/panel-fit.js`
6. Coverage gate, with its inverted run
7. `docs/architecture.md` and the index lines

## Out of scope

The TODO entry on panel bar colours — Claude-themed, GNOME accent, or custom — is a
feature with its own contrast and accessibility consequences. It is not part of this
branch.
