# Quota 429 attribution — design

**Date:** 2026-08-11
**Status:** implemented 2026-08-11

Two things the implementation settled that this document could not:

- **`trigger` gained a fourth value, `startup`.** The shell's own first fetch is neither a scheduled poll nor a
  button press, and folding it into `timer` would have attributed every shell restart — the commonest event of
  a development session — to the cadence being measured.
- **The pure half of the analysis lives in `tools/attribution.js`**, with `tools/quota-attribution.js` as the
  runner that reads the filesystem, exactly as `tools/contrast.js` sits under `tools/a11y.js`. That is what
  "unit-testable the same way `tools/a11y.js` is" means in this tree: `a11y.js` runs `main()` at import time
  and cannot be imported by a test.
- **A `200` carries no `anthropic-ratelimit-*` headers.** First live record, `rateLimitHeaders: {}`, so the
  row of the verdict table that would have answered the question outright is still waiting on a `429`.

## Problem

The extension meets HTTP 429 on the quota endpoint, and nothing records it. `lib/usage.js` throws an
`Error` carrying `rateLimited` and `retryAfter`, `extension.js` turns that into `_blockedUntil` and a
popup caption, and the event then exists nowhere else. So the obvious next question — *what is
actually consuming the allowance* — cannot be answered from anything on disk.

It matters because the candidate causes have opposite fixes. If this extension's own cadence is the
dominant load, the fix is one constant. If Claude Code sessions dominate, no change here helps and the
only remaining options are transparent interception or acceptance. If neither, the load is coming from
other devices on the account and nothing local is relevant.

## What is already established

- This extension is the only local caller of the endpoint. `grep -rl 'oauth/usage'` across
  `~/Sources/e7d` and `~/.claude` returns `lib/usage.js` alone.
- Its cadence is `POLL_SECONDS = 300`, so roughly 12 requests per hour, already coalesced onto one
  timer and already gated by `blockedUntil`.
- Claude Code calls `fetchUtilization` per session against a hardcoded host, so it cannot be
  intercepted locally. Its per-session cadence is unknown.
- 105 session transcripts were touched in a recent 48-hour window, and birth times are available on
  this filesystem, so session starts are recoverable without instrumenting anything.

The comparison is therefore between roughly 12 requests per hour from here and an unknown multiple of
~2 sessions per hour from Claude Code. Guessing which dominates is what this design exists to avoid.

## Scope

Record every upstream attempt this extension makes, then correlate it against session starts already
on disk. Produce a verdict. Nothing else — no change to polling behaviour, no new UI, no network.

## Design

### Source 1: an attempts log (new)

Every upstream attempt appends one JSON object to `~/.cache/claude-quota/attempts.jsonl`, beside the
existing `usage.json`:

```json
{"ts":"2026-08-11T11:55:12.482Z","trigger":"timer","outcome":"rate-limited",
 "status":429,"retryAfter":37,"rateLimitHeaders":{"anthropic-ratelimit-requests-remaining":"0"}}
```

| Field | Values | Why it is there |
| --- | --- | --- |
| `ts` | ISO 8601, UTC | correlation key |
| `trigger` | `timer`, `manual`, `popup-stale` | separates scheduled polls from refresh-button presses, which is the test for the dev-time-burst hypothesis |
| `outcome` | `ok`, `rate-limited`, `unauthorized`, `error` | the thing being counted |
| `status` | HTTP status, or `null` on a transport failure | distinguishes a 429 from a network fault |
| `retryAfter` | seconds, or `null` | shows how hard the endpoint is pushing back |
| `rateLimitHeaders` | any `anthropic-ratelimit-*` present, else `{}` | if the endpoint returns them, remaining allowance and window size answer the question directly and the correlation below becomes a cross-check rather than the primary evidence |

The record carries no token, no request body, and no response body. The file is capped at the most
recent 2000 records, trimmed on write.

### Module split

The `gi://` rule in `AGENTS.md` decides the shape. `lib/usage.js` is the only module allowed to touch
Soup and Gio, and is meant to stay thin, so it gains exactly one responsibility: return the
`anthropic-ratelimit-*` headers it already has a handle on, as plain data, on both the success and the
429 path. Every decision stays testable:

| Unit | Responsibility | `gi://` |
| --- | --- | --- |
| `lib/attempts.js` (new) | build a record from an outcome, serialize, trim to the cap, parse a log back | no — unit tested |
| `lib/usage.js` | expose the response's rate-limit headers as data | yes, existing exception |
| `extension.js` | call `attempts.js` on every poll outcome and write the file, exactly as it already does for `usage.json` | shell only |

This mirrors the existing `lib/cache.js` split, where serialization is pure and `extension.js` owns
the `Gio.File` write. No new file-writing pattern is introduced.

### Source 2: session starts (existing, no code)

Claude Code session transcripts under `~/.claude/projects/**/*.jsonl` carry usable birth times, so
session starts need no instrumentation and history reaches back as far as the transcripts do.

The analysis reads **metadata only** — never transcript contents, which are conversation logs.

### Analysis: `tools/quota-attribution.js`

Joins both sources by hour and prints attempts, 429s, and session starts per hour, followed by a
verdict. Development tooling, never shipped, consistent with the rest of `tools/`.

**Node rather than shell, deliberately.** Two traps were hit while gathering the figures above, both
now recorded in the workstation gotchas: `find` on this host is bfs, which rejects relative timestamps
like `-newermt '48 hours ago'` and yields a confident `0` once the error is swallowed by a pipe; and
`-printf` is an action rather than a filter, so tests placed after it narrow nothing. A Node tool
walks the directory with `fs` and never meets either, which also makes it unit-testable the same way
`tools/a11y.js` is. Avoiding the trap beats documenting it.

Birth times come from `fs.statSync(path).birthtimeMs`. `stat -c '%w'` returns real values on this
filesystem, so the support is there. If a birth time comes back as `0` the tool says so and falls back
to mtime while relabelling the column "last activity" — a different measurement never appears under
the same name as the one that was asked for.

### Verdict semantics

The script must distinguish *no problem* from *no data*, because they look identical in a count:

| Observation | Verdict |
| --- | --- |
| no attempts logged | "no data yet — the log starts empty; re-run after a poll cycle" |
| attempts logged, zero 429s | "no 429 observed in this window; cannot attribute" — explicitly not "all clear" |
| 429s, and `rateLimitHeaders` present | report remaining allowance and window directly; attribution follows from the numbers |
| 429s cluster within the correlation window of session starts | "correlated with Claude Code sessions" — local mitigation will not help |
| 429s spread evenly across hours with no session correlation | "consistent with own cadence" — raise `POLL_SECONDS` |
| 429s with neither pattern | "unattributed; likely another device on the account" |

The correlation window defaults to 10 minutes either side of a session start, overridable with
`--window=<minutes>`, and "cluster" means at least half the observed 429s fall inside one. Both the
window and that fraction are printed alongside the verdict, so a reader sees what was asserted rather
than trusting the label.

`extension.js` must thread the trigger through from each call site, since the poll path is shared
between the timer, the refresh button and the stale-popup check. A single default of `timer` would make
the field useless for the hypothesis it exists to test.

## Testing

`lib/attempts.js` gets `test/attempts.test.js` under `node --test`: record construction for each
outcome; trimming at the 2000-record boundary, asserting that the record retained is the newest and
that a log one under the cap is untouched; round-tripping a log through serialize and parse; tolerance
of a corrupt trailing line, since an interrupted write is expected rather than exceptional. One test
asserts that a record built from a response carrying an `Authorization` header contains no substring
of that header — the guarantee that makes this file safe to keep.

`tools/quota-attribution.js` gets unit coverage over fixture inputs, per the `tools/` row in
`AGENTS.md`: each verdict row above is reachable from a crafted fixture, including both empty cases.
The verdict function takes attempts and session starts as arrays, so no test touches the filesystem.

Behaviour changes rather than appearance, so `npm run e2e` is the check that matters, and the log write
belongs to the existing `refresh` group's concerns. Per `docs/development.md` § Asserting what it does,
any assertion added there is proven able to fail on every run through the existing `control` mechanism
rather than a new one.

Read `docs/development.md` § Asserting what it does before writing the e2e assertion; the control
convention is established there and must be reused, not reinvented.

## Out of scope

No change to `POLL_SECONDS` — that is the possible *outcome* of this work, not part of it. No proxy;
that design is shelved in `docker-anthropic-usage-proxy` with the reasoning. No attempt to intercept
Claude Code's own polling.
