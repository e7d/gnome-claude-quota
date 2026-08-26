# Code review — 2026-08-26

A full-repository review at `f223758` (`main`, clean tree): shipped code, tooling, tests,
documentation, i18n, accessibility, security and CI. Read as a record: every finding names
the file, the failure it produces, and the fix.

**Every finding was then fixed on `fix/code-review-2026-08-26`.** The findings below are kept
in the words they were first written in — a record of what the code did, not of what it does
now — and § Outcome says what happened to each. Where a fix differs from what the finding
proposed, the Outcome row says so and why.

## Verdict

This is a well-built repository. The layering rule (`lib/` pure, `ui/` actors, `extension.js`
wiring) is real rather than aspirational, the unit suite is honest about what it proves, and
the e2e harness proves every assertion can fail before trusting it — which is rarer than it
should be and is the single thing most worth protecting here.

One defect is worth fixing today: a malformed `resets_at` reaching `quotas()` throws a
`RangeError` out of `enable()`, and because the value can arrive from the on-disk cache the
extension stays broken across restarts. Everything else is robustness, prevention or
housekeeping.

| Severity | Count |
| --- | --- |
| High | 1 |
| Medium | 6 |
| Low | 10 |

## Outcome

| # | Status | What was done |
| --- | --- | --- |
| H1 | fixed | `resetInstant()` in `lib/model.js` returns `null` for an unparsable reset. Three tests in `test/model.test.js`: the guard, the KO half asserting `captionLine` and `alertPlan` really do throw on an Invalid Date, and the round trip. Inversion run: reverting the guard fails 2 of them, restoring it passes 34/34. |
| M1 | fixed, and widened | `_perform` arms the timer before the side effects, and `_settle()` catches a throw past the request, logs it, arms the next poll and lets `_refreshing` clear. Two guards were added beyond the finding, because H1's severity came from *where* it threw rather than from the date: `_syncAlerts` now wraps `_planAlerts` the way `_renderSafely` wraps `_render`, and `_loadCache` discards a cache it cannot adopt instead of failing `enable()`. |
| M2 | fixed | `_statusRound()` in `ui/poller.js` arms the next round in every outcome that is neither destroyed nor superseded, errors included. |
| M3 | fixed | `window._settings` holds the `Gio.Settings` for the window's lifetime. |
| M4 | fixed | `test/schema.test.js` recompiles the XML into a temp directory and compares bytes, with a control proving the comparison can tell a stale artifact from a current one. Modelled on what `tools/i18n.sh` already does for the `.mo`. |
| M5 | fixed | `AGENTS.md` § Shape of the code gains rows for `ui/*.js` and `prefs.js`, and `extension.js` is described as wiring rather than as the only file allowed to touch the shell. |
| M6 | fixed, by a different route than proposed | The finding proposed async I/O; the fix keeps it synchronous and makes it *O(1)* instead — `Gio.File.append_to` writes one line, and the whole-file trim runs on one append in two hundred and on the first of each session, which also heals a torn line. Async would have introduced write ordering the e2e log assertions depend on. |
| L1 | fixed | The locale listing is stubbed inside the test, so it asserts the loose-comparison property on any host instead of on one that generates `en_US`. Nothing is skipped any more, and it grew a paired refusal case. |
| L2 | fixed, and replaced | The `>= 26` floor is gone. The test now scans the shipped `.js` files it discovers on disk for `_`/`N_`/`n_`/`p_`/`describe`/`fail` call sites and requires every one in the template — the file list is discovered rather than copied from `tools/i18n.sh`, which is the one list that cannot report its own omission. Inversion run: renaming one msgid in the `.pot` fails it. |
| L3 | fixed | The waiver now requires both halves — a transient pill background **and** a severity ink, read from `stylesheet.css` by a new `severityInks()` rather than copied beside the waiver — and each accepted pair is printed with the ratio it was let through at. Inversion run: repainting `.cq-critical-light` surfaces 10 findings that were previously waived. |
| L4 | fixed, minus the base-image pin | `permissions: contents: read`, a `concurrency` group, and `actions/checkout` pinned to `11d5960a…` (verified to be the commit `v4` resolves to on **both** github.com and data.forgejo.org, so the workflow stays byte-identical across the two). The rolling `archlinux:base` is deliberately left rolling — running against the GNOME the distribution ships today is the point of the image — and a `toolchain` step now records the versions a run was measured against, which is the honest fix for drift you have chosen to keep. |
| L5 | fixed | `LICENSE` (GPL-2.0-or-later, the canonical FSF text), `"license"` in `package.json`, `url` in `metadata.json`, and a § License in the README. `version` stays at `1` on the owner's call: nothing has been published to extensions.gnome.org, so there is no upload to increment past. |
| L6 | fixed | `default_runtime_root()` falls back to `/tmp/claude-quota-$(id -u)`, and `claim_session` refuses a runtime root it does not own before chmod-ing it to 700. Three tests cover both branches and the refusal. |
| L7 | fixed | `_render()` reads the settings once and hands them down; `_planAlerts` computes `markExpired` once. |
| L8 | fixed | `.superpowers/policy-fix-report.md` untracked, and `.superpowers/` added to `.gitignore`. |
| L9 | documented, deliberately not changed | Stripping only the wrapping quotes would change what every `probe` in `tools/e2e.sh` returns, and the suite compares against the current shape by design — `schema_default` already carries a note working around it. The behaviour is a convention, so it is now stated as one at the definition, including the consequence: a value whose own text contains a quote is indistinguishable from one that does not. |
| L10 | fixed | `state_set` uses `if`/`else` with an explicit `|| true` on the filtering `grep`. |

Verification after the fixes, all green: `npm run lint`, `npm test` (398 passed, **0 skipped** — was 385 with 1 skipped), `npm run coverage` (`lib/**` 100.00 / 99.36 / 100.00, census clean), `npm run i18n:check`, `shellcheck -x`, the `docs/architecture.md` path check, `npm run e2e -- --a11y` (**641 passed, 0 failed**, 43 assertions proved able to fail on the way) and `npm run a11y` (0 findings under threshold). The nested run spent nothing — `attempts.jsonl` stayed at 2000 lines — and the host session was untouched: the dconf database fingerprint and the length of `enabled-extensions` were identical before and after.

## What was verified, and how

Claims below rest on runs, not on reading.

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `npm run lint` | clean, exit 0 |
| Unit suite | `npm test` | 384 passed, 0 failed, **1 skipped** |
| Coverage | `npm run coverage` | `lib/**` 100.00 lines / 99.35 branches / 100.00 functions; census clean |
| Catalog | `npm run i18n:check` | clean; `msgattrib --untranslated po/fr.po` returns nothing |
| Shell | `shellcheck -x tools/*.sh tools/lib/*.sh` | clean |
| Doc paths | the `grep`/`[ -e ]` check in `docs/architecture.md` § Verifying this file | no output, and the stated control fires |
| Schema artifact | recompiled the XML in a scratch directory and `cmp`'d it against `schemas/gschemas.compiled` | identical — in sync *today* |

Not run *during the review*: `npm run e2e` and `npm run a11y`. Both need a nested shell and
minutes of wall clock, and neither was needed to reach any finding below. Both were run after
the fixes, which is where the `ui/**` changes (M2, M6) were actually proven — see § Outcome.

## High

### H1 — A malformed `resets_at` crashes `enable()`, and the cache makes it stick

`lib/model.js:84` builds `resetsAt` with `new Date(limit.resets_at)` and never checks the
result. An unparsable value yields an Invalid Date, which is an object and therefore truthy,
so every downstream guard (`!quota.resetsAt`, `quota.resetsAt !== null`) lets it through to
`Intl.DateTimeFormat` and `toISOString()`, both of which throw.

Proven directly:

```
captionLine THREW: RangeError Invalid time value
alertPlan  THREW: RangeError Invalid time value
```

for a payload of `{kind: 'session', percent: 80, group: 'session', resets_at: 'not-a-date'}`.

Why it is high rather than theoretical:

- The limits array is stored and reloaded **verbatim**. `lib/cache.js:30` checks only
  `Array.isArray(data.limits)`; no element is validated. `lib/shared-usage.js:26-28` does the
  same for `~/.claude.json`, a file written by another program entirely.
- `extension.js:100` calls `_loadCache()` from `_init`, which calls `_syncAlerts()`, which
  calls `alertPlan()`. That path is **not** wrapped — `_renderSafely` guards `_render`, not
  this. A throw there propagates out of `enable()`.
- The bad value is on disk, so restarting the shell replays it. The only recovery a user has
  is deleting `~/.cache/claude-quota/usage.json`, which nothing tells them to do.

`maintenanceEnd()` at `lib/model.js:63` already filters `Number.isNaN(end.getTime())` for
exactly this reason, so the missing guard reads as an oversight rather than a decision.

**Fix.** Make `quotas()` yield `null` for an unparsable reset, which every consumer already
handles:

```js
const parsed = limit.resets_at ? new Date(limit.resets_at) : null;
const resetsAt = parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed : null;
```

**Tests it needs.** `test/model.test.js` has no malformed-date case at all — the only
`resets_at` values in the suite are well-formed strings and `null`. Add the pair: a limit with
an unparsable reset renders a `-` caption and plans no alert (passes after the fix, throws
before it), which is the inversion this file's own standards ask for.

## Medium

### M1 — One throw in the result path stops the extension permanently

`extension.js:257-263`:

```js
this._refreshing = true;
this._renderSafely();
const current = await this._poller.refresh(trigger);
if (this._destroyed || !current)
    return;
this._refreshing = false;
```

`Poller.refresh()` calls `_onResult` synchronously, which reaches `_applyResult` →
`_perform` → `_syncAlerts` → `Alerts.sync` → `MessageTray`. A throw anywhere in that chain
rejects the await, and two things follow at once:

1. `_refreshing` stays `true` forever. The spinner never stops and `refreshEnabled`
   (`lib/view.js:49`) keeps the refresh button disabled, so the user cannot retry by hand.
2. `_perform` runs in the order `save → syncAlerts → schedule` (`extension.js:200-207`), so a
   throw in `syncAlerts` skips `schedule` — **no next poll is ever armed**. The indicator goes
   silent with a spinning icon.

H1 is one concrete way to enter this state; it is not the only one, since everything past the
await is shell API.

**Fix.** Two independent changes, both small: wrap the await in `try { … } finally {
this._refreshing = false; this._renderSafely(); }`, and move `schedule` to the top of
`_perform` so the poll cadence survives a failing side effect.

### M2 — Status polling never recovers from a single error

`ui/poller.js:182-185`:

```js
}).catch(error => {
    this._statusPolling = false;
    logError(error);
});
```

The success branch calls `_scheduleStatus()`; the catch branch does not. One throw and the
service-status badge is dead for the life of the shell session, with nothing on screen saying
so — the classic shape this repository already guards against elsewhere: a component that has
stopped and one that has nothing to report look identical.

The same holds for the supersede branch at line 178-179, which returns without rearming.

**Fix.** Re-arm in `finally`, guarded on `_destroyed`, rather than in the success branch only.

### M3 — `prefs.js` does not retain its `Gio.Settings`

`prefs.js:79` binds several rows to a `settings` object that is referenced only by closures the
settings object itself owns — a cycle GJS is free to collect. When it does, every
`settings.bind()` stops updating and the preferences window silently ignores the user. GNOME's
own preferences template holds the reference on the window for this reason.

**Fix.** `window._settings = this.getSettings();` and use that.

### M4 — Nothing checks that `gschemas.compiled` matches its XML

The checkout is what a user installs, so `schemas/gschemas.compiled` is committed. It is
currently in sync (verified above), but that is luck, not a property: `docs/architecture.md:95`
asks the author to remember `glib-compile-schemas`, and no script or test enforces it. Forget
it and the shell reads the previous defaults while the XML in review shows the new ones.

The contrast is instructive — the *identical* problem for `locale/**/*.mo` is fully solved:
`tools/i18n.sh:50-56` recompiles into a temp directory and `cmp`s against the committed
artifact. Apply the same shape to the schema, either in `npm test` or as a CI step.

### M5 — `AGENTS.md` describes a shape the code no longer has

`AGENTS.md` § Shape of the code has no row for `ui/*.js` (five modules, ~670 lines) and none for
`prefs.js`, and still asserts of `extension.js`: *"The only file allowed to touch the shell."*
Every `ui/` module imports `gi://` and `resource:///org/gnome/shell/…`, so the rule as written
forbids the current architecture.

`docs/architecture.md` is correct and complete on this — including the warning that e2e reads
`ui/` private members by name. The drift is only in the index, which is the file an agent reads
first and the one that decides where new code goes.

**Fix.** Add the two rows and restate the rule as the three-layer one `docs/architecture.md:9-13`
already carries.

### M6 — The attempts log is rewritten whole, synchronously, on the compositor thread

`ui/store.js:50-63` reads `attempts.jsonl` in full, appends one line, trims to
`MAX_RECORDS = 2000` and writes the whole file back — with `load_contents`/`replace_contents`,
both synchronous, on GNOME Shell's main loop. At a steady state of 2000 records the file is a
few hundred kilobytes, and this happens on every attempt including every 60-second status poll.

It is not a correctness bug and the write is guarded, but blocking file I/O in the compositor
is the thing extension reviewers look for, and the cost grows with the log rather than staying
flat.

**Fix.** Either append with `Gio.OutputStream` in `APPEND` mode and compact only when the file
exceeds a size, or move the read/write to the `_async` variants. The bounded-append logic in
`lib/attempts.js` stays as it is.

## Low

| # | Where | Finding |
| --- | --- | --- |
| L1 | `test/devkit.test.js:176` | `test.skip` with `// TODO: broken on forgejo actions, to fix` and no ticket. It is skipped everywhere, including hosts where it would pass. Gate it on `locale -a` listing the locale it needs, so it runs where it can instead of nowhere. |
| L2 | `test/po.test.js:34` | The template floor is `>= 26` msgids against an actual 39. Thirteen strings could vanish from the catalog with the test still green. Track the count, or raise the floor whenever it moves. |
| L3 | `tools/a11y.js:43-52`, `66-67` | The contrast waiver matches on **background only**, ±12 per channel, so any ink on a near-pill surface is accepted regardless of its own ratio — a critical red on the hover pill would be waived silently. The run also prints only `, N accepted`, not which pairs, while `AGENTS.md` describes it as "printing what it accepted". Key the waiver on the ink/background pair, and list the accepted findings. |
| L4 | `.github/workflows/ci.yml` | No `permissions:` block (the job runs with the default token scope), `actions/checkout@v4` is a moving tag rather than a SHA, `archlinux:base` is rolling while the image cache key is the Dockerfile hash — so two runs of the same commit can install different `gnome-shell` versions under the same tag — and there is no `concurrency` group. |
| L5 | repository root, `metadata.json`, `package.json` | No `LICENSE`, no `license` field, no `url` in `metadata.json`, and `"version": 1` has never been bumped across the whole history. All four block a clean extensions.gnome.org submission and the first one blocks anyone reusing the code. |
| L6 | `tools/lib/devkit.sh:6` | `RUNTIME_ROOT` falls back to `/tmp/claude-quota` when `XDG_RUNTIME_DIR` is unset. On a shared host that is a predictable path another user can pre-create; the lock and the sandbox home both live under it. Dev-only, but `mkdir -p` on an attacker-supplied symlink is the whole pattern. |
| L7 | `extension.js:296`, `304`, `148-169` | `_render()` calls `_settingsValues()` three times (once in `_quotaViews`, once per `_visibleOn`), each a full ten-key GSettings read, and `_syncAlerts` computes `markExpired(this._quotas, now)` twice over the same inputs. Read once and pass it down. |
| L8 | `.superpowers/policy-fix-report.md` | Tracked in git, while the rest of `.superpowers/` is ignored. It is a session artifact, not project content. |
| L9 | `tools/lib/devkit.sh:404-406` | `unwrap` ends in `tr -d '"'`, stripping **every** quote from the payload rather than the wrapping pair. Any `Eval` result containing a quote comes back silently mangled, and the caller cannot tell. |
| L10 | `tools/lib/devkit.sh:126` | `[ -f "$STATE_FILE" ] && grep -v "^$1=" … > "$kept" \|\| : > "$kept"` — the `A && B \|\| C` shape means a `grep` that legitimately matches nothing runs the truncation branch. Harmless today because that case is already empty, but it is one edit away from losing state; `if`/`else` costs nothing. |

## Area assessments

**Architecture.** The three layers hold. `lib/` is genuinely free of `gi://` except the one
documented exception, which is why the unit suite can be as large as it is. `lib/state.js` as a
state-and-effects reducer is the right call and pays for itself in `test/state.test.js`. The
one-way render rule is respected throughout — I found no actor mutated outside a render path.
`_block` and `_service` as single objects rather than field pairs is a small decision that
keeps `_render` honest.

The one structural fragility is stated plainly in `docs/architecture.md:26-31` and needs no
finding: e2e reads `ui/` privates by name, so any rename inside `ui/` is an e2e-breaking change
discoverable only by running e2e.

**Code quality.** Functions are small and named for what they answer. Comments are almost
entirely WHY, and several of them are load-bearing — `lib/notify.js:29-32` (the endpoint
recomputes `resets_at` per response, hence minute-grained window keys) and `ui/alerts.js:76-79`
(assigning `datetime` is what cancels the shell's re-stamp idle) both record findings that
would cost hours to rediscover. `lib/policy.js:41-43` explains a real production incident in
three lines. This is the standard the rest of the repository should be measured against, and it
mostly meets it.

Immutability is consistent (`toSorted`, spreads, `Object.freeze` in `lib/settings.js`). No
`any`-equivalent laxity; guards are explicit. `eqeqeq` is enforced and clean.

**Tests.** 384 unit tests, `lib/**` at 100/99.35/100, and `tools/coverage-census.js` closes the
gap that percentage alone leaves — a module the suite never imports has no record and therefore
cannot fail a threshold. That census is the difference between a coverage number and a coverage
claim.

Two honest caveats, both already documented: the figure covers 17 of 18 `lib/` modules
(`lib/usage.js` is exempt and untested), and `ui/**`, `extension.js` and `prefs.js` have no
unit coverage at all — e2e is their only proof. That places real weight on `npm run e2e`, and
`ui/poller.js` (221 lines, the densest branching outside `lib/`) is the module most exposed by
it.

The e2e harness deserves its own line. `prove()` in `tools/lib/assert.sh:66-73` runs each
assertion clean, breaks the thing, requires the assertion to fail, restores, and requires it to
pass again — on every run, for every assertion, with a distinct `❌ control` channel so a dead
assertion cannot read as a passing one. That is the correct answer to "a check that cannot fire
looks exactly like a check with nothing to report", and it is implemented rather than aspired to.

**Tooling.** `tools/lib/devkit.sh` is careful in the places that matter: kill by pid not by
name, `flock` on a lock file deliberately outside the reaped directory, `dbus-run-session` for
dconf isolation with a comment explaining that `XDG_CONFIG_HOME` alone does not sandbox it, and
a sandbox `HOME` with no credentials so a nested session cannot spend a request. `stale_axis()`
solving "a flag that only takes effect on a fresh shell is silently dropped on an attached one"
is a subtle bug caught and then made structurally impossible.

**Documentation.** Unusually good, and unusually verifiable — `docs/architecture.md:99-117`
ships its own path-existence check *and* the control proving that check can fail. README (360
lines) is genuinely user-facing; `docs/development.md` (329) is genuinely contributor-facing;
the split holds. The single defect is M5, in the index rather than the detail.

`TODO.md` is a strength, not a leftover: its second entry records that CI has never actually
executed anywhere, and its third records a measurement (2026-08-15, GNOME 50.4) showing why an
assertion was deliberately *not* added. Both are the kind of thing that usually evaporates.

**i18n.** The `N_()`-at-declaration / `_()`-at-read discipline is correct and the reason
`SERVICE_ISSUES` and `NAMES` are not frozen to English. `npm run i18n:check` diffs a fresh
extraction against the committed `.pot` *and* recompiles the `.mo` for comparison, so a stale
binary artifact cannot pass. `test/po.test.js` covers what the standalone check structurally
cannot see — an empty `msgstr`, a lost placeholder, a plural-form count that disagrees with the
header. French is fully translated (0 untranslated, 0 fuzzy). Only L2 weakens it.

**Accessibility.** Contrast is scored mechanically against captured pixels, not asserted from
theory, and the tick is scored from the stylesheet itself. The judgement encoded in
`tools/a11y.js` — score against the surfaces a reader rests on, not against a transient pressed
pill, because darkening amber past 4.5:1 destroys the meaning the colour carries — is the right
trade and is written down. L3 is about the shape of the waiver, not the principle.

**Security.** Nothing exploitable found. Specifically checked and clean:

- The OAuth token is read from `~/.claude/.credentials.json`, used once as a `Bearer` header
  (`lib/usage.js:91`) and never stored, logged or passed anywhere else. `npm run logs` cannot
  print it — there is no code path that could.
- The attempts log is deny-by-default on headers (`lib/attempts.js:6-11`: an allowlist of four
  names plus three rate-limit prefixes) with an explicit comment that an allowlist cannot leak
  the header nobody thought of. Response bodies are logged only for failures and capped at 1000
  characters.
- `~/.claude.json` is read-only, as `AGENTS.md` requires, and the account-id check in
  `lib/shared-usage.js:5-9` correctly refuses another account's cached numbers.
- `tools/quota-attribution.js` stats transcript files and never opens them; `readdirSync`
  with `withFileTypes` does not follow symlinks, so the recursion cannot be trapped.
- The nested shell runs `--unsafe-mode` (`tools/lib/devkit.sh:275`), which is required for the
  `Eval` the harness depends on and is confined to a throwaway session with its own bus, `HOME`
  and dconf database. Correct trade, correctly fenced.
- CI pipes the registry token through `--password-stdin`; it never reaches argv.

The residual items are L4 (workflow hardening) and L6 (the `/tmp` fallback). Both are
prevention, not exposure.

**CI.** The container approach is sound — a real GNOME Shell with a logind stub, so e2e and
a11y run for real rather than being skipped — and the gate order (lint, shellcheck, test,
coverage, e2e, a11y) fails cheap before it fails slow. `TODO.md` already records that it has
never executed anywhere; until it has, "the workflow is correct" is a reading of the YAML, not
an observation. Getting one `workflow_dispatch` run green is worth more than any change
suggested in L4.

## What is still open

Everything in this review is closed. Two things it touched are not:

- **CI has still never executed anywhere.** `TODO.md` has said so since the workflow was made
  forge-portable, and hardening it (L4) did not change that. `on: push` is scoped to `main`, so
  pushing this branch triggers nothing — the branch needs a PR or a manual `workflow_dispatch`
  before "the workflow is correct" is an observation rather than a reading of the YAML.
- **`ui/**` still has no unit coverage**, by design, so `npm run e2e` remains the only thing
  that would catch a rename inside it. M2 and M6 both landed in `ui/`, and both were proven by
  that suite rather than by the unit tests.
