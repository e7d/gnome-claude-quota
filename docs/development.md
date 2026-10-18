# Development

## What reloads, and what does not

GNOME imports an extension's JavaScript **once per shell session**. `extensionSystem.js` does `await import(extensionJs.get_uri())` with no cache-busting parameter, and says so:

> Extensions can only be imported once, so add a property to avoid attempting to re-import an extension.

So disabling and re-enabling the extension re-runs `enable()` on the module already in memory. Changed code is not picked up. `ReloadExtension` on the `org.gnome.Shell.Extensions` D-Bus interface answers `NotSupported: ReloadExtension is deprecated and does not work`, and `Alt+F2 r` is X11-only.

Stylesheets behave differently: `loadExtension` calls `theme.load_stylesheet()` and `unloadExtension` calls `theme.unload_stylesheet()` on every cycle, and `_reloadExtensionStylesheets()` also runs on a colour-scheme change.

| Changed | Needed to see it |
| --- | --- |
| `lib/*.js` logic | `TZ=UTC node --test` — no shell involved |
| `stylesheet.css` | disable/enable the extension |
| icon file contents | nothing; it is read at render time |
| `extension.js`, or any `lib/` module as executed code | a new shell process, i.e. `./tools/preview.sh` or `./tools/e2e.sh` |

That asymmetry is a trap worth remembering: a disable/enable cycle picks up CSS while silently keeping old JS, so a change can appear to work while the code under test never ran.

## Linting

```bash
npx oxlint                           # or: npm run lint
npx oxlint lib/policy.js             # one file
npx oxlint -A all -D pedantic        # try a rule set on before adopting it
```

Silence means clean. The rule sets in `.oxlintrc.json` are `correctness`, `suspicious` and `perf`, and the ones left off were left off with a measurement: `style` reported 1835 findings, `restriction` 170 — mostly optional chaining, `++` and `console` in `tools/`, all of which this code uses deliberately — and `suspicious` brings `no-underscore-dangle`, whose 324 hits are the `_private` convention GNOME Shell itself follows. That last one is disabled by name rather than by dropping the whole set.

`no-undef` is the rule worth keeping honest, and it only works because the shell-side files declare what the shell provides: `global`, `log`, `logError`, `TextDecoder`, `TextEncoder`. Deleting that block reports 12 undefined symbols across `extension.js` and `lib/`, which is the check that it is still load-bearing. `test/` and `tools/` are linted as Node instead, since they are the only files allowed to touch `process`.

Before adding a rule, run it with `-A all -D <category>` and read what it says about *this* codebase. A rule that fires 300 times on a convention is a rule that will be ignored.

## Running the tests

```bash
TZ=UTC LC_ALL=C node --test
```

Bare — no path argument. `node --test test/` fails on node 24, which tries to execute a file literally named `test`. `TZ=UTC` is required because two assertions pin absolute times and `Intl.DateTimeFormat` resolves against the system zone. `LC_ALL=C` is the same guarantee for words and for number formatting: `percentLine` renders `21%` under `C` and `21 %` under French.

`lib/format.js`, `lib/model.js`, `lib/policy.js` and `lib/cache.js` import nothing from `gi://`, which is what lets node run them directly. Logic belongs there rather than in `extension.js` for exactly that reason.

## Coverage and the module census

```bash
npm run coverage
```

Runs the same suite under `--experimental-test-coverage`, gated at 100% lines, 100% functions and 95% branches over `lib/**`, then runs `node tools/coverage-census.js` against the `lcov.info` it wrote.

The threshold alone cannot catch a module the suite never imports: `node --test`'s coverage report only lists files it actually loaded, so a `lib/` file with no `import` anywhere in `test/` simply has no `SF:` record in `coverage/lcov.info` — it contributes nothing to either side of the percentage, and 100/100/95 is satisfied by the files that *were* touched without that module ever running once. The census closes that gap from the other direction: it reads every `lib/*.js` filename off disk and asserts each one appears in the report, exempting only `lib/usage.js` (it imports `gi://` and cannot run under node at all — see `AGENTS.md` § Shape of the code). Adding a `lib/` module with no test importing it fails the census with `no test imports: lib/<name>.js`, even though the coverage thresholds above it stayed green.

## Seeing what rendered

```bash
tools/preview.sh --dark --scenario=loading
```

`preview.sh` owns one named nested shell — `preview` by default — and sets the shape of the extension inside it: theme, scenario, popup position. It runs a throwaway shell, so it picks up changed `extension.js` without a logout, and a fabricated scenario never calls the usage endpoint.

Recalled while that session is up, from another terminal or as `--watch`'s own restart, it changes the shape live instead of tearing the shell down and starting a new one. **An option you leave out is left alone** — `tools/preview.sh --light` repaints and changes nothing else, whatever theme, scenario or popup position was last applied. On a fresh session the flags' own defaults apply: windowed, your last-cached values, popup closed. `--stop` tears the named session down.

`--capture` writes the canonical three-state tile — resting, hovered, pressed-with-popup-open, stacked into one PNG — to `preview/<theme>-<scenario>.png` and prints that path, so the form for a screenshot while nobody is watching is:

```bash
tools/preview.sh --headless --detach --scenario=loading --capture
```

headless because a window is for a human, detached because the call should return, not block.

`--prefs` opens the preferences window inside the running session:

```bash
tools/preview.sh --headless --detach --prefs --capture --dark
```

The window is a separate GTK process — `gnome-extensions prefs` — reached over the session's
own Wayland socket rather than the host's, which is why `start_shell` gives the nested shell a
deterministic `--wayland-display` name to hand it. It earns a screenshot rather than an
assertion: driving Adw widgets from outside the process the way `Eval` drives the shell's own
actors would need AT-SPI, which nothing else in this harness uses. What the settings actually do
is asserted in the shell, over the same GSettings keys the window writes.

**The overview cannot open in a nested session, deliberately.** The shell opens it again a second or so into startup, long after the indicator appears, and a hide issued while that show animates is swallowed — as is one from a `showing` or `shown` handler, and clearing `sessionMode.hasOverview` does not stop it either. So `hide_overview` takes `Main.overview.show` away for the life of the shell, which is what keeps it from drifting up over the panel mid-run and poisoning tiles. It applies to windowed sessions too, so Super and the Activities corner do nothing there. To get it back in a session you are driving by hand, restore the parked original over Eval: `Main.overview.show = globalThis._cqOverviewShow`.

**Resize the devkit window and the emulated monitor follows it.** Dragging it from its native 1280x800 to 1862x1045 moved `Main.layoutManager.primaryMonitor` and the panel with it, live, no restart — which is how you widen a windowed session enough for a third quota to render without ellipses. There is no way to ask for a size in advance, though, and no way to set one from outside the session. Neither binary offers a geometry flag: `gnome-shell --help-all` pairs `--devkit` (no geometry) with `--virtual-monitor WxH` as independent options, and `mutter-devkit --help-all` has no options at all beyond GApplication boilerplate. `MUTTER_DEBUG_DUMMY_MODE_SPECS` does not exist in this system's libmutter at all — it belongs to the dummy/headless KMS backend, not the native backend `--devkit` uses, and setting it changes nothing. The only gschema, `org.gnome.mutter.devkit`, has a single key, `launchers`, unrelated to size. The nested session does export `org.gnome.Mutter.Devkit` on its bus, but introspection shows it carries no methods or signals — only a read-only `Env` property — and exposes no `org.gtk.Actions` interface, so the window's own Monitors menu cannot be driven from outside either. Pairing the two flags does not help: `gnome-shell --devkit --virtual-monitor 1440x900` yields *two* monitors, `1440x900` as the primary and the native `1280x800` as the one the viewer actually shows, so the extension's panel lands on a display the window never renders — which is why the harness offers no size flag for `--windowed`: the only thing that sizes that window is the pointer. The headless backend has no such gap: it takes its size from `--virtual-monitor`, set to `1440x900` in `DEVKIT_MONITOR` (`tools/lib/devkit.sh`), so a fresh windowed session starts narrower than a headless capture of the same state until you drag it.

The mechanics, in case a state needs adding by hand:

- **`--devkit` is the way to run a shell in parallel.** `--nested` was removed in GNOME 50: `meta_context_main_create_backend` now offers only headless or native, so plain `--wayland` picks the native backend and dies on `Failed to take control of the session: EBUSY`. `--devkit` brings its own viewer window, `/usr/lib/mutter-devkit`, and `require_install` warns rather than fails when that binary is absent. `--headless --virtual-monitor WxH` is the other backend and the default here; the two are mutually exclusive, since pairing them puts the panel on a monitor the viewer never renders.
- **`--unsafe-mode` is what enables `Eval`.** It is a hidden option and does not appear in `--help`. Without it `org.gnome.Shell.Eval` answers `(false, '')`, which is indistinguishable from a broken script.
- **`org.gnome.Shell.Screenshot` works on the throwaway shell's own bus.** It is portal-restricted only on the live session. `ScreenshotArea` takes a box, and measuring it from the actors (`get_transformed_position` / `get_transformed_size`) beats cropping afterwards.
- **Every `dconf`/`gsettings` write belongs inside the `dbus-run-session`.** `XDG_CONFIG_HOME` does not sandbox dconf: writes travel over the session bus to the dconf service, which reads its own environment. A write issued before the private bus exists lands in the *live* session — that is how the user's `enabled-extensions` list was replaced with a single entry, twice, and how their interface font got repointed. The script now writes `enabled-extensions` (this extension alone, so no other indicator lands in the panel) and pins the font to `Cantarell 11` from inside that inner shell, and nowhere else.
- **Take the bus address from the real `gnome-shell` process.** A `pgrep -f` pattern also matches the wrapper shell whose argv contains it, and that wrapper carries the *parent* bus address, so `gdbus` would silently drive the live session instead.

- **The reset pins `_locale` to `en-US`.** The indicator resolves its own from `LC_ALL`/`LC_TIME`/`LANG`, so on a machine whose `LC_TIME` is not American every clock reading in the matrix would shift and no two contributors' shots would match. The `locale` scenario sets `fr-FR` to capture the 24-hour rendering deliberately.
- **The harness backdates `_fetchedAt` by six minutes** in the per-scenario reset. Every state would otherwise be freshly fetched, so the whole matrix would render the refresh row as the disabled `Up to date` and never show the actionable label. The `fresh` scenario re-stamps it to now to capture that state deliberately, and `refreshing` sets `_refreshing`.

A missing colour shows up as `Did not find color property` in the shell log, worth grepping after any stylesheet change: St resolves an undeclared `-barlevel-*` property to transparent and only warns.

Geometry questions are better answered from the actors than from pixels. Measuring the panel button's padding by thresholding a screenshot returned a plausible constant that was really the hover pill's own anti-aliased edge; reading `get_theme_node().get_padding()` gave the true figure and a different answer.

## Asserting what it does

```bash
./tools/e2e.sh --group=hover
./tools/e2e.sh --group=state --dark-only --scenario=loading
```

The same throwaway shell as the preview, driven for verdicts instead of pixels — and shooting the grid as it goes. Six groups run in the order below, and `--group=<name>` runs one of them; the scenario flag is shared with `preview.sh`, but the theme flag is not: e2e keeps `--dark-only`/`--light-only` rather than `preview.sh`'s recall-friendly `--dark`/`--light`, since a run asserts a whole matrix rather than shaping one live session.

| Group | What it holds to account |
| --- | --- |
| `state` | every scenario in both themes: every row filled, no `null`/`undefined`/`NaN` reaching a label, one block per quota, each panel label ending in its block's percentage — plus a severity resolving to different colours in the two schemes |
| `panel` | the ladder the panel degrades along: every value shown when there is room, values giving way from the right and never from the middle, the button never wider than the space the shell hands it, no separator beside a hidden value, the incident emoji outliving every value, and the whole set returning unprompted when the space does |
| `hover` | the indicator's hover shape read live against `quickSettings`, the display rows staying inert, and the status row highlighting |
| `refresh` | a click leaves the popup open, spins the icon while the fetch is in flight, leaves no transition behind afterwards, and appends one attempt record carrying the trigger that caused it, the outcome, the rate-limit header and no credential |
| `notify` | a quota crossing a threshold posts one notification per level, escalates its urgency, withdraws it when the window ends, re-reads its thresholds from GSettings, posts from a poll that answered rather than only from a hand-driven sync, and walks the whole arc 0 → warning → critical → 0 checking the panel colour and the tray agree at every step |
| `lifecycle` | disable releases the timer, cancels the in-flight fetch, closes the notification source and empties the panel entry; enable registers exactly one indicator |

`lifecycle` destroys the indicator, so it runs last and every earlier group needs a live one. The `state` group is also what writes `preview/`, so a run excluding it leaves whatever was already there for `npm run a11y` to score.

**One run at a time.** Both runs answer to the session named `e2e`, so a second one used to attach to the first one's shell and the two interleaved their state and their pointer — which surfaces as a control failure somewhere unrelated and reads exactly like a defect. `claim_session` takes a `flock` on `$XDG_RUNTIME_DIR/claude-quota/e2e.lock` and refuses the second run. The kernel drops that lock on any exit, kill included, so there is no stale lock to clear; the file lives outside the session directory because `reap_session` removes that, and a second run would otherwise lock a fresh file and walk straight in. `preview.sh` takes no lock, since recalling a live session to reshape it is what it exists for.

An assertion may not spell an English string. `catalog_msg` resolves a msgid through `gettext` against `locale/` for the run's own language, so an expectation follows the catalog instead of duplicating it — and under the default `C` it returns the msgid unchanged. Three assertions were caught this way on the first French run, each reported honestly as a dead assertion rather than a broken extension.

`catalog_prefix` takes the words before the first placeholder, which is nothing at all for a msgid that opens on one — `{name} at {percent}` is the notification title. `catalog_infix` takes the connector between two placeholders instead (` at `), so a msgid of that shape still has something a language run can match on. Reach for it whenever an expectation needs the *wording* of a msgid that starts with a substitution.

Three assertions cover what happens to a notification *after* it is posted, and they are worth
knowing about because the mechanism is not obvious. Movement inside one tier rewrites the
notification in place — the assertion holds the object across the sync and requires the same
identity back, which is what distinguishes a rewrite from a repost. Crossing a tier requires the
opposite: the warning gone and a critical whose object is not the one held. A dismissal requires
`_alerts` to have lost the key while `_fired` keeps it, since that record is the only thing
standing between a dismissed banner and the next poll restoring it.

The rewrite has one trap in it. Writing any property on a `Notification` schedules an idle that
re-stamps `datetime` to now, so a notification refreshed every minute would read "Just now"
forever. Assigning `datetime` cancels that idle — but only a *different* boxed value emits the
notify that does the cancelling, so the code writes a fresh `GLib.DateTime` over the same instant.
Measured both ways: assigning the identical object does nothing and the timestamp drifts.

Also measured, and the reason the tick is safe: a property write does not re-show the banner of an
acknowledged notification, so a minute refresh cannot turn into a minute of banners.

The arc is the one assertion that spans states rather than checking one. It moves the percentage
*without re-rendering*, so `resetsAt` holds still and every step is a quota that moved rather than
a window that rolled — a re-render would re-arm each level for a reason unrelated to what the arc
is testing. It also moves `severity` alongside the percentage, and that pairing is the honest
shape of the assertion: the panel colour follows the payload's own severity while a notification
follows the user's thresholds, so the two are independent inputs that agree only when the payload
agrees with the configured percentages. Asserting them together proves each half renders from its
own input; it does not — and cannot — prove they never disagree.

Banners are blocked for the whole e2e run via the shell's own `bannerBlocked` setter, which hides
the banner and leaves the notification in its source. That is what keeps a banner from drifting
across a capture rect that starts at `y=0`, and it costs the group nothing: every assertion reads
`_alerts` and `source.notifications`, neither of which the setter touches. Every `preview` call
the suite makes also passes `--notify=off`, so the shoot cannot post in the first place.

`assert_schema_defaults_agree` is not about the shell at all: the thresholds are declared twice, once as the schema's defaults and once as `NOTIFY_DEFAULTS` in `lib/notify.js`, and the indicator is the only thing that reads both. It reads the schema's own default through `_prefs.get_default_value` in the session and the constant through `node`, and fails when they part company — a cross-declaration guard, in the group whose behaviour depends on the two agreeing. Its control replaces the reader rather than writing a key, since setting a key cannot move its default.

Shooting every scenario is the default, which is also why a bare `npm run e2e` now costs minutes rather than the seconds a narrowed run takes — 31 scenarios in both themes is 62 tiles plus `overview.png`. Two flags trade shots for speed in opposite directions: `--a11y` narrows the shoot to the ten scenarios `npm run a11y` actually scores, and `--assert` shoots nothing at all, leaving `preview/` untouched, for a run where only behaviour is in question. `--group=`, `--scenario=` and `--dark-only`/`--light-only` narrow the same way they always did.

**Every assertion is proven able to fail, on every run.** `prove` evaluates a check three times — untouched, with a deliberate runtime mutation applied, then after the restore — and requires it to pass, fail and pass again. A check that survives its own break is a dead check, and the run stops there, non-zero, with its reason on stderr:

```
control status row highlights: still passed with the break applied
```

That line says **the assertion is dead, not the extension**. Fix the assertion, never the control. Every verdict carries a marker so a failure cannot be skimmed past in a thousand-line CI log: `✅ ok`, `❌ FAIL`, `❌ control`, and the summary line takes whichever of the two the tally earned. A `prove …` line on stdout is therefore not a passing test but a licence for the tests after it, and it leaves the tally alone — the counters are saved and restored around every control, so the summary counts real assertions only.

The breaks are mutations over `Eval` and the restores are re-renders, since `_render()` rebuilds every actor from state. Staging a failure by editing `extension.js` is the one thing a control must never be: it has to be undone inside the run, and a control that outlives its run is a broken checkout.

The attempt-log control is the one break that runs real code rather than mutating an actor: it triggers a second fetch with `trigger` set to `timer` and expects the assertion on the newest record to fail, then triggers a `manual` one to restore. That works only because the block a `429` arms is cleared before each deliberate attempt — a blocked `_refresh` makes no upstream call and therefore writes no record, which would leave the log unchanged and read as a dead assertion.

**Every attempt-log assertion counts our own records, never the file's bytes.** `own_attempts` and `last_own_attempt` filter `"endpoint":"status"` out, because the status poll appends to the same log on its own 60-second timer: a byte count answers "did anything happen" where all three of these assertions ask "did we spend a request". Measured on 2026-08-26, a status record is 213–258 bytes, and one landing inside `assert_floor_holds`' one-second window failed `a request inside the minimum interval is never sent` on GitHub with `expected '2075', got '2332'` — a 257-byte growth that was the status poll, not a request. `log_attempt` waits on the same filtered count, so a status record can no longer satisfy the wait for a usage record either, and `last_attempt_field` can no longer read a status record's fields as if they were the attempt under test.

**A control that stages "the same token" has to pin one timestamp.** `credentialsRenewed` is a strict `>`, so two `new Date(Date.now() + 3600000)` calls a millisecond apart are a *renewal*: `wake_on_same_token` set `_seenExpiry` immediately and left `credentialExpiry` a lambda evaluated later, inside `_onCredentialsWritten`, so on a loaded runner the break cleared the block it was supposed to leave standing and `a renewed token ends the block` reported `still passed with the break applied` — which is the Forgejo failure of run 22. Both sides now read one `globalThis._sameExpiry`.

## Attributing a 429

Every upstream attempt appends one JSON object to `~/.cache/claude-quota/attempts.jsonl`, beside the cache — see § Reading the exchange log for the fields and the reader. The append itself costs one open and one write whatever the log holds; trimming to 2000 records has to read the whole file, so it runs on one append in two hundred and on the first of each session. The log therefore sits a little above 2000 rather than exactly on it, and a line torn by an interrupted write is healed at the next trim rather than immediately — `parseLog` drops an unparseable line in the meantime. Doing it the other way round — rewriting the whole file on every attempt — put a read, a split and a write of every record on the compositor's own thread, several times a minute.

```bash
npm run attribution                  # or: node tools/quota-attribution.js --window=20
```

It joins that log against Claude Code's own session starts — `~/.claude/projects/**/*.jsonl` birth times, metadata only, never contents — prints both per hour, and names what the numbers support. `--window=<minutes>` sets the correlation window either side of a session start, and the window, the cluster threshold and the observed fraction are printed with the verdict so a reader sees what was asserted rather than the label alone.

The verdict distinguishes *no problem* from *no data*: an empty log says so and asks for a poll cycle, and a log with attempts but no `429` says it cannot attribute rather than reporting all clear. If a `429` carried `anthropic-ratelimit-*` headers, those answer the question directly and the correlation is only a cross-check.

Birth times come from `fs.statSync().birthtimeMs`. If any file reports `0` the tool falls back to mtime for all of them and renames the column to `last activity`, so a different measurement never appears under the name of the one that was asked for. It is Node rather than shell deliberately: `find` here is bfs, which rejects `-newermt '48 hours ago'` and yields a confident `0` once a pipe swallows the error, and `-printf` is an action rather than a filter, so tests placed after it narrow nothing.

## Rate limits

`/api/oauth/usage` has **two** limiters, and they are worth telling apart because only one of them is about how often you ask.

| Trigger | Answer | Measured |
| --- | --- | --- |
| Request burst | `429`, `retry-after: 300` | the 6th request inside ~4 s; five in a row succeed |
| Consecutive auth failures | `429`, `retry-after: 3600` | the 4th attempt after three `401`s five minutes apart |

Measured 2026-08-13 against the live endpoint. No successful response has ever carried an `anthropic-ratelimit-*` header, so the allowance is not discoverable from a `200`; both figures above come from provoking the refusal and reading `retry-after`. The burst allowance is shared by everything on the machine holding the same token, Claude Code included, so a poll landing beside a Claude Code session start can be refused through no fault of its own.

The hour-long one is the expensive mistake, and it is **caused by us, not suffered by us**: a token that has expired answers `401`, and a poller that keeps its five-minute cadence through three of them earns an hour in which nothing works. That is the whole of the morning failure recorded on 2026-08-13 — the token lapsed overnight, nothing refreshed it until Claude Code next ran, and by then the block had been armed.

Three things keep the extension out of it, and each has a proof in the refresh group:

- **`lib/credentials.js` reads `expiresAt` beside the token**, and `UsageClient.fetch` refuses to send at all once it is past — with a minute of skew, since a token that dies in flight answers `401` just the same. A declined attempt is logged as `token-expired` and arms no block, because only a new token can end the wait.
- **A server `401` arms a block like a `429` does** (`blockReason` in `lib/policy.js`), so a token that is revoked rather than expired cannot be asked three times in fifteen minutes either. It does not claim the throttle line: `throttledUntil` hands that to a rate limit alone, so the popup says what is actually wrong.
- **The block is scoped to the token that earned it**, which is why a `Gio.FileMonitor` on `~/.claude` watches for `.credentials.json` being replaced. A newer `expiresAt` means a newer token, and the block it cannot be subject to is dropped and a refresh runs at once. Without it the indicator waits out an hour that stopped applying the moment Claude Code wrote the file — 26 minutes of it, on the morning this was found. The monitor watches the *directory* because the file is replaced rather than edited, and a two-second settle collapses one replace's several events into one request.

### The tooling spends nothing

It used to spend more than the product did. On 2026-08-13 the log held **21 `startup` attempts against the extension's own 7 `timer` polls**: `_init` calls `_refresh('startup')` before any harness code can stub anything, so every nested session bought one request, and a run of them is what earned the burst `429`s.

A nested shell now gets a **HOME of its own** (`$RUN/home`, `prepare_home` in `tools/lib/devkit.sh`), with this checkout symlinked into its `.local/share/gnome-shell/extensions` and no `.claude` in it. The startup fetch still happens; `readCredentials()` finds nothing and throws, so no socket is opened. The record it leaves says as much — `status: null, durationMs: null` is the signature of an attempt that never left the process. Cache and attempt log land in the sandbox too, so a nested run no longer writes over the evidence on the host.

Measured after the change: a full `--assert` run adds **zero** records to the host log, against one per session before.

The sandboxed `HOME` stopped covering everything the moment the status poll got its own timer on 2026-08-24: `status.claude.com` needs no token, so a nested session polled it every 60 seconds — unauthenticated, but a real request, and one record per minute in the sandbox log. `_pollStatus()` now declines while `~/.claude/.credentials.json` is absent, and the credentials watcher starts it when the file appears, so the same absence that refuses the usage fetch refuses this one. A checkout with no token has no quotas to explain, which is why the product rule and the tooling invariant are the same rule here rather than a flag that only holds under test.

Two assertions were vacuous for as long as that gate existed without them. `status timer released on disable` and `in-flight status fetch cancelled` both read `?? true` over objects a tokenless session never creates, so `arm_status_poll` plants a token and a stubbed status client, waits for `_statusTimerId` to arm, and `die`s if it never does — the teardown control then has something real to release. The token is removed before the re-enable, or the fresh indicator's constructor would poll for real.

Changing `HOME` moves the font cache, so it was checked rather than assumed: the same tile shot under the real and the sandboxed home differs by 14 pixels, while two shots **under the same code a minute apart** differ by 158 — the wall-clock digits in the captions are an order of magnitude noisier than the change. Identical tile dimensions are the load-bearing part, since a font fallback would shift text width and with it the crop.

`--live` no longer means "let it fetch". It seeds the sandbox cache from the host's own `~/.cache/claude-quota/usage.json` and renders through `_loadCache()`, injected exactly like any other scenario — your real current values, no request. Absent that cache it dies if you asked for `--live` explicitly, and falls back to `--scenario=normal` with a line on stderr when it was merely the default, so fabricated numbers are never passed off as yours.

### Claude Code's cache is checked first

Claude Code keeps the same payload in `~/.claude.json` under `cachedUsageUtilization`, and the `limits` array is byte-identical in shape to ours — same keys, same `kind` values — so it feeds `quotas()` and `serialize()` untranslated. `fetchedAtMs` is the only honest freshness signal in that file: its `mtime` moves every few seconds while the block sat 44 hours stale. Measured refresh interval, from three observations, is between 3 and 19 minutes, driven by opening the usage view in the CLI or the VSCode extension.

`_adoptShared` runs at the top of `_refresh`, before the block and before the interval, so a fresher copy can satisfy a poll that would otherwise have spent a request — and can keep the panel current even while a `429` block is in force. Whatever gets used, ours or theirs, is written to our own cache with the **origin's** timestamp, never `now`: claiming data is fresher than it is would break the comparison on the next tick and lie in the popup header.

Two refusals are deliberate. **A copy is only adopted if it is fresher than what we hold** — when this was written our cache read `session 33%` against the file's `23%`, so a naive preference would have walked the panel backwards. And **`accountUuid` in the block must match `oauthAccount.accountUuid`** in the same file, which catches a switched account leaving the previous one's numbers behind. That guard is weaker than it looks and the limit is worth knowing: `.credentials.json` carries no account id, so nothing binds the block to *our* token — only to the account that file says is logged in. Same tool, same machine, so in practice the same account.

An adoption is logged like any attempt, as `outcome: adopted` against endpoint `claude-code`, so `npm run logs` shows what was answered for free and what cost a request.

Every outbound request also passes a single floor: `minIntervalWait` in `lib/policy.js` refuses any send inside `MIN_REQUEST_SECONDS` of the last one that actually left the process, whatever triggered it. `_refresh` is the only funnel, so the timer, a popup open, the button and a credentials renewal are all gated by it. A refused refresh is rescheduled for the moment the floor lifts rather than dropped, so no intent is lost and the rate is still bounded at one request per two minutes — two of the five the window allows, leaving the rest for Claude Code. `_lastRequestAt` advances only when `durationMs` is non-null, so an attempt declined over an expired token costs nothing against it.

Do not poll the endpoint in a loop while debugging: a burst pins the window, and each retry inside it re-arms it. `tools/preview.sh` also stubs the indicator's `_refresh` before capturing. `tools/e2e.sh` inherits that stub, and its refresh group — which has to remove it to make the button do anything — replaces `_fetchCycle` with a promise that never resolves, so asserting the spinner still spends nothing.

## Reading the exchange log

Every attempt against either endpoint appends one JSON object to `~/.cache/claude-quota/attempts.jsonl`, including the ones declined before a request was sent:

```bash
npm run logs                         # today, one line per exchange
npm run logs -- --all --runs         # every record, consecutive outcomes collapsed
npm run logs -- --detail             # response headers and error bodies too
npm run logs -- --outcome=rate-limited --tail=20
```

A record carries the instant, the endpoint (`usage` or `status`), the trigger (`startup`, `timer`, `manual`, `popup-stale`, `credentials`), the outcome (`ok`, `rate-limited`, `unauthorized`, `token-expired`, `error`), the HTTP status, the `retry-after`, the round trip in milliseconds, the token expiry known at request time, the response headers worth keeping, and the response body of anything that failed.

Two deliberate omissions. **Headers are kept by allowlist, never by denylist** — `content-type`, `request-id`, `retry-after`, `x-should-retry` and the `anthropic-ratelimit-*` / `ratelimit-*` families — because a denylist leaks the one credential-bearing header nobody anticipated, and `test/attempts.test.js` asserts a record built from a response carrying an `Authorization` header holds no part of it. **A successful body is dropped**, since the quota payload is already in the cache file and logging it again would push the failures that matter out of the 2000-record window.

The log is what diagnosed the 2026-08-13 morning failure after the fact, from a shell that had already been restarted twice. Reach for it before theorising: `--runs` shows the shape of a bad morning in a dozen lines.

## Popup actions

The service-status line is the only activatable row; everything else comes from `displayItem()`, which strips the `popup-inactive-menu-item` class the theme paints at 50% alpha.

- **`PopupMenuItem.activate()` closes the menu it belongs to**, which would hide the numbers a refresh was asked to update — hence the refresh affordance being an `St.Button` in the header rather than a row. The status line keeps the inherited behaviour, because leaving for a browser *should* close the menu.
- **The row's browser only opens in a nested session because the devkit forces `GTK_A11Y=none`.** `dbus-run-session` gives that session no user systemd, so activating `org.a11y.atspi.Registry` fails and a GTK app aborts at registration rather than starting without a11y. The shell spawns the browser, so it inherits the setting from `tools/lib/devkit.sh` rather than from any launcher — which is why it belongs there once, not on each launch site.
- **A client-side failure and a service issue share one line but not one nature.** An expired token or an unreachable host renders into the non-reactive `_message`; only a `serviceIssue` renders into the activatable row, so nothing offers a status page that cannot explain the failure.
- **The header line states one fact and never shares its row: `Last refresh: <time>`, always.** Two absolute times on that row, each able to grow a weekday once it falls on another day, overflow the card in the locales that spell the weekday out — measured at 262px inside 256px of usable width. Stacking them was worse: six lines of grey metadata above the numbers the popup exists to show.
- **The account address takes its own row under the header, never a place on it.** It is `oauthAccount.emailAddress` from `~/.claude.json`, parsed by `parseAccountEmail` independently of the usage block: `parseSharedUsage` returns `null` for a stale or foreign block, and that must not hide who is logged in. `.credentials.json` carries no identity, so this names the account Claude Code says is logged in — the same proxy for "our" account that the block's `accountUuid` check relies on, with the same limit. It is re-read once per `_refresh`, so a switched account shows after the next poll. The row is a second line of grey metadata above the numbers, which the previous bullet argues against; it is kept to one line, mid-ellipsized, and capped at the block width so it cannot stretch the card (the `long-name` scenario carries a long address for exactly that).
- **A `429` therefore speaks in the message row, under the quotas, in words.** `⏳ Rate limited · retry at <time>` is the only explanation for the greyed button, and it sits where errors and service issues already speak rather than competing with the timestamp. The `rate-limited-day` scenario dates both timestamps a day out, which is the widest either line can get.
- **The manual path reuses `shouldFetchOnOpen` rather than a second constant.** Manual and open-triggered fetches spend the same shared allowance, so one rule governs both.
- **Nothing re-renders while the popup sits open**, so `Up to date` and `Refresh at <time>` are re-evaluated on the next open or the next poll, not on a ticker. Both windows are ≤2 minutes, which is why that is acceptable — worth knowing before adding a state where the staleness matters more.

## The pace bar

`BarLevel` carries its own pace marker, and it is the wrong one: `overdriveStart` makes it **carve a gap** out of the bar at a fractional x and paint the two halves around it, so a second mark drawn on top lands beside a half-pixel edge and reads as one smeared tick. `overdriveStart` is consequently left at its maximum, which keeps the shipped bar unbroken, and `PaceBar.setPace()` owns the marker alone.

- **The tick is drawn on integer pixels.** A 2px rect at a fractional x antialiases across three columns, which is what "the tick looks 3px wide" means every time.
- **The bar is deliberately shorter than its actor**: 6px of bar inside 12px of `.cq-bar`, so the tick can stand 2px proud above and below it (`TICK_OVERHANG`). Painted inside a 6px actor it can only ever be flush, and a flush tick disappears into the fill it is meant to mark.
- **The excess past the tick keeps the brand orange.** It used to turn salmon (dark) or crimson (light), which read as a different measurement rather than as the same bar continuing. Geometry carries the verdict now: fill past the tick is over pace, and `-barlevel-overdrive-color` is gone with the classes that set it.
- **The tick colour is plain white on dark, plain black on light**, and `tools/a11y.js` measures all four pairs — tick against fill and against track, per scheme — at the 3:1 WCAG threshold for a non-text mark. `tickFindings()` in `tools/lib/contrast.js` reads the declared colours and blends the translucent track over the popup surface, because the pixel scan cannot reach a 2px mark inside a region. Worst pair is white on `#d97757` at **3.12:1**: it passes, with little room, so darkening the fill or the tick is the lever if that ever has to move.
- **The dark tick casts a 1px shadow to its left** (`-cq-tick-shadow-width`, `-cq-tick-shadow-color` on `.cq-bar-dark`), which is what carries the weakest pair — white on `#d97757` — past a smeared fill edge without moving a declared colour. Light comes from the right, so the band is on the left, and it stops at the bar's own 6px band: over the popup surface the tick already stands alone and a sliver there only reads as a thicker tick. The light scheme declares no shadow at all, since a black band beside a black tick buys no contrast. Geometry lives in `lib/bar.js` (`tickRects()`), unit-tested; the pixel proof is the column left of the tick reading `#98543d`, i.e. 30% black over the fill.
- **The popup surfaces those blends sit on are the shipped theme's**, sampled once rather than declared: `magick preview/dark-normal.png -crop 1x1+24+236 -format '%[pixel:p{0,0}]' info:` gave `#36363a` dark and `#fafafb` light. Re-sample them if a GNOME release repaints its menus.

## The panel ladder

The panel button carries as many quota values as fit and drops the rest from the right, down to the icon alone. `lib/panel.js` holds the two pure parts — the budget and the choice of how many cells to keep — and `_fitPanel()` in `extension.js` measures and applies it.

- **The budget is derived, never observed.** `availableWidth()` recomputes the shell's own terms from `ui/panel.js`: the right box is given `min(sideWidth, its natural width)`, where `sideWidth` is half of what the centre box leaves of the panel, offset by the work area. Reading our *allocated* width instead would make the decision depend on its own outcome — shrink, get more room, grow, shrink — so our own natural width is subtracted out of the other indicators' and every fit reads the same number the last one did.
- **A rung is measured, not calculated.** `_panelNaturalWidth(n)` sets the visibility for `n` cells and re-asks the container for its natural width. Summing label widths instead means re-deriving the box's spacing, the button's padding and the separators, all of which live in the stylesheet — the container already knows, and the answer is exact.
- **The first render happens before `addToStatusArea`.** Measuring a widget with no stage asks St for a theme node it will not resolve, which logs `st_widget_get_theme_node called on the widget … which is not in the stage` five times per render. `_fitPanel()` returns early until the actor is on the stage, and being added to the panel is itself a fit trigger, so nothing is lost.
- **Re-fits are deferred to `BEFORE_REDRAW`.** The triggers — the panel's width, the centre box's width, an indicator arriving in or leaving the right box — fire *during* allocation, where changing an actor's visibility is a relayout inside a relayout.
- **Keep order is not visual order.** The incident emoji is drawn last and dropped last, so `_panelKeepOrder` puts it first and the visible set is a prefix of that.
- **Each value is a block owning the dot and the gap to its left** (`.cq-panel-cell`, `padding-left`), so hiding one takes its own spacing with it and whatever survives still ends flush against the button. Only the dot needs deciding in visual order: the first block still showing has none, whichever block that turns out to be. The incident emoji's block carries the gap without a dot — it is not another value in the series — and when every block is hidden the container goes with them, or the box's own 4px spacing would sit beside the icon at the bottom of the ladder.
- **The button wears the platform's own `panel-status-indicators-box`.** That is the class the shell puts on its own multi-item panel buttons, and it is what zeroes `.system-status-icon`'s `padding: 0 6px` — without it a lone icon keeps 6px of air per side and the first value sits 7px further right than any native indicator's. The icon's remaining `margin: 0 4px` is then dropped by `.cq-panel-icon`, since the first block's own `padding-left` already provides that gap; the selector carries `#panel .panel-button .panel-status-indicators-box` to outrank the shipped rule. Measured ink-to-pill gap: **10px/10px**, against `quickSettings`' 13px/10px. Side padding declared by us instead — the `padding-right: 10px` this replaced — is the one thing nothing native has.

The harness squeezes the panel by adding a filler actor to the right box, since the emulated monitor cannot be resized once the shell is up. Two things about it are load-bearing:

- **The filler is sized from the ladder the extension just measured**, `floor(room − rung)`, so `narrow-two` means "room for two cells" whatever the font and the rendered text do. `ceil` undershoots by a fraction of a pixel, which silently costs one more value: the run showed `S 30%` where two values were asked for.
- **`settle_panel` waits for any queued fit before a control breaks anything.** A fit still pending for the next redraw lands on top of the break and repairs it, and `prove` then reports the assertion as unable to fail — which is exactly the failure `prove` exists to catch, arriving from the wrong direction.

## The status page

`https://status.claude.com/api/v2/summary.json` is a stock Atlassian Statuspage feed — no auth, no key, ~2 KB. Claude Code is component `yyzkbfz2thpt`; the other five (`claude.ai`, Console, API, Cowork, Government) are not consulted, and neither is the page-wide `status.indicator`, which aggregates across products that have nothing to do with this extension.

- **A component status is hand-set by Anthropic staff**, so it lags a real outage — but it is the only signal there is. `lib/policy.js` `serviceIssue()` names all five states — `operational` in `SERVICE_OK`, the four issues in `SERVICE_ISSUES` — and anything unmapped falls to `Service error`, because the vocabulary is theirs to extend and silence about a status we cannot read is worse than a shout. `operational` was absent from both until 2026-08-26, so the badge read `🚨 Service error` from the first healthy poll onwards and never cleared; before the 60-second timer existed nothing had ever handed the view a healthy status, which is why a defect this plain survived a test asserting it as correct.
- **It is polled on its own 60-second timer, with its own cancellable, and never from `refresh()`.** Until 2026-08-24 it was fetched only after our own request returned `5xx`, on the assumption that an outage would break our request too. That assumption cost the whole feature: `Elevated errors for multiple models` held Claude Code at `partial_outage` from 05:06 UTC while every usage request answered `200`, so the fetch never fired, `attempts.jsonl` had recorded **zero** status requests in its entire history, and the panel showed nothing for the duration. A code path with no records is not a rare path, it is an unreachable one — the log is what proved it. `test/fixtures/status-partial-outage.json` is that morning's live payload, incidents and all.
- **`service` is owned by the status poll alone.** `lib/state.js` deliberately mentions it nowhere: a usage result that cleared it would blink the badge out every five minutes, and one that invented `UNKNOWN_SERVICE` from a `5xx` would be the same borrowed-signal mistake in the other direction. `UNKNOWN_SERVICE` now means one thing only — the status page did not answer.
- **`claudeCodeService()` lives in `lib/model.js`, not `lib/usage.js`.** Anything importing `gi://` cannot be loaded by `node --test`, so payload parsing stays in the pure layer where a fixture can reach it (`test/fixtures/status.json`). It answers one object, `{status, until}`, for the same reason `_block` is one: the two are read together on every render and were never meaningful apart.
- **Only a maintenance window can be given an end.** Of the last fifty incidents the page published, not one carried a `scheduled_until` — the field exists on `scheduled_maintenances` alone. So `until` is read from a window that is `in_progress` or `verifying`, covers component `yyzkbfz2thpt`, and has not overrun its own estimate; an outage names no end because there is none to name, not because we declined to look.
- **The incident row wears the window on its own line when it cannot share.** `🚧 Under maintenance · until 4:55 PM` is 259 px against a 284 px popup and fits; the cross-day form (`until Fri 4:56 PM`) is 291 px and does not, so `_issueFits()` measures the row against `_body` and wraps rather than stretch every quota row by 7 px. `assert_incident_within_popup` holds that line in both themes, and it caught the row keeping a resolved incident's wording while hidden on the first run.

## Translations

The shell's `gettext` lives behind `resource:///org/gnome/shell/extensions/extension.js`, importable only inside the shell, and `lib/format.js`, `lib/model.js` and `lib/policy.js` all hold strings while being imported by `node --test`. So `lib/i18n.js` holds a translator that defaults to identity: `enable()` installs the real one, `disable()` drops it, and nothing is installed under the test runner, where every string therefore asserts as English. That default is the reason the suite never had to be re-baselined into a second language.

- **Translate where the value is read, never where it is declared.** `NAMES` in `lib/model.js` and `SERVICE_ISSUES` in `lib/policy.js` are module constants, evaluated at import — before `enable()` has run. `N_()` marks the msgid there and `_()` resolves it in `quotaName()` and `serviceIssue()`. Translating at the declaration compiles, renders, and silently freezes English forever.
- **`xgettext` reads call sites literally, so indirection hides strings from it.** The first extraction found 18 of 26: the panel initials sat behind a spread of an array constant, and every error string behind the `fail()` wrapper rather than the `describe()` the keyword named. Both would have shipped as English with nothing to show they were missing. If you add a wrapper that takes a msgid, it needs a `--keyword=` in `tools/i18n.sh`, and `npm run i18n:check` is what tells you.
- **A sentence assembled from a translated fragment and a variable cannot be translated.** `captionLine` used to join a duration to the word `left`; French agrees that participle with whichever unit leads — `4 j 0 h restants`, `4 h 08 restantes`, `1 min restante` — so each branch of `remainingLine()` is now its own `n_()` entry. The plural rule belongs to the `.po` header, not to a `count === 1` ternary: French counts zero as singular, Polish has three forms, Arabic six.
- **An error is two strings doing one job.** `lib/errors.js` `describe()` interpolates without translating, giving an English `message` for the `Error` and for `attempts.jsonl`, and keeps `{msgid, values}` for the popup to resolve at render. A diagnostic log whose language follows the host is worse than one carrying no text at all. `StatusClient`'s three messages are recorded and never rendered, so they are deliberately absent from the catalog.
- **Message language and number and time formatting come from different variables.** `timeLocale()` reads `LC_TIME`, `numberLocale()` reads `LC_NUMERIC`, and gettext reads `LC_MESSAGES`. A `LANG=en_US LC_NUMERIC=fr_FR` session wants English words and `21 %`, and gets them. Measured while writing the tests: ICU emits `U+00A0` before the percent sign, not the narrow `U+202F`, and French drops the leading zero on the hour.
- **Do not type a no-break space into a `.po`.** `Intl` supplies the one before `%`; a hand-typed invisible character is unreviewable in a diff. `test/po.test.js` covers what `msgfmt --check` cannot — it reads printf, not `{name}` — and fails on a translation that drops or renames a placeholder, which would put a literal `{time}` in front of a user.
- **The harness carries language and locale as two axes, because the code does.** `--language` sets `LC_MESSAGES`, `--locale` sets `LC_TIME` and `LC_NUMERIC`, and `LC_ALL` is deliberately unset in the nested session — it overrides both and is what made them inseparable. `--language=fr_FR` alone renders French wording on a 12-hour clock, which is how you tell a translation problem from a formatting one. Verified against a running shell rather than assumed: glibc honours an individual `LC_MESSAGES` over `LANG`, so the split is real.
- **Three separate ways a locale flag silently did nothing, all the same bug.** An attached preview session only restarted for a backend change, so a new `--locale` on a live session rendered the old one and reported success; `e2e.sh` runs `preview.sh` as a subprocess and never exported the variable, so `npm run e2e -- --locale=…` was a no-op that the README documented as working; and an ungenerated locale falls back to `C` without a word. `stale_axis()` now covers everything fixed at `start_shell`, the axes are exported, and `accept_locale` refuses what `locale -a` does not list. Anything else that can only take effect on a fresh shell belongs in `stale_axis()` too.
- **The fixtures cannot show whether the quota names translate.** They fabricate `i._quotas` with English names, so only `--live`, which goes through `quotas()` with real data, proves `Session (5 h)`, `Hebdomadaire`, `H` in the panel, and a model name like `Fable` correctly left alone.

Emoji in an `St.Label` render through Noto Color Emoji and **ignore the theme foreground entirely** — the `#d97757` / `popup-inactive-menu-item` work does not reach them. They also render taller than adjacent text, which is why `.cq-panel-issue` caps the size: uncapped, the glyph grows the whole top bar row. Write `⚠️` with its VS16 selector (`U+26A0 U+FE0F`); bare `U+26A0` falls back to text presentation at half the width and the line jitters between states. `test/policy.test.js` asserts that code point pair rather than comparing string literals, which would pass if both sides lost the selector together.
