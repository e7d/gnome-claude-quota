# Architecture

A map of the module set, for an agent that needs to know where something lives or where
something new belongs, before it starts editing. Read [`AGENTS.md`](../AGENTS.md) first —
this file only carries the detail that index points at.

## The three layers

| Layer | Runs in | Rule |
| --- | --- | --- |
| `lib/*.js` | GNOME Shell **and** `node --test` | Pure logic, no actors, no signals. |
| `ui/*.js` | GNOME Shell only | Actors and widgets. Each module owns one piece of the shell surface and renders from arguments it is given, never from its own polling. |
| `extension.js`, `prefs.js` | GNOME Shell (two separate processes) | Wiring. `extension.js` owns the indicator's state and its signals to the shell; `prefs.js` is the separate preferences-window process and only reads `lib/settings.js` — it holds no state of its own. |

Every `lib/` module must stay free of `gi://` imports, with one deliberate exception:
`lib/usage.js` wraps Soup and Gio for HTTP, and is consequently the one module with no
unit tests. The full rationale — and why a decision belongs in `lib/policy.js` instead of
growing inside `usage.js` — is in `AGENTS.md` § Shape of the code.

`ui/panel-fit.js`'s `panelScheme()` is **not** `extension.js`'s `this._scheme`. `_scheme`
is the desktop style variant (`Main.getStyleVariant()`); `panelScheme()` reads the top
bar's own resolved foreground colour, because the top bar keeps its own background
whatever the desktop scheme does. `_render()` reads both and hands each to the widget
that needs it — never treat them as the same input.

The e2e harness (`tools/e2e.sh`) reaches past the `ui/` modules' public methods and reads
private members by name over `Eval` — `Alerts._live`/`_source`, `PanelStrip._cells`/
`_budget`/`_box`, `Poller._cancellable`/`_timerId`, `PopupBody._blocks`/`_body`/
`_issueItem` and others, across all five `ui/*.js` modules. There is no interface boundary
protecting these from the test suite: renaming any private field or method inside `ui/`
is an e2e-breaking change, and `npm run e2e` is the only way to find out.

## Module map

| Module | Owns | Depends on | Tested |
| --- | --- | --- | --- |
| `lib/attempts.js` | The attempts-log record shape and its bounded parse/append | — | `test/attempts.test.js` |
| `lib/bar.js` | Pace-bar tick geometry | — | `test/bar.test.js` |
| `lib/cache.js` | `usage.json` (de)serialization | — | `test/cache.test.js` |
| `lib/catalog.js` | Reading a compiled `.mo` catalog and its `Plural-Forms` rule into a translator | — | `test/catalog.test.js` |
| `lib/credentials.js` | Parsing `.credentials.json`, expiry and renewal checks | — | `test/credentials.test.js` |
| `lib/ellipsis.js` | Shortening an email address to a width, keeping its domain | — | `test/ellipsis.test.js` |
| `lib/errors.js` | Turning a fetch error into a displayable description | `lib/i18n.js` | `test/errors.test.js` |
| `lib/format.js` | Every rendered string that isn't a static label: times, percentages, window progress | `lib/i18n.js` | `test/format.test.js` |
| `lib/i18n.js` | The `_`/`n_`/`p_`/`N_` translator indirection | — | `test/i18n.test.js` |
| `lib/language.js` | The Language setting's choices, their order, and installing the translator it selects | `lib/catalog.js`, `lib/i18n.js` | `test/language.test.js` |
| `lib/model.js` | Turning a usage payload into quota view objects and the Claude Code service status | `lib/format.js`, `lib/i18n.js`, `lib/settings.js` | `test/model.test.js` |
| `lib/notify.js` | Threshold crossing and the withdraw/post plan for notifications | `lib/format.js`, `lib/i18n.js` | `test/notify.test.js` |
| `lib/panel.js` | How many cells fit the panel's available width | — | `test/panel.test.js` |
| `lib/plan.js` | Turning the plan and rate-limit tier Claude Code stores into a display name | — | `test/plan.test.js` |
| `lib/policy.js` | Poll timing, rate-limit backoff, blocking, severity thresholds | `lib/i18n.js` | `test/policy.test.js` |
| `lib/settings.js` | The gschema key list and reading it into a typed settings object | `lib/i18n.js` | `test/settings.test.js` |
| `lib/shared-usage.js` | Reading Claude Code's own cached usage file, and the account email and plan beside it | `lib/plan.js` | `test/shared-usage.test.js` |
| `lib/state.js` | The state/effects reducer: `applyResult`, `adoptShared` | `lib/model.js`, `lib/policy.js`, `lib/shared-usage.js` | `test/state.test.js` |
| `lib/style.js` | CSS class names for a given severity/scheme | — | `test/style.test.js` |
| `lib/theme.js` | Luminance → scheme, scheme → brand colour | — | `test/theme.test.js` |
| `lib/usage.js` | The HTTP client and credentials/shared-usage file paths | `lib/credentials.js`, `lib/errors.js`, `lib/model.js`, `lib/shared-usage.js`, `gi://` | none (exempt, see above) |
| `lib/view.js` | Deriving the popup and panel view models from state | `lib/errors.js`, `lib/format.js`, `lib/i18n.js`, `lib/policy.js`, `lib/style.js` | `test/view.test.js` |
| `ui/alerts.js` | The notification lifecycle: posting, updating and withdrawing via `MessageTray` | `lib/i18n.js`, `lib/notify.js` | e2e (`notify` group) |
| `ui/catalog-files.js` | Listing the shipped catalogs and reading one; runs in the preferences process too | `gi://` | e2e (`language` group) |
| `ui/pace-bar.js` | The `BarLevel` subclass that draws the pace tick | `lib/bar.js` | e2e (`state`, `panel` groups) |
| `ui/panel-fit.js` | `panelScheme()`; `PanelStrip`, which fits panel cells to available width and repaints on panel-geometry changes | `lib/panel.js`, `lib/theme.js` | e2e (`panel`, `hover` groups) |
| `ui/poller.js` | Scheduling fetches, watching the credentials file, recording every attempt | `lib/attempts.js`, `lib/state.js`, `lib/usage.js` | e2e (`refresh` group) |
| `ui/popup-body.js` | The popup menu's body: header, account, plan, message, blocks, refresh button | `ui/quota-block.js` | e2e (`state`, `hover` groups) |
| `ui/quota-block.js` | One quota row in the popup, including its `PaceBar` | `lib/format.js`, `lib/style.js`, `ui/pace-bar.js` | e2e (`state` group) |
| `ui/store.js` | Reading and writing `usage.json` and `attempts.jsonl` | `lib/attempts.js`, `lib/cache.js` | e2e (`refresh`, `lifecycle` groups) |
| `extension.js` | The `Indicator` actor: state fields, `_render()`, wiring every `lib/` and `ui/` module together | all of the above | e2e (all groups) |
| `prefs.js` | The preferences window | `lib/i18n.js`, `lib/language.js`, `lib/settings.js`, `ui/catalog-files.js` | e2e (`state` group: the live language switch; `preview.sh --prefs`) |

`tools/` and `tools/lib/*` are a separate, dev-only layer — entrypoints and their shared
libraries, covered by `test/devkit.test.js`, `test/assert.test.js`, `test/attribution.test.js`,
`test/contrast.test.js`, `test/log-view.test.js` and `test/coverage-census.test.js`. They are
described in `AGENTS.md` § Shape of the code and `docs/development.md`, not repeated here.

`schemas/gschemas.compiled` is a committed build artifact of the XML beside it, because the
checkout is what a user installs and the shell reads the compiled file rather than the source.
`test/schema.test.js` recompiles the XML into a temporary directory and compares the bytes, so
an edit nobody ran `glib-compile-schemas` over fails the suite instead of changing only the
review.

## The render path

`extension.js` holds the truth as state fields on `Indicator` (`_quotas`, `_limits`,
`_error`, `_service`, `_block`, `_refreshing`, `_fetchedAt`, `_fired`, `_lastRequestAt`,
`_rateLimitStreak`, `_seenExpiry`). `_render()` is the only path from that state to the
screen:

```
state fields  →  lib/view.js (popupView / panelView)  →  view model  →  ui/ widgets
```

`popupView()` and `panelView()` take the state plus the two scheme values (`_scheme` for
the popup, `panelScheme()` for the panel — see above) and return plain objects: strings,
booleans, CSS class names. `ui/popup-body.js` and `ui/panel-fit.js` consume that view
model and update actors; they hold no policy of their own. `AGENTS.md` § Shape of the code
states the one-way rule this enforces — never mutate an actor outside `_render()`.

## Where to add X

Each row names the files in the order you touch them.

| Adding | Files, in order |
| --- | --- |
| A new quota field | `lib/model.js` (`quotas()`, from the payload's `limit.*`) → `lib/state.js` if it changes what the reducer carries → `lib/view.js` (into the view model) → `ui/quota-block.js` and/or `ui/panel-fit.js` (render it) → `test/model.test.js`, `test/view.test.js` → a scenario in the `tools/lib/` scenario table (`indicator.sh`) if no existing one exercises it |
| A new user-facing string | The `lib/` or `ui/` module where it is read with `_()`/`n_()`/`p_()`/`N_()` (already covered by the `lib/*.js`/`ui/*.js` globs in `tools/i18n.sh`) → `npm run i18n` to update `po/claude-quota.pot` and `po/fr.po` and recompile `locale/fr/LC_MESSAGES/claude-quota.mo` → commit all three. If the string instead lives in a file outside `lib/`, `ui/`, `extension.js` or `prefs.js`, add that path to the `extract()` call in `tools/i18n.sh` **first** — `npm run i18n:check` only diffs a fresh extraction against the committed catalog using that same file list, so a path missing from it produces a clean check with the string silently untranslated. |
| A new setting | `schemas/org.gnome.shell.extensions.claude-quota.gschema.xml` (add the key) → `glib-compile-schemas schemas/` to regenerate the committed `gschemas.compiled` (no npm script does this, but `test/schema.test.js` fails if you forget — the shell reads the compiled file, not the XML) → `lib/settings.js` (`SCOPES`/`THRESHOLDS`/`KEYS` or a new export, and `readSettings()`) → `prefs.js` (the control) → `extension.js` if it needs its own read path beyond `_settingsValues()` → `test/settings.test.js` |
| A new panel/popup state (e.g. a service issue or severity tier) | `lib/policy.js` (the condition, e.g. `serviceIssue()`/`severityFor()`) → `lib/style.js` if it needs a new CSS class name → `stylesheet.css` (the class) → `lib/view.js` (surface it in the view model) → `test/policy.test.js`, `test/style.test.js`, `test/view.test.js` → a scenario in the `tools/lib/` scenario table (`indicator.sh`: `SCENARIOS` and a `setup_for` case) → `npm run a11y`'s ten-scenario list in `docs/development.md` / README if the new state introduces a colour worth scoring |
| A new e2e scenario | the `tools/lib/` scenario table (`indicator.sh`: `SCENARIOS` array and a `setup_for` case) → `tools/e2e.sh` (assign it to a group, add the assertion) → `README.md` § Development if the total scenario count is quoted there |

## Verifying this file

```bash
grep -ohE '(lib|ui|tools|test|docs)/[a-z0-9./-]+\.(js|md|sh)' docs/architecture.md \
  | sort -u | while read -r f; do [ -e "$f" ] || echo "MISSING: $f"; done
```

Expected: no output. Run it after any edit to the tables above — a path this file names
that does not exist is worse than no documentation at all.

To verify the check can detect a missing path, run this control command separately:

```bash
[ -e nonexistent.js ] || echo 'control ok: the check can report a missing path'
```

Expected: `control ok: the check can report a missing path`. A path check that cannot match
anything looks identical to one that passed, so this control proves the check has real failure
mode.
