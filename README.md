# claude-quota

A GNOME Shell indicator showing your Claude Code subscription quota usage — the 5-hour session window and the weekly window.

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

(Reset times are formatted in your system locale — the example shows French.)

## What the display means

The panel shows your quota consumption as text labels (`S 5% · W 37%`) with a small icon:

- **`S`** is your 5-hour session quota
- **`W`** is your weekly quota
- A model-scoped quota appears only when its usage is above 0%, labelled with the model's initial — `Opus`, `Sonnet`, `Fable` display as `O`, `So`, `F` respectively (a second letter is added if initials collide)

Each quota's bar in the popup visualizes usage within its time window:

- The fill shows how much quota you've used
- The thin tick mark shows how far the current window has run (e.g., 1 hour into a 5-hour session)
- Any fill beyond the tick renders red — that means you're spending quota faster than the clock is running

The popup displays the remaining time until each quota resets.

## Requirements

- **GNOME Shell 50**
- **Claude Code** signed in via OAuth

The extension reads your OAuth token from `~/.claude/.credentials.json` (read-only). It never writes to this file and never refreshes the token. If your token expires, the popup will show `Token expired — run Claude Code once` to refresh it.

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

Run that from the directory *containing* the clone, not from inside it — inside, `claude-quota` resolves against the repository itself and you get a symlink pointing at its own parent.

On Wayland, a running shell session does not detect newly installed extensions until you log out and back in. If `gnome-extensions enable` reports `Extension "claude-quota@e7d.io" does not exist`, log out first — it is not a sign of a broken install.

## Tests

```bash
TZ=UTC node --test
```

`TZ` is pinned because the test suite asserts absolute times and `Intl.DateTimeFormat` resolves against the system timezone.

---

This extension is not affiliated with or endorsed by Anthropic.
