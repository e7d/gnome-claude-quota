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

With `Display active account` switched on in the [Settings](#settings), a row under it pairs a dimmed `Account` label with the address Claude Code reports for the logged-in account, in full text colour. It is read from the same `~/.claude.json`, on every poll, and the row is hidden when the setting is off or no address can be read. It never widens the popup: a long address loses the end of its name first and keeps `@domain.tld` whole (`an.extraordinar…@organisation.org`), and a domain too long even for that is cut from its start (`bro…@…areallylongdomain.tld`); a long plan is cut at its end.

With `Display plan` switched on as well, a row of its own, `Plan` and `Max 5x`, follows it. The labels share one column and the values another, so there is no colon to separate them, and the block keeps the same margin below as the header has above it. The plan comes from the same `~/.claude.json`: `Pro`, `Max 5x`, `Max 20x`, `Team`, `Enterprise`, or, for a plan this extension has not met, its identifier made readable. Claude Code refreshes that profile itself, so a plan change shows after its next refresh and the extension's next poll.

There is no `Up to date` state: the timestamp beside the button already says how fresh the numbers are.

The button goes insensitive while a `429` is in force, and while the 2-minute floor between requests has not lifted — in both cases because clicking it could not send anything. Nothing in either response reports how much of the allowance is left, so the extension declines to be what spends it.

## Service problems

When [status.claude.com](https://status.claude.com/) reports the Claude Code component as anything other than operational, the extension appends an emoji after the quotas in the panel and a matching one-line status at the foot of the popup. That line is itself the button: clicking it opens the status page.

| Line | What it means |
|---|---|
| 🐢 Degraded performance | status.claude.com reports Claude Code as `degraded_performance` |
| ⚠️ Partial outage | reported as `partial_outage` |
| 🔴 Major outage | reported as `major_outage` |
| 🚧 Under maintenance | reported as `under_maintenance` |
| 🚨 Service error | the status page is unreachable, or answers something unrecognised |

The status page is polled on its own 60-second timer, independent of the quota poll. Neither one's answer decides the other's:

- An outage that leaves the usage endpoint healthy still shows. On 2026-08-24 Claude Code sat at `partial_outage` for hours while every usage request answered `200`; the panel is meant to say so, and your quota figures stay on display beside the emoji because they are still true.
- A failed usage request raises no service line by itself. An expired token or an unreachable host is your side of the wire, and the status page has nothing to say about it.
- `429` is not an outage either. The service is working and refusing you; the only sign is the refresh button greying out until the retry time.

status.claude.com is unauthenticated, on its own host, and shares nothing with the usage allowance — so the tighter cadence costs the quota poll neither a request nor a delay.

## Settings

```bash
gnome-extensions prefs claude-quota@e7d.io
```

Six groups:

- **Claude directory** — which Claude Code configuration directory to read the login from, `~/.claude` by default. The list offers every `~/.claude*` directory that holds a `.credentials.json`, each labelled with the account it is signed in to, so someone running two accounts side by side with `CLAUDE_CONFIG_DIR` (say `~/.claude` for work and `~/.claude-perso` for personal use) can switch between them. The folder button picks a directory anywhere else, and refuses one that holds no login; the reset button goes back to `~/.claude`. Switching drops the previous account's numbers at once and fetches the new one's; each directory keeps its own cache, so switching back shows its last numbers without a request.
- **Language** — `Automatic` by default, which follows the session's language and falls back to English when no catalog ships for it. Otherwise one entry per shipped catalog, each named in its own language and sorted by that name, which forces the extension's words to that language whatever the session uses. Times and numbers keep following the system locale. The panel, the popup and the settings window all switch at once.
- **Account** — `Display active account` and `Display plan`, both off by default: whether the popup names the logged-in account and its Claude plan. Most people use one account and know which it is, so these rows stay out of the way until you ask for them.
- **Thresholds** — the percentage at which a quota is shown as high usage and as critical, and whether crossing either posts a notification. `75%` and `90%` are this extension's own defaults, not Anthropic's, and the same two numbers decide both a quota's colour and whether it notifies — one setting, two effects. A reset button beside each restores the shipped default.
- **Show in top bar** — which of the three quotas (session, weekly, model-specific) appear in the panel.
- **Show in menu** — which of the three appear in the popup.

## Requirements

- **GNOME Shell 50**
- **Claude Code** signed in via OAuth

The extension reads your OAuth token from `~/.claude/.credentials.json`, or from `.credentials.json` in the directory chosen under **Claude directory** (read-only). It never writes to this file and never refreshes the token. If your token expires, the popup will show `Token expired, run Claude Code once` to refresh it.

## Install

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
git clone https://github.com/e7d/gnome-claude-quota ~/.local/share/gnome-shell/extensions/claude-quota@e7d.io
gnome-extensions enable claude-quota@e7d.io
```

To keep the checkout elsewhere and symlink it instead, link the clone by absolute path:

```bash
git clone https://github.com/e7d/gnome-claude-quota
mkdir -p ~/.local/share/gnome-shell/extensions
ln -sfn "$(realpath gnome-claude-quota)" ~/.local/share/gnome-shell/extensions/claude-quota@e7d.io
```

Run that from the directory *containing* the clone, not from inside it. Inside, `gnome-claude-quota` resolves against the repository itself and you get a symlink pointing at its own parent.

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
npm run coverage       # same suite, gated on coverage of lib/** plus a module census
```

`TZ` is pinned to `UTC` in the script because the test suite asserts absolute times and `Intl.DateTimeFormat` resolves against the system timezone. `LC_ALL` is pinned to `C` for the same reason applied to words: no translator is installed under `node --test`, so every string asserts as English.

`npm run coverage` gates `lib/**` at 100% lines, 100% functions and 95% branches, then runs `tools/coverage-census.js` to confirm every `lib/*.js` file was actually imported by the suite — a module the suite never imports has no coverage record at all, so it cannot fail a threshold either, which is exactly what the census exists to catch. `lib/usage.js` is the one exempt module; `docs/development.md` § Coverage and the module census has the rest.

## Translations

The extension speaks the language of the session it runs in, through GNOME's own gettext, unless the [Language](#settings) setting names a catalog — then `lib/catalog.js` reads that `.mo` file itself, because the shell's gettext follows the locale of the whole `gnome-shell` process and cannot be pointed at another language for one extension. English is the source; French ships as a catalog.

```bash
npm run i18n           # extract po/claude-quota.pot, merge po/*.po, compile locale/**.mo
npm run i18n:check     # exit non-zero if either is stale
```

`locale/**/*.mo` is compiled and committed, because this checkout is what a user installs — a translation that only appeared after `msgfmt` would not survive the trip. `npm run i18n:check` is what catches a string added to the code and never extracted, which otherwise renders in English with nothing to show it is missing.

To see a language rendered rather than trust that it is:

```bash
npm run preview -- --live --language=fr_FR --locale=fr_FR --capture
npm run e2e -- --group=state --dark-only --language=fr_FR --locale=fr_FR
```

They are two axes, not one. `--language` selects the catalog (`LC_MESSAGES`); `--locale` selects the clock and the number format (`LC_TIME`, `LC_NUMERIC`). Varying one alone is how you tell a translation problem from a formatting one:

```bash
npm run preview -- --live --language=fr_FR --capture   # French words, 12-hour clock, 73%
npm run preview -- --live --locale=fr_FR --capture     # English words, 24-hour clock, 73 %
```

`.UTF-8` is the default suffix, so `fr_FR` and `fr_FR.UTF-8` are the same thing and `fr_FR.ISO-8859-1` still says what it means. Either axis must name a locale generated on the host — `locale -a` lists them — and an unknown one is refused rather than quietly falling back to `C`.

Screenshots land in `preview/` when both axes are default and in `preview/<language>-<locale>/` otherwise — `preview/fr_FR-C/`, `preview/C-fr_FR/`. A locale round therefore sits beside the English one instead of overwriting it, and `npm run a11y` keeps scoring `preview/` alone unless you point it somewhere else.

Adding a language is a catalog and nothing else:

```bash
msginit --locale=de --input=po/claude-quota.pot --output=po/de.po
# add de to LANGS in tools/i18n.sh, translate po/de.po, then:
npm run i18n
```

The Language setting lists every catalog under `locale/` on its own, so a new one appears there with no code change.

## Development

A running GNOME session caches extension code for its whole lifetime, so testing a change otherwise means logging out. `tools/preview.sh` instead owns one named nested shell that runs this extension and nothing else, and can be recalled to reshape it live instead of restarting it:

```bash
npm run dev          # tools/preview.sh --windowed, Ctrl-C to stop
npm run dev:watch    # same, restarted on every source edit
```

Either tool runs from any checkout, including a git worktree: the nested session links the checkout it was started from, so nothing needs installing first and the copy under `~/.local/share/gnome-shell/extensions` is never involved.

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
| `--prefs` | Open the preferences window in the session |
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

Groups: `state`, `panel`, `hover`, `refresh`, `notify`, `lifecycle`. `lifecycle` destroys the indicator, so it runs last and every earlier group needs a live one. `state` is what shoots the grid, so a run excluding it leaves `preview/` exactly as it was.

### Notification thresholds

The [Settings](#settings) window is the normal way to change these. The same keys are also
readable and writable directly, which is what the preview and e2e harnesses do:

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/claude-quota@e7d.io/schemas \
    set org.gnome.shell.extensions.claude-quota warning-percent 70
```

`warning-notify`, `warning-percent`, `critical-notify` and `critical-percent` — booleans
default to `true`, the percentages to 75 and 90. A change takes effect at once: lowering a
threshold below a quota's current percentage notifies immediately, and disabling a level
withdraws whatever it had posted.

A notification's body counts down, so while one is on screen it is rewritten every minute and
the tray keeps agreeing with the popup rather than with the moment it fired. The rewrite is
silent — the same notification, updated in place, with the timestamp it was raised at left
alone. Crossing into another tier is a different thing and posts anew, and a notification you
dismissed stays dismissed: the record outlives the banner, which is what stops the next poll
putting it straight back.

That minute tick also re-runs the policy, which needs no network — so a window ending while the
extension is rate-limited clears its banner within the minute instead of waiting for a fetch it
is not allowed to make.

### Watching a notification happen

A preview session posts real notifications, so `--scenario=warning` puts a banner on screen
rather than only colouring the panel:

```bash
npm run preview -- --scenario=warning
npm run preview -- --scenario=critical      # recall it: the warning gives way to a critical
npm run preview -- --capture=notify         # shoot preview/notify-<theme>-<scenario>.png
```

Recalls are transitions, not fresh sightings. The session pins a window anchor at start, so a
scenario's reset time holds still across recalls and the record behaves the way it does in
production: the same scenario twice is silent, and only a genuine crossing fires. `--notify=`
picks the mode — `natural` (default), `fresh` to clear the record and see a scenario as a first
encounter, `tray` to post with the banner suppressed, `off` to post nothing.

The capture stacks the banner over the message-tray list, because only one banner is on screen
at a time while the rest queue behind it — the tray is the only surface showing all of them. A
`notify-` tile is deliberately skipped by `npm run a11y`: those pixels are the shell's own
chrome, and the rule here is to change what is ours and leave what is GNOME's.

`npm run e2e` blocks banners for its whole run through the shell's own `bannerBlocked`, so a
banner can never drift across one of the 62 tiles; the notify group drives the record itself and
asserts against the tray, which is why its verdicts do not depend on what a shoot left up.

Shooting every scenario is now the default, so a bare `npm run e2e` costs minutes — 31 scenarios in both themes is 62 tiles plus `overview.png`. The fast path while iterating is a narrowed run (`--group=`, `--scenario=`, `--dark-only`) or `--assert` when only behaviour, not pixels, is in question.

Every assertion is proven able to fail before it is trusted, on every run. Verdicts are marked `✅ ok` and `❌ FAIL`, so a failure stands out in a long log. A `❌ control …` line on stderr with a non-zero exit means **the assertion is dead, not the extension** — fix the assertion, never the control. `docs/development.md` § Asserting what it does carries the rest.

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

A finding is reported as accepted rather than failed when **both** halves hold: its background is one of the greys GNOME paints under a hovered or pressed panel button, and its ink is one of the four severity colours, read out of `stylesheet.css` rather than copied beside the waiver. Severity colours are judged against the top bar and the popup card, and darkening amber until it clears a surface that exists for as long as the pointer rests there would cost the colour its meaning — which is a trade no other ink can claim, so no other ink is waived on those greys. Each accepted pair is printed with the ratio it was let through at, so the waiver is never a threshold quietly lowered.

What that costs: text on a saturated background is never measured, nor is anything within three pixels of a bar or an emoji; colour emoji are scored as though they were text, which is what the `service-error` shots report; the ratio comes from the strongest pixel of a stroke, so a stroke too thin to ever reach its own colour is scored optimistically; and large text is inferred from glyph height, which reads short on a word with no ascender and so errs towards the stricter threshold. It measures pixels, not CSS — a colour no scenario renders is a colour it never checks.

### Continuous integration

`.github/workflows/ci.yml` runs the checks you would run by hand as separate jobs, so each reports its own status and a failure names its stage. An `image` job goes first and the rest wait for it. The stages are `lint` (`npm run lint` and `shellcheck -x` over `tools/`), `test`, `coverage`, `e2e` and, once `e2e` is done, `a11y` over exactly what it shot. A last job, `report`, gathers the others. It fails when any job did not succeed, and when any e2e shard left no summary line, so a shard that crashed silently cannot read as a pass.

The workflow has no `permissions` block: Forgejo ignores it and warns once per job. On GitHub, set the repository's default workflow permissions to read-only (Settings, Actions, General), since the jobs only read the repository. The workflow exists twice. Forgejo's runner sets its own `GITHUB_SERVER_URL` for every action and cannot be overridden from a workflow, while the official artifact action refuses any server but github.com, so `.forgejo/workflows/ci.yml` uses the Forgejo forks of the two artifact actions and `.github/workflows/ci.yml`, which GitHub runs, uses the official ones. Everything else is shared through `.github/actions` and `.github/ci-image.sh`, and `test/workflows.test.js` fails when the two files differ anywhere except their four artifact lines.

`e2e` runs as three jobs in parallel, each booting its own nested shell, so none depends on another. A two-entry matrix, `state-dark` and `state-light`, splits the scenario matrix by theme and shoots the ten scenarios `a11y` scores, and a separate job, `behaviour`, carries every other group plus one scenario in both themes (the check that a severity repaints per scheme only runs when one invocation covers both themes). `behaviour` shoots nothing, which is why it is not part of the matrix: a job waits for every leg of a matrix, and `a11y` needs only the two state shards. Each job uploads its log, and the state shards their screenshots, as an artifact named `e2e-<name>`, kept for seven days. `a11y` downloads the two screenshot sets, and `report` downloads every log and prints one table of passed and failed per job, with the total. `tools/ci-report.js` builds that table; the same table is written to the job summary where the runner supports one.

The screenshots need a whole GNOME session, so every job runs inside an image built from `.github/ci.Dockerfile` — Arch plus `gnome-shell`, ImageMagick, Node and the fonts the shots depend on. `.github/actions/ci-container` starts that container for each job. The image always carries the GNOME that Arch ships today, and one job, `image`, owns that. It asks archlinux.org which `gnome-shell` is current, once per run, and tags the image with a digest of the Dockerfile plus that version; a new release is a new tag, so a run never tests an older GNOME than the current one. It publishes the image to the Forgejo registry only if that tag is not there yet, checking with a manifest lookup that downloads nothing, and hands the tag to every other job, which pulls exactly that image. The version is also a build argument, so a cached layer cannot hide the update, and `pacman -Q gnome-shell` is checked against it before the image is pushed and again by each job that pulls it. Where there is no registry to share an image through (the GitHub mirror), `image` does nothing and each job builds its own.

The build is cached at two levels. The published image is the first: while the tag exists, nothing is built at all. The second only matters when the tag changes, because a new GNOME has to redo the large `pacman` layer; the package downloads behind it are a BuildKit cache mount, so a rebuild fetches the packages that changed and not the whole set. That mount lives in the runner's own BuildKit cache, so a runner that has never built the image starts cold. `.github/logind-stub.sh` supplies the `org.freedesktop.login1` service that `gnome-shell` refuses to start without and no container provides.

Two of the waived pill greys exist only for CI. A shell running in a container paints the top bar transparent as soon as a pointer device exists, where the same GNOME on a workstation paints it opaque black — so CI shoots GNOME's pill over the desktop rather than over the panel, and lands on `#5e5e61` / `#46464a` instead of `#2b2b2b` / `#474747`. Everything else in the shots is byte-identical between the two, ink colours included. The cause sits inside GNOME's own panel styling; version, renderer, wallpaper, dconf, animation timing, colour scheme and session mode were each measured and excluded.

Between them the e2e shards assert every scenario in both themes and photograph ten of them: `normal`, `warning`, `critical`, `model-scoped`, `error`, `service-major`, `over-pace`, `rate-limited`, `rate-limited-day` and `no-data`. Between them they render every colour `a11y` can measure — each severity, the pace verdict, the status button, the error surface and the empty-state text. The scenarios left out differ in text rather than in colour, and photographing all 62 would cost minutes per run to say the same thing.

It replaced a step that shot six of those scenarios and asserted nothing: the screenshots were never kept, so all a preview run could prove was that six states rendered without throwing. They are now kept, but only as the hand-off between `e2e` and `a11y` and for a week of inspection after a failure. An assertion is a property read back over `Eval` and costs a fraction of a screenshot, so the same shell boot now checks every state and every interaction, and still produces the shots the contrast scan scores.

## License

GPL-2.0-or-later — the full text is in [`LICENSE`](LICENSE). It matches the licence GNOME
Shell itself carries, which is the one an extension importing its modules can rely on.

---

This extension is not affiliated with or endorsed by Anthropic.
