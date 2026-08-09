# claude-quota

A GNOME Shell indicator showing your Claude Code subscription quota usage: the 5-hour session window and the weekly window.

```
Panel:  ✳ S 5% · W 37%

Popup:
  Session                      5%
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

Each quota's bar in the popup visualizes usage within its time window:

- The fill shows how much quota you've used
- The thin tick mark shows how far the current window has run (e.g., 1 hour into a 5-hour session)
- Fill past the tick means you're spending quota faster than the clock is running

The popup displays the remaining time until each quota resets.

## Refreshing

The extension polls every 5 minutes, and again when you open the popup if the cached data is more than a minute old. `Refresh now` forces a poll and leaves the popup open, so you can watch the numbers land. Its label doubles as the reason it is unavailable:

| Label | State |
|---|---|
| `Refresh now` | the data is older than a minute; clicking polls |
| `Refreshing…` | a poll is in flight |
| `Up to date` | the data is younger than a minute, so a poll would return the same numbers |
| `Refresh at 11:27 PM` | a `429` is in force, and this is the earliest retry it allowed |

The button obeys the same staleness rule as opening the popup, because the `429` allowance is shared with every other Claude extension on the machine. Nothing in either response reports how much of it is left, so the extension declines to be what spends it.

`Claude status` opens [status.claude.com](https://status.claude.com/) and appears only once something has actually failed.

## Service problems

When a usage request comes back `5xx`, the extension appends an emoji after the quotas in the panel and a matching one-line status at the foot of the popup, beside `Claude status`. A single failure is enough to raise it — there is no failure counter to wait out.

| Line | What it means |
|---|---|
| 🐢 Degraded performance | status.claude.com reports Claude Code as `degraded_performance` |
| ⚠️ Partial outage | reported as `partial_outage` |
| 🔴 Major outage | reported as `major_outage` |
| 🚧 Under maintenance | reported as `under_maintenance` |
| ❗ Service error | the request failed, but the status page reads operational, is unreachable, or answers something unrecognised |

The wording comes from the Claude Code component on [status.claude.com](https://status.claude.com/); the *decision to show anything at all* comes from your own failed request. Two consequences follow:

- A degraded status page with no local failures shows nothing. If your requests all succeed, you are not in the outage.
- `429` is not a failure. The service is working and refusing you, so it raises no status, and `Claude status` stays hidden — the status page cannot explain a spent allowance. The refresh action names the retry time instead.

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

## Tests

```bash
npm test
```

`TZ` is pinned to `UTC` in the script because the test suite asserts absolute times and `Intl.DateTimeFormat` resolves against the system timezone.

## Development

A running GNOME session caches extension code for its whole lifetime, so testing a change otherwise means logging out. `npm run dev` instead starts a throwaway nested shell that runs this extension and nothing else:

```bash
npm run dev          # nested shell in a window, Ctrl-C to stop
npm run dev:watch    # same, restarted on every source edit
```

This needs the extension installed as a symlink to *this* checkout, as in the second install recipe above; `tools/dev.sh` refuses to start otherwise rather than silently running some other copy.

Both are thin wrappers around `tools/dev.sh`. Pass its flags through `npm` with a `--` separator, or call the script directly:

```bash
npm run dev -- --watch --light
tools/dev.sh --watch --light
```

| Flag | Effect |
| --- | --- |
| `--watch` | Restart the shell whenever a source file changes |
| `--windowed` | Show the session in a Mutter devkit window (default here) |
| `--headless` | Run with no window, driven over D-Bus |
| `--dark` | Force `prefer-dark` |
| `--light` | Force `prefer-light` |

Each script checks what it needs up front and names everything that is missing at once. Shared: `gnome-shell`, `dbus-run-session`, `dconf`, `gsettings`, `gdbus`. `--watch` also wants `find`, `stat`, `sha256sum` and `xargs`; `preview.sh` wants ImageMagick's `magick`, and skips `overview.png` alone if `montage` is absent.

`--windowed` needs the `mutter-devkit` package, matching your `mutter` version. That one only warns rather than failing: the session still runs, there is just nothing to look at.

Without `--dark` or `--light` the colour scheme resets to the GNOME default rather than inheriting your desktop, as do the wallpaper and accent colour, so a session looks the same on any machine. Your own settings are untouched: the nested shell gets a private copy of dconf, and every write to it happens inside that session's own bus.

Watch mode restarts the whole shell rather than reloading the extension, because a disable/enable cycle re-runs the cached modules and would silently ignore your edit.

`npm run preview` regenerates the screenshots in `preview/`. It takes the same `--windowed` / `--headless` pair, defaulting to headless — the opposite of `dev.sh` — so add `--windowed` to watch it work:

```bash
npm run preview -- --windowed
```

Each `<theme>-<scenario>.png` stacks two shots of the same state: on top the panel with the menu shut and the pointer parked away, below it the menu open with the pointer on the pill. Both halves are cropped to the same width, and every pair is then padded to the tallest one, so the panel row sits at the same place in all of them. That is what lets `overview.png` be scanned as a grid — a contrast regression shows up as one tile differing from its neighbours rather than something you have to hunt for.

The scenarios live in the `SCENARIOS` array in `tools/preview.sh`, each paired with a `setup_for` case that fabricates the state. `preview/` is gitignored: the shots are local artifacts, and their exact dimensions vary with whatever your live quota text happens to be.

Both scripts share `tools/devkit.sh`, which owns the session lifecycle — the private dconf copy, starting and stopping the shell, `Eval` over D-Bus, and choosing the backend. Each script only declares what differs from that, so a fix to the session handling lands in one place.

---

This extension is not affiliated with or endorsed by Anthropic.
