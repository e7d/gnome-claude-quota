# Claude Quota — GNOME Shell extension design

## TL;DR

- **Verdict:** build a new GNOME Shell 50 extension from scratch. Four similar extensions are already installed on this machine; none is a base to fork.
- **What:** panel indicator reading `S 5% · W 37%` (plus `F 12%` when a scoped quota is non-zero), click for a popup recapping each quota's name, usage, reset time, and window progress.
- **Data:** `GET https://api.anthropic.com/api/oauth/usage`, bearer token read from `~/.claude/.credentials.json`. Read-only — never written back.
- **Key design move:** one `BarLevel` per quota with `overdriveStart = windowProgress`. The shell natively draws a tick at that point and paints the fill red past it, so "burning quota faster than the clock" is a color, not a calculation.
- **Shape:** ~240 lines across four files. Two of them are GI-free and unit-tested with `node --test`.
- **Out of scope:** preferences UI, gettext, OAuth token refresh.

## Context

GNOME Shell 50.3, GJS 1.88 (ESM), `node` 24 available for tests. The repository was empty at design time.

Four comparable extensions are installed (`claude-quota@andrearicchi.com`, `claude-quota@zeppelinlg`, `claude-status@oakz.org`, `claude-usage@dvdstelt.github.io`). They established the data source, which this design reuses. Nothing else is carried over: the goal is a smaller, personal extension, not a fork.

## Data source

`GET https://api.anthropic.com/api/oauth/usage`

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <claudeAiOauth.accessToken>` from `~/.claude/.credentials.json` |
| `anthropic-beta` | `oauth-2025-04-20` |

The response carries a generic `limits[]` array, which is the only part this extension reads:

```json
{"kind": "session",        "group": "session", "percent": 5,  "severity": "normal", "resets_at": "2026-08-04T11:59:59Z", "scope": null}
{"kind": "weekly_all",     "group": "weekly",  "percent": 37, "severity": "normal", "resets_at": "2026-08-08T07:59:59Z", "scope": null}
{"kind": "weekly_scoped",  "group": "weekly",  "percent": 0,  "severity": "normal", "resets_at": null, "scope": {"model": {"display_name": "Fable"}}}
```

Top-level `five_hour` / `seven_day` objects duplicate the first two entries and are ignored — `limits[]` generalises to scoped quotas without per-model special-casing.

### Token handling

Read-only. The access token is read at each poll; a `401` surfaces as a message ("Token expired — run Claude Code once") and nothing is written.

The rejected alternative was the `refresh_token` grant with writeback to `~/.claude/.credentials.json`. Anthropic rotates refresh tokens on each use, so a refresh racing a running Claude Code can invalidate its copy of the credential. Staleness is recoverable in one command; a broken credential store is not.

### Window progress

Not provided by the API. Derived from `resets_at` and the window length implied by `kind`: 5 hours for `session`, 7 days for `weekly_*`.

```
windowProgress = 1 - (resetsAt - now) / windowLength
```

`resets_at: null` (which occurs on a scoped quota at 0%) yields no progress and no caption.

## Architecture

```
metadata.json
extension.js            St widgets, 60s timer, severity classes      ~120 lines
lib/usage.js            Soup request, token read, error mapping        ~50
lib/model.js            limits[] → view model                         ~40   GI-free
lib/format.js           durations, absolute times, window progress     ~30   GI-free
stylesheet.css
icons/claude-quota-symbolic.svg
test/model.test.js      node --test
test/format.test.js     node --test
```

`model.js` and `format.js` import nothing from `gi://`, so `node --test` runs them directly. They hold every piece of logic that can be silently wrong — quota selection, scoped-quota visibility, duration rendering, window arithmetic. The GI-touching layers stay thin enough to verify by eye in a live shell.

### View model

`model.js` maps `limits[]` to an ordered array, one entry per visible quota:

| Field | Value |
| --- | --- |
| `short` | `S` for session, `W` for weekly, otherwise the scope model's first letter — plus its second letter in lowercase when the first would collide with `S` or `W` (`Sonnet` → `So`, `Fable` → `F`) |
| `name` | `Session`, `Weekly`, or the scope model's display name |
| `percent` | 0–100 |
| `severity` | `normal` \| `warning` \| `critical` — any other value the API returns is treated as `normal` |
| `resetsAt` | `Date` or `null` |
| `windowProgress` | 0–1, or `null` when `resetsAt` is `null` |

Visibility rule: `session` and `weekly_all` always render. Any other entry renders only when `percent > 0`.

## Top bar

```
✳ S 5% · W 37%
```

One `St.Label` per quota inside a horizontal `St.BoxLayout`, separated by dim `·` labels. Per-quota labels rather than one concatenated string, because severity colours one quota at a time.

- 16px symbolic SVG asterisk, recoloured by the theme like any other panel icon.
- No attempt at tabular figures. Cantarell's digits are already uniform width, so the only width change comes from a digit being added (9% → 10%), which no font feature fixes. GNOME's own clock behaves the same way.
- Severity: `normal` inherits the panel foreground; `warning` and `critical` apply a class. Both colours are chosen per colour scheme, read from `St.Settings.colorScheme` — no single amber clears 4.5:1 against both a dark and a light panel.

## Popup

Width ~280px, one block per visible quota. Blocks are separated by spacing rather than separator items — with at most three blocks, rules add weight without adding structure.

```
  Session                      5%
  ▓▓▓░░░╵░░░░░░░░░░░░░░░░░░░░░░░░
  4h 08m left · 13:59

  Weekly                      37%
  ▓▓▓▓▓▓▓▓▓▓▓╵▓░░░░░░░░░░░░░░░░░░
  3d 22h left · sam. 09:59

  tick: window elapsed · red: over pace
```

Each block is a vertical `St.BoxLayout`: name with right-aligned percentage, then the bar, then a dim caption. One legend line for the whole popup, not per block.

### The bar

`BarLevel` from `resource:///org/gnome/shell/ui/barLevel.js`, with `value = percent / 100`, `maximumValue = 1`, `overdriveStart = windowProgress`.

Its `vfunc_repaint` draws a separator whenever `overdriveStart !== maximumValue`, in the foreground colour while `value <= overdriveStart` and in the bar background colour past it — visible on both sides without intervention. Fill beyond the separator uses `-barlevel-overdrive-color` (`#c01c28` in the shipped theme).

The result: the tick marks how far the window has run, and the bar turns red exactly when usage outruns it. No custom drawing, natively themed, accent-aware.

`overdriveStart` is omitted when `windowProgress` is `null`, which suppresses the tick.

`barLevel.js` is internal shell API, not a documented extension API — the single upstream coupling in this design. It has been stable across many releases and is roughly 30 lines of cairo to inline if it ever breaks.

## Styling

No palette is invented. GNOME 50 exposes `-st-accent-color`, `-st-accent-fg-color`, and the `st-mix()` / `st-lighten()` / `st-transparentize()` functions to extension stylesheets, which covers light, dark, and the user's accent.

Dimming is actor opacity (180 of 255, ≈0.7 alpha) rather than a hardcoded `rgba()`, so it modulates whatever foreground the active theme provides instead of assuming a dark one. That also keeps captions clear of 4.5:1, where the 0.5 alpha used in places by the shipped theme would not.

Severity colours are the only literal values in the stylesheet, and they exist twice — `cq-warning-dark` / `cq-warning-light` — because no single amber clears 4.5:1 against both a dark and a light panel. The popup is not a descendant of the panel button in the actor tree, so the scheme is carried in the class name rather than by an ancestor class.

## States

| State | Panel | Popup |
| --- | --- | --- |
| First load | `✳ …` | `Loading…` |
| Loaded | percentages | quota blocks |
| Request failed | last known values retained | the failure reason |
| `401` | last known values retained | `Token expired — run Claude Code once` |
| Credentials unreadable | `✳ —` | `Cannot read ~/.claude/.credentials.json` |
| Scoped quota at 0% | omitted | omitted |
| `resets_at: null`, percent > 0 | shown | bar without tick, no caption |

## Interaction

Click toggles the popup and triggers an immediate refresh, so an open popup is never a minute stale. A 60-second `GLib.timeout_add_seconds` at low priority drives the rest, and is removed in `disable()`. Captions are recomputed on each poll and on open — no second timer for clock drift.

No buttons, no activatable rows, no scroll handling. Motion is whatever the shell already does when a popup opens.

## Formats

Relative durations: `3d 22h`, `4h 08m`, `12m`, `now` (at or past reset). Thresholds: days-and-hours above 24h, hours-and-minutes above 1h, minutes below.

Absolute times via `Intl.DateTimeFormat` in the system locale: `13:59` when the reset is today, `sam. 09:59` otherwise. Weekday rather than month because the longest window is 7 days, and the short form leaves the caption on one line.

## Accessibility

`BarLevel` registers a custom accessible exposing current and maximum value, so the bars are not silent to a screen reader. Every number also exists as text in the panel label and the percentage label. Contrast targets: 4.5:1 for captions, and the severity colours are selected per colour scheme for the same reason.

## Testing

`node --test test/` over `lib/model.js` and `lib/format.js`:

- quota selection and ordering from a captured API response
- scoped quota hidden at 0%, shown above 0%
- `resets_at: null` yields `windowProgress: null`
- window progress for both window lengths, including a reset in the past
- duration rendering at each threshold boundary
- absolute time rendering for today and another day

Fixtures come from a real captured response with identifying fields removed. `extension.js` and `lib/usage.js` are verified by running the extension in a live shell — a nested session (`dbus-run-session -- gnome-shell --nested --wayland`) makes that a fast loop.

## Out of scope

- **Preferences UI.** No `schemas/`, no `glib-compile-schemas` step, no `prefs.js`. Poll interval and visibility rules are constants. The Adw surface is the part most likely to need work at each GNOME release, and it buys nothing here.
- **gettext.** UI strings are inline English. Times and dates are locale-aware through `Intl`, which is where locale actually matters.
- **Token refresh.** See "Token handling".
