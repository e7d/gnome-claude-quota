# Claude Quota — GNOME Shell extension design

## TL;DR

- **Verdict:** build a new GNOME Shell 50 extension from scratch. Four similar extensions are already installed on this machine; none is a base to fork.
- **What:** panel indicator reading `S 5% · W 37%` (plus `F 12%` when a scoped quota is non-zero), click for a popup recapping each quota's name, usage, reset time, and window progress.
- **Data:** `GET https://api.anthropic.com/api/oauth/usage`, bearer token read from `~/.claude/.credentials.json`. Read-only — never written back.
- **Key design move:** one `BarLevel` per quota with `overdriveStart = windowProgress`. The shell natively draws a tick at that point and paints the fill red past it, so "burning quota faster than the clock" is a color, not a calculation.
- **Shape:** ~240 lines across five files. Three of them are GI-free and unit-tested with `node --test`.
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
extension.js            St widgets, self-rescheduling poll, severity classes   ~160 lines
lib/usage.js            Soup request, token read, error + retry-after mapping    ~55
lib/model.js            limits[] → view model                                   ~40   GI-free
lib/format.js           durations, absolute times, window progress               ~30   GI-free
lib/policy.js           poll interval, backoff, staleness rules                  ~30   GI-free
stylesheet.css
icons/claude-quota.svg
test/model.test.js      node --test
test/format.test.js     node --test
test/policy.test.js     node --test
```

`model.js`, `format.js` and `policy.js` import nothing from `gi://`, so `node --test` runs them directly. They hold every piece of logic that can be silently wrong — quota selection, scoped-quota visibility, duration rendering, window arithmetic, and now the polling/backoff/staleness rules. The GI-touching layers stay thin enough to verify by eye in a live shell.

### View model

`model.js` maps `limits[]` to an ordered array, one entry per visible quota:

| Field | Value |
| --- | --- |
| `short` | `S` for session, `W` for weekly, otherwise the scope model's first letter — plus its second, third, … letter in lowercase, one at a time, for as long as the label still collides with one already assigned (`Sonnet` → `So`, `Fable` → `F`). If every letter of the name is exhausted and it still collides, a numeric suffix is appended instead (`S`, `S2`, `S3`, …) |
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

- 16px SVG asterisk, eight rays, drawn here — a generic glyph, not a reproduction of Anthropic's twelve-ray mark, which is their trademark and whose press-kit assets carry no reuse licence. Eight is also the count that stays legible at 16px; twelve renders as a blob.
- The file is `icons/claude-quota-symbolic.svg`, and the `-symbolic` suffix is load-bearing: St recolours symbolic icons with the actor's CSS `color`, which is what lets the extension pick the tint at runtime. `_renderPanel` reads the panel's resolved foreground colour and paints the icon `#d97757` over a dark bar (4.94:1) or `#c6613f` over a light one (4.05:1) — the top bar keeps its own background whatever the desktop scheme is, and an extension can repaint it, so the resolved foreground is the only honest answer to what the icon sits on. Dropping the suffix would pin the fill to whatever the SVG declares.
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
```

Each block is a vertical `St.BoxLayout`: name with right-aligned percentage, then the bar, then a dim caption. Nothing else — there is no legend.

An earlier version carried one (`tick: window elapsed · red: over pace`). It was cut because it is permanent furniture explaining a fact you learn once: red reads as "too fast" without being told, and the tick is a position marker you decode by watching it move. A popup that has to caption its own symbols is one symbol too clever or one caption too many; here it was the caption.

### The bar

`BarLevel` from `resource:///org/gnome/shell/ui/barLevel.js`, with `value = percent / 100`, `maximumValue = 1`, `overdriveStart = windowProgress`.

Its `vfunc_repaint` draws a separator whenever `overdriveStart !== maximumValue`, in the foreground colour while `value <= overdriveStart` and in the bar background colour past it — visible on both sides without intervention. Fill beyond the separator uses `-barlevel-overdrive-color`. The shipped theme declares that property (and `-barlevel-background-color`, `-barlevel-active-background-color`) only under `.slider` and `.osd-window .level` — `.barlevel`, the class `BarLevel` actually carries, has none of them. This extension declares its own `.cq-bar-dark` / `.cq-bar-light` rules mirroring the shipped theme's own `.slider` values per colour scheme (`#c01c28` dark, `#e01b24` light), since a single hardcoded red is not correct in both.

The result: the tick marks how far the window has run, and the bar turns red exactly when usage outruns it. No custom drawing, natively themed, accent-aware.

`overdriveStart` is omitted when `windowProgress` is `null`, which suppresses the tick.

`barLevel.js` is internal shell API, not a documented extension API — the single upstream coupling in this design. It has been stable across many releases and is roughly 30 lines of cairo to inline if it ever breaks.

The `overdrive-start` ParamSpec upstream is declared over `[1, 2]`, with a default of `1` — the property exists for volume-style over-amplification, where `1.0` is 100% and up to `2.0` is 200%. This extension drives it over `[0, 1]` instead (`windowProgress`), which is outside the range upstream itself exercises. The JS accessor's own setter only rejects a value greater than `maximumValue`, so nothing enforces the ParamSpec's stated minimum, and the paint math (which works in ratios of `value` / `maximumValue`) is unaffected by operating below `1`.

## Styling

No palette is invented. GNOME 50 exposes `-st-accent-color`, `-st-accent-fg-color`, and the `st-mix()` / `st-lighten()` / `st-transparentize()` functions to extension stylesheets, which covers light, dark, and the user's accent.

Dimming is actor opacity (180 of 255, ≈0.7 alpha) rather than a hardcoded `rgba()`, so it modulates whatever foreground the active theme provides instead of assuming a dark one. That also keeps captions clear of 4.5:1, where the 0.5 alpha used in places by the shipped theme would not.

Severity colours are the only literal values in the stylesheet, and they exist twice — `cq-warning-dark` / `cq-warning-light` — because no single amber clears 4.5:1 against both a dark and a light panel. The popup is not a descendant of the panel button in the actor tree, so the scheme is carried in the class name rather than by an ancestor class.

## States

| State | Panel | Popup |
| --- | --- | --- |
| First load | `✳ …` | `Loading…` |
| Loaded | percentages | quota blocks |
| Request failed, values cached | last known values retained | failure reason · `values from <time>` |
| `429`, values cached | last known values retained | `Rate limited — retrying at <time> · values from <time>` |
| `401` | last known values retained | `Token expired — run Claude Code once` (with `· values from <time>` once something has been cached) |
| Credentials unreadable | last known values retained (`✳ —` only if this happens before any poll has ever succeeded) | `Cannot read ~/.claude/.credentials.json` |
| Scoped quota at 0% | omitted | omitted |
| `resets_at: null`, percent > 0 | shown | bar without tick, no caption |
| Cached quota's window has rolled over (`resetsAt <= now`) | `—` | `—`, bar at 0 with no tick, no caption |

## Polling, backoff, and cached fallback

Measured against the live endpoint with the extension disabled: a `429` carries `retry-after: 119` (essentially two minutes), and 139 seconds of subsequent silence was enough for the same allowance to answer `200` again with real data. The original 60-second poll sits *inside* that window, so a single `429` used to be permanent — every following poll landed inside the retry window, re-armed it, and the popup showed the rate-limit message forever. Neighbouring Claude extensions installed on this machine poll at 300 s and 600 s against the same allowance, which is the evidence behind the new interval below.

`lib/policy.js` is GI-free and holds every rule:

- `POLL_SECONDS = 300` — the steady-state interval, comfortably outside the measured 119 s window.
- `OPEN_REFRESH_SECONDS = 60` — opening the popup only forces a refresh when the cached data is older than this; a popup opened seconds after a poll does not re-fetch.
- `nextPollSeconds(retryAfterSeconds)` — `POLL_SECONDS` normally, or `retryAfterSeconds + 5` when the server asks for longer. The 5-second margin exists because retrying exactly at the boundary re-burns the slot.
- `blockedUntil` / `isBlocked` — the block window derived from the same `retryAfterSeconds + 5`, checked before every fetch.
- `shouldFetchOnOpen` — false while blocked, true when there is no cached fetch yet, true once the cache is older than `OPEN_REFRESH_SECONDS`, false otherwise.
- `markExpired` — flags a cached quota whose `resetsAt` has rolled over, so a stale percentage from before a window reset is never shown as current.

`extension.js` drives a self-rescheduling one-shot timer (`_scheduleNext`, `GLib.timeout_add_seconds(GLib.PRIORITY_LOW, seconds, …)` returning `GLib.SOURCE_REMOVE`) instead of a fixed repeating interval, so the delay can change after every poll. `_refresh()` checks `isBlocked` first and skips the network entirely while inside a backoff window — this is the fix for the self-perpetuation, since a poll that never reaches the server can never re-arm the 429. On failure the previously fetched quotas stay on screen; only the message line changes, naming the time the cached values are from (and, while blocked, the time the next retry is due).

## Interaction

Click toggles the popup, re-renders immediately from cache, and only triggers a network refresh when `shouldFetchOnOpen` says the cache is stale and no backoff is in effect — so a popup opened right after a poll does not double-fetch, and one opened during a 429 backoff does not re-arm it. The background timer reschedules itself after every poll (300 s steady state, longer under backoff) and is removed in `disable()`. Captions are recomputed on each render, including renders driven purely by a popup open with no new fetch.

No buttons, no activatable rows, no scroll handling. Motion is whatever the shell already does when a popup opens.

## Formats

Relative durations: `3d 22h`, `4h 08m`, `12m`, `now` (at or past reset). Thresholds: days-and-hours above 24h, hours-and-minutes above 1h, minutes below.

Absolute times via `Intl.DateTimeFormat` in the system locale: `13:59` when the reset is today, `sam. 09:59` otherwise. Weekday rather than month because the longest window is 7 days, and the short form leaves the caption on one line.

## Accessibility

`BarLevel` registers a custom accessible exposing current and maximum value, so the bars are not silent to a screen reader. Every number also exists as text in the panel label and the percentage label. Contrast targets: 4.5:1 for captions, and the severity colours are selected per colour scheme for the same reason.

## Testing

`node --test` (bare, no path argument) over `lib/model.js`, `lib/format.js` and `lib/policy.js`:

- quota selection and ordering from a captured API response
- scoped quota hidden at 0%, shown above 0%
- `resets_at: null` yields `windowProgress: null`
- window progress for both window lengths, including a reset in the past
- duration rendering at each threshold boundary
- absolute time rendering for today and another day
- `nextPollSeconds` at, below, and above the steady-state interval, and with no retry-after
- `blockedUntil` / `isBlocked` around the boundary
- `shouldFetchOnOpen` for never-fetched, fresh, stale, and blocked cache states
- `markExpired` for a past, future, and null `resetsAt`, and non-mutation of its input

Fixtures come from a real captured response with identifying fields removed. `extension.js` and `lib/usage.js` are verified by running the extension in a live shell — a nested session (`dbus-run-session -- gnome-shell --nested --wayland`, or `--headless --wayland --virtual-monitor` on GNOME 50 where `--nested` was removed) makes that a fast loop.

## Out of scope

- **Preferences UI.** No `schemas/`, no `glib-compile-schemas` step, no `prefs.js`. Poll interval and visibility rules are constants. The Adw surface is the part most likely to need work at each GNOME release, and it buys nothing here.
- **gettext.** UI strings are inline English. Times and dates are locale-aware through `Intl`, which is where locale actually matters.
- **Token refresh.** See "Token handling".
