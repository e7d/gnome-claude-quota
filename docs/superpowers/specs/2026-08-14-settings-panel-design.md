# Settings panel — design

**Date:** 2026-08-14
**Status:** designed

## Problem

The extension has a settings schema and no way to reach it. `feat/quota-notifications` landed four
GSettings keys deliberately, so the panel would be built over keys that already work — but until
something renders them, a user who wants a warning at 60% instead of 75% has to run `gsettings set`,
and a user who does not care about the weekly quota cannot get it out of the top bar at all.

Everything the panel could plausibly expose is not equally worth exposing. Two thirds of the original
TODO line turned out to describe settings GNOME already owns, and saying so is most of this design.

## Scope

A preferences window with two things in it: the thresholds that decide colour and notifications, and
which quotas appear on which surface. Ten keys, one `Adw.PreferencesPage`, no new subsystem in the
shell.

Out of scope, and each for a reason recorded below: a theme override, a language picker, a locale
picker, and per-quota thresholds.

## Decisions taken before design

- **No theme override.** Severity colours are chosen per scheme to clear 4.5:1 against the surfaces
  GNOME paints. Forcing `light` while the shell runs dark paints light-tuned amber on a dark bar —
  `npm run a11y` would fail it, and it would need a waiver-shaped hole in the contrast suite to ship.
  Auto-detection already follows `St.Settings` colour-scheme and foreground luminance; a wrong guess
  there is a bug in `lib/theme.js`, not a preference.
- **No language picker, no locale picker.** `LANG` / `LC_MESSAGES` / `LC_TIME` belong to the session,
  and GNOME Settings › Region & Language already exposes them. An extension rendering French beside
  an English clock is worse than one that follows its session, and the implementation would have cost
  a `.mo` parser of our own — `this.gettext` resolves through libintl, which reads the *shell's*
  locale, so the only alternatives were parsing catalogues ourselves or mutating the locale of the
  gnome-shell process. The harness has `--language` / `--locale` because it must fabricate a session,
  which is not the same as a user overriding one.
- **Thresholds are the definition of severity.** The endpoint's own `severity` field stops being
  read. One rule drives colour and notification alike: the user either lives with the shipped
  numbers or sets their own, and what they see always agrees with what they get told.
- **Defaults are 75 / 90, ours and not Anthropic's.** The endpoint's switch points cannot be
  measured from one sample — an observed `percent: 83` reads as `warning`, which bounds the warning
  point and does not locate it. Shipping guessed numbers as "Anthropic defaults" would be a claim we
  cannot support, so the reset button restores *our* defaults and the wording says so.
- **One threshold pair for every quota.** Per-quota thresholds triple the key count, add a second
  code path through severity and notifications, and answer a question nobody has asked yet. The
  schema can gain per-scope keys later without disturbing the global pair.
- **Visibility is per quota, and orthogonal to notifications.** A quota hidden from both surfaces
  still notifies if its threshold toggles say so — keeping weekly out of sight while still being
  told at 90% is arguably the best use of the feature. The alternative, where hidden implies silent,
  makes two switches that read *enabled* stop working, which is the shape of a bug.
- **One bucket for every model-scoped quota.** Settings keyed by model id (`weekly_scoped:claude-fable-5`)
  would accumulate dead dconf paths and silently revert to defaults the day Anthropic changes the
  model. One `scoped` bucket covers whatever the payload carries.
- **Stock rows only.** A row carrying two switches (top bar and menu on one line) was mocked and
  rejected: `Adw.ActionRow` + `add_suffix` is native API, but nothing in Adw means "two booleans", so
  the accessible labelling would depend on us adding it by hand, and GNOME's own Settings never does
  it. A real `Gtk.Grid` matrix — quotas as rows, knobs as columns — was rejected earlier for the same
  reason plus width behaviour.

## Settings

Ten keys, flat, in the existing `org.gnome.shell.extensions.claude-quota` schema. The four
`notify-*` keys currently on this branch are renamed into this set; they were never pushed, so there
is nothing to migrate.

| Key | Type | Default |
| --- | --- | --- |
| `warning-percent` | `i`, range 1–100 | `75` |
| `warning-notify` | `b` | `true` |
| `critical-percent` | `i`, range 1–100 | `90` |
| `critical-notify` | `b` | `true` |
| `session-in-bar` | `b` | `true` |
| `session-in-menu` | `b` | `true` |
| `weekly-in-bar` | `b` | `true` |
| `weekly-in-menu` | `b` | `true` |
| `scoped-in-bar` | `b` | `true` |
| `scoped-in-menu` | `b` | `true` |

`Gio.Settings.reset(key)` gives the default buttons their behaviour, so no default is written twice.

## New module: `lib/settings.js`

Gi-free, imported by `extension.js`, `prefs.js` and the tests, and the only place any of this is
written down:

- `SCOPES` — `[{id: 'session', name: N_('Session (5h)'), …}, {id: 'weekly', name: N_('Weekly')},
  {id: 'scoped', name: N_('Model-specific')}]`, each carrying its two visibility key names.
- `THRESHOLDS` — the two levels with their key names and defaults.
- `scopeOf(quota)` — `session` → `session`, `weekly_all` → `weekly`, anything `modelScoped` →
  `scoped`. Derived from the quota shape the model already produces, not from a second parse of the
  payload.
- `readSettings(get)` — takes a getter and returns one frozen object
  (`{warning: {percent, notify}, critical: {…}, visible: {session: {bar, menu}, …}}`). `extension.js`
  passes a closure over `Gio.Settings`; the tests pass a plain map.

`SCOPES` names are marked with `N_()` and resolved with `_()` at read time. A constant translated
where it is declared freezes English, because module scope is evaluated before `enable()` installs a
translator.

The scope names live here and nowhere else: `lib/model.js` drops its own `NAMES` map and reads them
from `SCOPES`, so the label in the popup and the label in the preferences window cannot disagree.
`SHORTS` stays in `model.js` — a panel initial is a rendering concern, not a setting.

## Severity moves to the thresholds

`lib/model.js` stops copying `limit.severity`, and `KNOWN_SEVERITIES` goes with it. `lib/policy.js`
gains:

```js
export function severityFor(percent, {warningPercent, criticalPercent})
```

Critical is tested first, so an inverted pair (warning 95, critical 80) degrades to "critical from
80 up" rather than leaving a band with no severity at all. The prefs adjustments clamp the pair so a
user cannot produce that state, and the function stays defensive anyway because dconf can be written
by hand.

Colour resolves at **render time**, from the quota's percentage and the current thresholds — not once
when the payload is parsed. That is what makes "lower the warning to 60 and the row repaints"
observable, and it is why the e2e harness can assert it.

`lib/notify.js` needs only the renamed keys: thresholds stay global, so `thresholdsFrom` keeps its
shape and the fired-state cache, hysteresis and alert keys are untouched.

## Visibility

`_render()` already derives everything from `markExpired(this._quotas, now)`. Two filters over that
list:

- `_renderPanel()` receives only quotas whose scope has `…-in-bar` — filtered **before** the
  responsive 3→2→1→icon fit, so hiding weekly gives the remaining cells more room instead of leaving
  a gap. All three hidden lands on the icon-only state that already exists.
- The popup blocks receive only quotas whose scope has `…-in-menu`. All three hidden needs one new
  string, because reusing the "no data" empty state would claim something false — the data is there
  and the user hid it.

A `changed::` connection per key re-renders; the four threshold keys additionally re-run
`_syncAlerts()`, as they do today.

## Preferences window

`prefs.js` (new), `ExtensionPreferences.fillPreferencesWindow`, one `Adw.PreferencesPage`, three
groups, every row stock:

1. **Thresholds** — `Adw.SpinRow` for high usage (1–100, `%` suffix) with a reset `Gtk.Button`
   suffix, insensitive while the value equals the default; `Adw.SwitchRow` for its notification; the
   same pair for critical. Adjustments clamp warning ≤ critical.
2. **Show in top bar** — three `Adw.SwitchRow`, one per scope.
3. **Show in menu** — three `Adw.SwitchRow`, one per scope.

Rows are generated from `SCOPES` and `THRESHOLDS`, so a key cannot exist in the UI and not in the
schema. Switches bind with `Gio.Settings.bind`; the spin rows bind their `value`.

The scoped row is labelled statically (*Model-specific*): prefs runs in its own process with no
payload and no access to the shell's state, so there is no live model name to put in a subtitle.

## Tooling

`npm run preview -- --prefs` opens the preferences window **inside** the devkit session —
`gnome-extensions prefs claude-quota@e7d.io` under that session's `DBUS_SESSION_BUS_ADDRESS` and
`HOME`, never the host's. With `--capture` it shoots `preview/prefs-<theme>.png`, cropped to the
window's own rect read back over `Eval` from `global.get_window_actors()` rather than shooting the
whole virtual monitor. `--prefs` is a fresh-session axis in `stale_axis()` terms only if the window
must be present at startup; it is not — it can be opened against a live session, which is what makes
it recallable like the other flags.

Driving Adw widgets from outside needs AT-SPI, so the prefs window earns a screenshot and no
assertions. What the settings *do* is asserted in the shell, where the harness already lives.

## Tests

- `test/settings.test.js` — `scopeOf` for all three kinds, `readSettings` shape, and that every key
  named in `SCOPES`/`THRESHOLDS` exists in the committed gschema XML (parsed, not hardcoded), which
  is the check that keeps the table and the schema from drifting.
- `test/policy.test.js` — `severityFor` at each boundary (74/75/89/90), the inverted pair, and a
  non-finite percentage.
- `test/model.test.js` — updated for the dropped `severity` field.
- `test/notify.test.js` — updated for the renamed keys.
- e2e `state` group — a scope hidden by dconf leaves the bar and leaves the menu; all three hidden
  from the menu shows the new empty string; lowering `warning-percent` under a normal quota's
  percentage repaints its row. Written into the nested session's private dconf, never the host's.
- `tools/lib/indicator.sh` — `q()` drops its `severity` argument, since severity now derives from
  the percentage. The existing scenario percentages already cross the defaults (21 normal, 94
  critical), so the fixtures keep their meaning.

## i18n

New msgids: the three scope names (already in `lib/model.js` for two of them, moving to
`lib/settings.js`), the two threshold row titles, the two notification row titles, the two group
titles, the reset button's tooltip, and the all-hidden empty state. `npm run i18n` regenerates the
catalog; French needs each of them, and `npm run i18n:check` fails until they are there. Strings
reached through `SCOPES` are invisible to `xgettext` unless the wrapper is named in `tools/i18n.sh`.

## Out of scope

Theme, language and locale overrides (see decisions). Per-quota thresholds. Notification sound.
Anything about service status or rate limiting, which have their own line in the popup and no
threshold to configure.
