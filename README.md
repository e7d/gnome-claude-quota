# claude-quota

A GNOME Shell indicator showing your Claude Code subscription quota usage: the 5-hour session window and the weekly window.

```
Panel:  ✳ S 5% · W 37%

Popup:
  Session (5h)                 5%
  ▓▓▓░░░╵░░░░░░░░░░░░░░░░░░░░░░░░
  4h 08m left · 13:59

  Weekly                      37%
  ▓▓▓▓▓▓▓▓▓▓▓╵▓░░░░░░░░░░░░░░░░░░
  3d 22h left · sam. 09:59
```

(Reset times are formatted in your system locale. The example shows French.)

## What the display means

The panel shows your quota consumption as text labels (`S 5% · W 37%`) with a small icon:

- **`S`** is your 5-hour session quota
- **`W`** is your weekly quota
- A model-scoped quota appears only when its usage is above 0%, labelled with the model's initial. `Opus`, `Sonnet`, `Fable` display as `O`, `So`, `F` respectively (a second letter is added if initials collide)

When the top bar runs out of room — a narrow screen, or enough other indicators beside it — values give way from the right, one at a time: the model-scoped one first, then the weekly, then the session, leaving the icon alone. The popup always holds the full set. A service-incident emoji is the last thing to go, after every value.

Each quota's bar in the popup visualizes usage within its time window:

- The fill shows how much quota you've used
- The thin tick mark shows how far the current window has run (e.g., 1 hour into a 5-hour session)
- Fill past the tick means you're spending quota faster than the clock is running

The popup displays the remaining time until each quota resets.

## Refreshing

The extension polls every 5 minutes, and again when you open the popup if the cached data is more than a minute old.

Before asking the endpoint anything, it looks at Claude Code's own cache. Claude Code stores the same payload in `~/.claude.json` and refreshes it whenever you open its usage view, so if its copy is newer than ours, the extension adopts it and sends nothing — the two tools share one set of numbers instead of each buying their own. It is read-only: the extension never writes to that file. A copy belonging to a different account, or one with no readable timestamp, is ignored rather than trusted.

Whatever asks — the timer, the popup, the button — **no two requests go out less than 2 minutes apart**. The allowance is five requests per five minutes and it is shared with Claude Code itself, so the extension keeps to a share of it rather than racing for the window. A request refused by that floor is not dropped: it is scheduled for the moment the floor lifts, so opening the popup on minute-old data does bring the next poll forward, just no closer than the floor allows.

The popup's first line carries `Last refresh: 10:48 AM` with a circular-arrow button on the right. Clicking it polls and **leaves the popup open**, so the numbers land in front of you. The icon spins while the poll is in flight and the button is insensitive until it finishes, so a poll cannot be fired twice.

There is no `Up to date` state: the timestamp beside the button already says how fresh the numbers are.

The button goes insensitive while a `429` is in force, and while the 2-minute floor between requests has not lifted — in both cases because clicking it could not send anything. Nothing in either response reports how much of the allowance is left, so the extension declines to be what spends it.

## Service problems

When a usage request comes back `5xx`, the extension appends an emoji after the quotas in the panel and a matching one-line status at the foot of the popup. That line is itself the button: clicking it opens [status.claude.com](https://status.claude.com/). A single failure is enough to raise it — there is no failure counter to wait out.

| Line | What it means |
|---|---|
| 🐢 Degraded performance | status.claude.com reports Claude Code as `degraded_performance` |
| ⚠️ Partial outage | reported as `partial_outage` |
| 🔴 Major outage | reported as `major_outage` |
| 🚧 Under maintenance | reported as `under_maintenance` |
| 🚨 Service error | the request failed, but the status page reads operational, is unreachable, or answers something unrecognised |

The wording comes from the Claude Code component on [status.claude.com](https://status.claude.com/); the *decision to show anything at all* comes from your own failed request. Two consequences follow:

- A degraded status page with no local failures shows nothing. If your requests all succeed, you are not in the outage.
- `429` is not a failure. The service is working and refusing you, so it raises no error line and no status row — the status page cannot explain a spent allowance. The only sign is the refresh button greying out until the retry time.

A failure the service is not responsible for — an expired token, an unreachable host — states itself on the same line but stays inert, because status.claude.com has nothing to say about it.

The status page is only fetched **after** a `5xx`, so the ordinary 5-minute poll stays a single request and a status.claude.com outage cannot slow it down.

## Requirements

- **GNOME Shell 50**
- **Claude Code** signed in via OAuth

The extension reads your OAuth token from `~/.claude/.credentials.json` (read-only). It never writes to this file and never refreshes the token. If your token expires, the popup will show `Token expired, run Claude Code once` to refresh it.

## Install

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
git clone https://github.com/e7d/claude-quota ~/.local/share/gnome-shell/extensions/claude-quota@e7d.io
gnome-extensions enable claude-quota@e7d.io
```

To keep the checkout elsewhere and symlink it instead, link the clone by absolute path:

```bash
git clone https://github.com/e7d/claude-quota
mkdir -p ~/.local/share/gnome-shell/extensions
ln -sfn "$(realpath claude-quota)" ~/.local/share/gnome-shell/extensions/claude-quota@e7d.io
```

Run that from the directory *containing* the clone, not from inside it. Inside, `claude-quota` resolves against the repository itself and you get a symlink pointing at its own parent.

On Wayland, a running shell session does not detect newly installed extensions until you log out and back in. If `gnome-extensions enable` reports `Extension "claude-quota@e7d.io" does not exist`, log out first. It is not a sign of a broken install.

## Lint

```bash
npm ci                 # oxlint, the only dependency this repository has
npm run lint
```

The extension itself installs nothing — `node_modules/` exists for the linter and stays out of git. [oxlint](https://oxc.rs) is a Rust linter that reads the whole repository in a few milliseconds, and it prints nothing when everything passes.

`.oxlintrc.json` runs the `correctness`, `suspicious` and `perf` rule sets, plus `no-undef`, `no-unused-vars`, `eqeqeq`, `no-var` and `prefer-const`. It turns `no-underscore-dangle` off, because `_private` is GNOME Shell's own convention and enforcing the rule reported 324 violations of it. The files that run inside the shell get the globals that only exist there — `global`, `log`, `logError`, `TextDecoder`, `TextEncoder` — while `test/` and `tools/` are linted as Node.

## Tests

```bash
npm test
```

`TZ` is pinned to `UTC` in the script because the test suite asserts absolute times and `Intl.DateTimeFormat` resolves against the system timezone.

## Development

A running GNOME session caches extension code for its whole lifetime, so testing a change otherwise means logging out. `tools/preview.sh` instead owns one named nested shell that runs this extension and nothing else, and can be recalled to reshape it live instead of restarting it:

```bash
npm run dev          # tools/preview.sh --windowed, Ctrl-C to stop
npm run dev:watch    # same, restarted on every source edit
```

This needs the extension installed as a symlink to *this* checkout, as in the second install recipe above; `preview.sh` refuses to start otherwise rather than silently running some other copy.

The nested session runs with a home directory of its own, holding no credentials, so **it never calls the usage endpoint** — scenarios are fabricated, and `--live` renders the values your own panel last cached. Nothing you run here spends a request or touches your real cache.

Both are thin wrappers. Pass flags through `npm` with a `--` separator, or call the script directly:

```bash
npm run preview -- --dark --scenario=loading
tools/preview.sh --dark --scenario=loading
```

| Flag | Effect |
| --- | --- |
| `--session=<name>` | Name the session (default `preview`) |
| `--windowed` | Show the session in a Mutter devkit window (default) |
| `--headless` | Run with no window, driven over D-Bus |
| `--dark`, `--light` | Force a colour scheme |
| `--scenario=<name>` | Render a fabricated state |
| `--live` | Render your own last-cached values (default) — reads the cache, never the endpoint |
| `--close` | Leave the popup closed and the pointer away (default) |
| `--hover` | Leave the pointer on the panel button |
| `--open` | Leave the popup open |
| `--capture` | Shoot `preview/<theme>-<scenario>.png` of the shape applied |
| `--watch` | Restart the shell whenever a source file changes, replaying the shape |
| `--detach` | Start the session and return instead of blocking |
| `--stop` | Tear the session down |
| `-h`, `--help` | Print the flags and the scenario names, and exit |

Calling `preview.sh` again while its session is up changes the shape instead of starting a second one, and **an option you leave out is left alone** — `tools/preview.sh --light` repaints and changes nothing else. On a fresh session the defaults above apply.

Each script names the commands it is missing rather than failing on the first one, though `preview.sh` checks per path rather than all at once: the install check runs when a session starts, `--watch`'s tools once the shell is up, and `--capture`'s `magick` at the first shot. Shared: `gnome-shell`, `dbus-run-session`, `dconf`, `gsettings`, `gdbus`. `--watch` also wants `find`, `stat`, `sha256sum` and `xargs`; `preview.sh` and `e2e.sh` want ImageMagick's `magick`, and skip `overview.png` alone if `montage` is absent.

`--windowed` needs the `mutter-devkit` package, matching your `mutter` version; that one only warns rather than failing, so the session still runs with nothing to look at. Its window opens at 1280×800, which is too narrow for a third quota to render without ellipses — drag it larger and the emulated monitor follows immediately, panel and all. Nothing else will do it: there is no geometry flag on either binary, no environment variable, no gschema key and no D-Bus method, the window is a native Wayland client so no window manager can reach it, and the size is not remembered, because each session gets a private config home that is discarded with it. So a fresh windowed session always starts narrower than a headless capture of the same state. `--headless` is unaffected: it takes its size from `--virtual-monitor` instead, fixed at 1440×900 in `tools/lib/devkit.sh`.

Without `--dark` or `--light` the colour scheme resets to the GNOME default rather than inheriting your desktop, as do the wallpaper and accent colour, so a session looks the same on any machine. Your own settings are untouched: the nested shell gets a private copy of dconf, and every write to it happens inside that session's own bus.

`--watch` restarts the whole shell rather than reloading the extension, because a disable/enable cycle re-runs the cached modules and would silently ignore your edit — and editing `tools/preview.sh` itself while a watcher is running corrupts it mid-read, so stop the watcher first.

`--capture` is the fast path for a screenshot while nobody is watching:

```bash
npm run preview -- --headless --detach --scenario=loading --capture
```

which shoots one tile and prints the path it wrote, then returns instead of blocking. The scenarios live in the `SCENARIOS` array in `tools/lib/indicator.sh`, each paired with a `setup_for` case that fabricates the state. `preview/` is gitignored: the shots are local artifacts, and their exact dimensions vary with whatever your live quota text happens to be.

Each `<theme>-<scenario>.png` stacks three shots of the same state, one per panel-button state: resting with the pointer parked away, hovered with the menu still shut, then pressed with the menu open. All three are cropped to the same width, and every stack is then padded to the tallest one, so the panel row sits at the same place in all of them. The hovered band is not decoration — the pill the theme paints under a hover is a surface the quota colours have to sit on, and `npm run a11y` cannot judge a surface no screenshot contains. That is what lets `overview.png` be scanned as a grid — a contrast regression shows up as one tile differing from its neighbours rather than something you have to hunt for.

`npm run e2e` boots a throwaway shell of its own, asserts what it finds there — that every popup row is filled, that the panel labels agree with the blocks beneath them, that a severity repaints between the two schemes, that only a panel button takes a hover, that a refresh spins its icon and leaves nothing spinning, and that disabling the extension releases its timer and its in-flight fetch — and shoots the grid as it goes.

```bash
npm run e2e                                    # every scenario, both themes — minutes
npm run e2e -- --group=hover                   # one group
npm run e2e -- --group=state --dark-only --scenario=normal
npm run e2e -- --assert                        # behaviour only, shoots nothing
```

| Flag | Effect |
| --- | --- |
| `--headless` | Run with no window, driven over D-Bus (default) |
| `--windowed` | Show the session in a Mutter devkit window |
| `--dark-only` / `--light-only` | Assert one theme instead of both |
| `--scenario=<name>` | Assert one scenario; repeat the flag for several |
| `--group=<name>` | Run one group; repeat the flag for several |
| `--a11y` | Shoot only the ten scenarios `npm run a11y` scores |
| `--assert` | Shoot nothing, leaving `preview/` alone |
| `-h`, `--help` | Print the flags, the groups and the scenario names, and exit |

Groups: `state`, `panel`, `hover`, `refresh`, `lifecycle`. `lifecycle` destroys the indicator, so it runs last and every earlier group needs a live one. `state` is what shoots the grid, so a run excluding it leaves `preview/` exactly as it was.

Shooting every scenario is now the default, so a bare `npm run e2e` costs minutes — 31 scenarios in both themes is 62 tiles plus `overview.png`. The fast path while iterating is a narrowed run (`--group=`, `--scenario=`, `--dark-only`) or `--assert` when only behaviour, not pixels, is in question.

Every assertion is proven able to fail before it is trusted, on every run. A `control …` line on stderr with a non-zero exit means **the assertion is dead, not the extension** — fix the assertion, never the control. `docs/development.md` § Asserting what it does carries the rest.

`tools/lib/devkit.sh` owns the session lifecycle shared by all three scripts — the private dconf copy, starting and stopping the shell, `Eval` over D-Bus, and choosing the backend. `tools/lib/indicator.sh` drives the extension into a state, `tools/lib/capture.sh` turns that state into a PNG, and `tools/lib/assert.sh` holds the assertion primitives, so `preview.sh` and `e2e.sh` are drivers over one shared layer and a fix to any of it lands in one place. Nothing under `tools/lib/` is meant to be run directly.

`npm run a11y` reads those screenshots back and measures colour contrast, so a scheme that leaves a label unreadable fails a check instead of waiting to be noticed:

```bash
npm run a11y                           # every preview/*.png except overview.png
npm run a11y -- preview/dark-full.png  # or named files
```

It wants `magick` and `node`, prints the pairs it measured per file and a total, and exits `1` while anything is under threshold — `2` if a file cannot be read — so it can gate CI.

It also measures the pace tick, which no screenshot can settle: a 2px mark inside a bar is a region by the scanner's own rules, so its four pairs come from the declared colours instead — the tick against the bar's fill and against its track, in both schemes, at the 3:1 WCAG threshold for a non-text mark. Those four print with the rest and count towards the same exit code.

`npm run logs` shows what the extension actually exchanged with the two endpoints. Every attempt appends one line to `~/.cache/claude-quota/attempts.jsonl`, including the ones declined before a request was sent — the instant, the endpoint, what triggered it, the outcome, the status, the `retry-after`, the round trip, the token expiry known at the time, the response headers worth keeping and the body of anything that failed. Never a token: headers are kept by allowlist, so an unfamiliar credential header is dropped without having to be anticipated.

```bash
npm run logs                              # today, one line per exchange
npm run logs -- --all --runs              # consecutive outcomes collapsed into runs
npm run logs -- --detail                  # headers and error bodies too
```

`npm run attribution` answers a different question over the same log: when the usage endpoint starts refusing with `429`, what is spending the allowance. It joins the log against Claude Code's own session starts, taken from transcript birth times and metadata only, and prints both per hour with a verdict:

```bash
npm run attribution                       # ±10 minutes around a session start
npm run attribution -- --window=20        # widen the correlation window
```

It says *no data* when the log is empty and *cannot attribute* when there is no `429` in it, rather than reporting all clear, and prints the thresholds it applied beside the verdict. `docs/development.md` § Attributing a 429 carries the record shape and the reasoning.

Pairing a foreground with its background is the hard part, and the method is an inference with known edges. The image is swept in 16px windows: the dominant colour of a window is the background, the minority colours are ink, and each ink is measured against that background under WCAG 2.1 — 4.5:1 for normal text, 3:1 once the glyph stands 18px or taller. Three filters keep that from degenerating into noise:

- Only neutral surfaces are measured. The crop also catches the wallpaper behind the popup and whatever else GNOME parks in the top bar, and those are saturated; this extension only ever paints ink onto grey.
- Anything whose interior sits more than two pixels from its own background is a region rather than ink — the wallpaper, another indicator's pill, a progress bar. Windows touching one are skipped.
- Anti-aliasing lays a ramp of blends between ink and background. A colour on the line between the background and a stronger ink nearby is dropped, so a half-lit edge pixel is not reported as faint text.

A finding on the pill GNOME paints under a hovered or pressed panel button is reported as accepted rather than failed, and counted in the per-file line so the waiver is never silent. Those four greys are the only surfaces treated that way: severity colours are judged against the top bar and the popup card, and darkening amber until it clears a surface that exists for as long as the pointer rests there would cost the colour its meaning.

What that costs: text on a saturated background is never measured, nor is anything within three pixels of a bar or an emoji; colour emoji are scored as though they were text, which is what the `service-error` shots report; the ratio comes from the strongest pixel of a stroke, so a stroke too thin to ever reach its own colour is scored optimistically; and large text is inferred from glyph height, which reads short on a word with no ascender and so errs towards the stricter threshold. It measures pixels, not CSS — a colour no scenario renders is a colour it never checks.

### Continuous integration

`.github/workflows/ci.yml` runs the same checks you would run by hand, in that order: `npm ci` then `npm run lint`, `shellcheck -x` over `tools/`, `npm test`, `npm run e2e`, then `npm run a11y` over exactly what that run shot.

The screenshots need a whole GNOME session, so every step runs inside an image built from `.github/ci.Dockerfile` — Arch plus `gnome-shell`, ImageMagick, Node and the fonts the shots depend on. Its tag is a digest of that Dockerfile and it lives in the Forgejo registry, so a run rebuilds the image only when the file changes and pulls it otherwise. `.github/logind-stub.sh` supplies the `org.freedesktop.login1` service that `gnome-shell` refuses to start without and no container provides.

Two of the waived pill greys exist only for CI. A shell running in a container paints the top bar transparent as soon as a pointer device exists, where the same GNOME on a workstation paints it opaque black — so CI shoots GNOME's pill over the desktop rather than over the panel, and lands on `#5e5e61` / `#46464a` instead of `#2b2b2b` / `#474747`. Everything else in the shots is byte-identical between the two, ink colours included. The cause sits inside GNOME's own panel styling; version, renderer, wallpaper, dconf, animation timing, colour scheme and session mode were each measured and excluded.

The e2e step asserts all 31 scenarios in both themes and photographs ten of them: `normal`, `warning`, `critical`, `model-scoped`, `error`, `service-major`, `over-pace`, `rate-limited`, `rate-limited-day` and `no-data`. Between them they render every colour `a11y` can measure — each severity, the pace verdict, the status button, the error surface and the empty-state text. The scenarios left out differ in text rather than in colour, and photographing all 62 would cost minutes per run to say the same thing.

It replaced a step that shot six of those scenarios and asserted nothing: the screenshots are never uploaded, so all a preview run could prove was that six states rendered without throwing. An assertion is a property read back over `Eval` and costs a fraction of a screenshot, so the same shell boot now checks every state and every interaction, and still produces the shots the contrast scan scores.

---

This extension is not affiliated with or endorsed by Anthropic.
