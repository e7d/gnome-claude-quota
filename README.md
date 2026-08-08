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
TZ=UTC node --test
```

`TZ` is pinned because the test suite asserts absolute times and `Intl.DateTimeFormat` resolves against the system timezone.

---

This extension is not affiliated with or endorsed by Anthropic.
