# Rate-limit backoff + cached fallback — implementation report

## Root cause (given, not re-investigated)

60 s poll interval landed inside the endpoint's own `retry-after: 119` window, so a single
`429` re-armed the block on every subsequent poll, plus every popup open fetched with no
throttle — a transient limit became permanent, and the popup blanked to the failure message
forever.

## What was built

### `lib/policy.js` (new, GI-free)

- `POLL_SECONDS = 300`, `OPEN_REFRESH_SECONDS = 60`.
- `nextPollSeconds(retryAfterSeconds)` — `POLL_SECONDS` on null/0/undefined, otherwise
  `Math.max(POLL_SECONDS, Math.ceil(retryAfterSeconds) + 5)`.
- `blockedUntil(retryAfterSeconds, now)` — `Date` at `now + ceil(retryAfterSeconds) + 5` s, or
  `null` without a retry-after.
- `isBlocked(until, now)` — `until instanceof Date && until > now`.
- `shouldFetchOnOpen(fetchedAt, now, until)` — false while blocked; true if never fetched;
  otherwise true only once the cache is older than `OPEN_REFRESH_SECONDS`.
- `markExpired(quotas, now)` — returns a new array, each entry gaining `expired: true` when it
  has a `resetsAt <= now`, `false` otherwise (including `resetsAt === null`), without mutating
  the input.

### `lib/usage.js`

On `429`, now throws `new Error('Rate limited')` with a numeric `.retryAfter` (or `null` if the
`retry-after` header is absent/unparseable), read via
`message.get_response_headers().get_one('retry-after')`. Every other error string is unchanged.

### `extension.js`

- Fixed repeating `GLib.timeout_add_seconds` replaced by a self-rescheduling one-shot:
  `_scheduleNext(seconds)` removes any existing source and arms a new
  `GLib.timeout_add_seconds(GLib.PRIORITY_LOW, seconds, …)` returning `GLib.SOURCE_REMOVE`.
- New state: `_fetchedAt` (Date, set only on a successful fetch) and `_blockedUntil`.
- `_refresh()` checks `isBlocked(this._blockedUntil, now)` first. While blocked it **skips the
  network entirely**, reschedules for when the block lifts, and re-renders — this is the fix
  for the self-perpetuating loop.
- Success: clears `_error`/`_blockedUntil`, sets `_fetchedAt`, reschedules at
  `nextPollSeconds(null)` (i.e. 300 s).
- Failure: previously fetched quotas are left untouched (the existing "only assign `_quotas` on
  success" behaviour already did this), `_error` is set, and when the thrown error carries
  `retryAfter`, `_blockedUntil` is set and the next poll is scheduled via
  `nextPollSeconds(retryAfter)`; otherwise the steady 300 s interval is used.
- Popup open: always re-renders; only calls `_refresh()` when `shouldFetchOnOpen` says the
  cache is stale and there's no active backoff.
- Rendering runs the quota list through `markExpired` before every use (panel + popup). An
  expired cached quota shows `—` for its percentage in both places, its bar is forced to
  `value = 0` with no tick (`overdriveStart` forced to `1`), and its caption is hidden.
- The popup message line is composed in `extension.js`:
  - no error → hidden (unchanged).
  - error, nothing ever cached → the bare error string (unchanged from before).
  - error, cache present, not blocked → `` `${error} · values from ${absoluteTime(fetchedAt, now)}` ``.
  - error, cache present, currently blocked → `` `Rate limited — retrying at ${absoluteTime(blockedUntil, now)} · values from ${absoluteTime(fetchedAt, now)}` ``.

One naming fix along the way: the new `_renderPanel` parameter was originally called `quotas`,
shadowing the imported `quotas()` view-model function — renamed to `quotaViews` before
finishing, to keep to the project's "consistent vocabulary" rule.

## Tests

`test/policy.test.js` was written and run against a nonexistent `lib/policy.js` first — it
failed with `ERR_MODULE_NOT_FOUND`, confirming the tests exercise real code and not a mock,
before `lib/policy.js` was written. 18 new tests cover every exported function: the default
interval, a retry-after below/above the interval, a null retry-after, the `isBlocked` boundary
in both directions, all four `shouldFetchOnOpen` cases (never-fetched, fresh, stale, blocked),
and `markExpired` for a past/`now`/future/null `resetsAt` plus non-mutation of the input array
and its entries.

Final run, `TZ=UTC node --test` (bare, no path argument, per the constraint that a directory
argument fails on this node version):

```
✔ relativeDuration renders days and hours past a day (0.670648ms)
✔ relativeDuration zero-pads the minutes below a day (0.098175ms)
✔ relativeDuration drops to minutes below an hour (0.737334ms)
✔ relativeDuration reports a minute while any time remains (0.102594ms)
✔ relativeDuration collapses to now at and past the reset (0.077276ms)
✔ absoluteTime shows only the time when the reset is today (10.806053ms)
✔ absoluteTime adds the weekday on another day (0.346936ms)
✔ absoluteTime has no leading zero on the hour in a 12-hour locale (0.472493ms)
✔ windowProgress measures elapsed time in the session window (0.138061ms)
✔ windowProgress measures elapsed time in the weekly window (0.155163ms)
✔ windowProgress clamps a reset already in the past (0.07918ms)
✔ windowProgress is null without a reset time (0.055355ms)
✔ session and weekly always render, a scoped quota at zero does not (1.973329ms)
✔ the session entry carries every field the UI needs (0.33322ms)
✔ a scoped quota renders once it is above zero, named after its model (0.161936ms)
✔ a scoped short label takes a second lowercase letter when it would collide (0.167827ms)
✔ a quota without a reset time has no window progress (0.140185ms)
✔ severity passes through when known and degrades to normal otherwise (0.122531ms)
✔ a response without limits yields no quotas (0.072337ms)
✔ limits present but not an array yields no quotas rather than throwing (0.068299ms)
✔ a blank display_name does not produce an empty short (0.172957ms)
✔ a percent above 100 passes through unclamped (0.189499ms)
✔ a scoped quota named after a single reserved letter does not collapse into it (0.198676ms)
✔ two scoped quotas sharing an initial each get a distinct short (0.133072ms)
✔ nextPollSeconds falls back to the steady-state interval without a retry-after (1.954574ms)
✔ nextPollSeconds keeps the steady-state interval when the retry-after is smaller (0.181473ms)
✔ nextPollSeconds adds a five-second margin past a retry-after larger than the interval (0.101862ms)
✔ nextPollSeconds rounds a fractional retry-after up before adding the margin (0.099128ms)
✔ blockedUntil returns null without a retry-after (0.12674ms)
✔ blockedUntil lands five seconds past the retry-after, rounded up (0.314284ms)
✔ isBlocked is true strictly before the blocked-until time (0.170903ms)
✔ isBlocked is false at and past the blocked-until time (0.096973ms)
✔ isBlocked is false without a blocked-until time (0.106501ms)
✔ shouldFetchOnOpen fetches when there is no prior fetch (0.210829ms)
✔ shouldFetchOnOpen skips a fetch still within the open-refresh window (0.124676ms)
✔ shouldFetchOnOpen fetches once the data is older than the open-refresh window (0.127601ms)
✔ shouldFetchOnOpen refuses while blocked, even with stale data (0.104096ms)
✔ markExpired flags a quota whose reset time has passed (0.161034ms)
✔ markExpired flags a quota resetting exactly now (0.094378ms)
✔ markExpired leaves a future reset unflagged (0.095691ms)
✔ markExpired never flags a quota without a reset time (0.115338ms)
✔ markExpired does not mutate the input array or its entries (0.11646ms)
ℹ tests 42
ℹ suites 0
ℹ pass 42
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 73.651697
```

24 pre-existing tests still pass; 18 new tests pass; 0 failures.

`node --check` was run against `extension.js`, `lib/usage.js`, and `lib/policy.js` to confirm
they parse (extension.js can't run under `node --test` — it imports `gi://` modules — so a
syntax check is the only static verification available outside a live shell).

## Uncertain / left for the controller to verify

- **`extension.js` and `lib/usage.js` are unverified against a live shell**, by design — the
  task explicitly forbids enabling the extension or making requests to the usage endpoint
  while it's rate-limited. The `_refresh`/`_scheduleNext`/`_applyResult` control flow was
  traced by hand against the spec and against `node --check`, but has not been exercised by
  GJS.
- The `isBlocked` early-return branch in `_refresh()` also calls `_scheduleNext`, using
  `nextPollSeconds` on the seconds remaining until `_blockedUntil`, so the self-rescheduling
  timer can never get stuck even if `_refresh()` is somehow invoked while blocked (in the
  nominal flow this should be rare/impossible, since `shouldFetchOnOpen` already refuses to
  call `_refresh()` while blocked, and the timer itself is scheduled to fire at or after the
  block lifts). This reschedule was not explicitly spelled out in the task's bullet list for
  the blocked branch, but omitting it would leave the poll loop permanently stopped after any
  invocation during a block — added out of caution that this doesn't reintroduce a different
  flavour of "permanent" failure. Flagging it in case the controller wants a different call.
- Whether an expired cached quota's severity styling should be forced to `normal` (rather than
  keeping the last-known severity) wasn't spelled out explicitly in the spec; implemented as
  `normal` on the reasoning that a hidden percentage shouldn't carry a colour tied to a number
  no longer shown. Worth a second look if the intent was different.
