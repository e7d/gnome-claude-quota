# claude-quota

A GNOME Shell indicator showing your Claude API quota usage with per-window progress bars.

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

## What the display means

The panel shows your quota consumption as abbreviated bars:

- **`S`** is your 5-hour session quota
- **`W`** is your weekly quota
- A model-scoped quota appears only when its usage is above 0%, labelled with the model's initial — `Opus`, `Sonnet`, `Fable` display as `O`, `So`, `F` respectively (a second letter is added if initials collide)

Each bar visualizes usage within its time window:

- The fill shows how much quota you've used
- The thin tick mark shows how far the current window has run (e.g., 1 hour into a 5-hour session)
- Any fill beyond the tick renders red — that means you're spending quota faster than the clock is running

The popup displays the remaining time until each quota resets.

## Requirements

- **GNOME Shell 50** or later
- **Claude Code** signed in via OAuth

The extension reads your OAuth token from `~/.claude/.credentials.json` (read-only). It never writes to this file and never refreshes the token. If your token expires, the popup will show `Token expired — run Claude Code once` to refresh it.

## Install

```bash
git clone https://github.com/e7d/claude-quota
ln -s "$(pwd)/claude-quota" ~/.local/share/gnome-shell/extensions/claude-quota@e7d.io
gnome-extensions enable claude-quota@e7d.io
```

On Wayland, a running shell session does not detect newly installed extensions until you log out and back in. If `gnome-extensions enable` reports `Extension "claude-quota@e7d.io" does not exist`, log out first — it is not a sign of a broken install.

## Tests

```bash
TZ=UTC node --test
```

`TZ` is pinned because the test suite asserts absolute times and `Intl.DateTimeFormat` resolves against the system timezone.

---

This extension is not affiliated with or endorsed by Anthropic.
