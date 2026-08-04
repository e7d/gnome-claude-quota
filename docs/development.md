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
| `extension.js`, or any `lib/` module as executed code | a new shell process — see below |

That asymmetry is a trap worth remembering: a disable/enable cycle picks up CSS while silently keeping old JS, so a change can appear to work while the code under test never ran.

## Running the tests

```bash
TZ=UTC node --test
```

Bare — no path argument. `node --test test/` fails on node 24, which tries to execute a file literally named `test`. `TZ=UTC` is required because two assertions pin absolute times and `Intl.DateTimeFormat` resolves against the system zone.

`lib/format.js`, `lib/model.js`, `lib/policy.js` and `lib/cache.js` import nothing from `gi://`, which is what lets node run them directly. Logic belongs there rather than in `extension.js` for exactly that reason.

## Running a throwaway shell

A separate shell process imports the current JS, so this is the loop that avoids logging out. It gets its own D-Bus session and its own dconf database, so it cannot disturb the live session:

```bash
S=/tmp/cq-dev && rm -rf $S && mkdir -p $S/cfg
XDG_CONFIG_HOME=$S/cfg dbus-run-session -- bash -c '
dconf write /org/gnome/shell/enabled-extensions "[\"claude-quota@e7d.io\"]"
dconf write /org/gnome/desktop/interface/color-scheme "\"prefer-dark\""
exec gnome-shell --headless --wayland --virtual-monitor 1100x700
' > $S/log 2>&1 &
```

Then read `$S/log`, and query the shell on its own bus. Select the process by its executable, because a `pgrep -f` pattern also matches the wrapper shell whose argv contains it — and that wrapper carries the *parent* bus address, so `gdbus` would silently talk to the live session:

```bash
P=$(pgrep -u "$USER" -af "gnome-shell --headless" | awk '$2 ~ /gnome-shell$/ {print $1; exit}')
export DBUS_SESSION_BUS_ADDRESS=$(tr '\0' '\n' < /proc/$P/environ | grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)
gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions \
  --method org.gnome.Shell.Extensions.GetExtensionInfo "claude-quota@e7d.io"
```

`state: 1` with an empty `error` means it loaded. Finish with `pkill -f "gnome-shell --headless"`.

Flags that do not work here: `--nested` was removed in GNOME 50; plain `--wayland` selects the native backend and fails with `Failed to take control of the session: EBUSY`; `--devkit` needs `/usr/lib/mutter-devkit`, which Arch does not package, so the shell starts with no output and `Screencast` then reports `Area is off-screen`.

## Seeing what rendered

Pixels are hard to capture here: `org.gnome.Shell.Screenshot` is reserved for the portal and returns `AccessDenied`, `Screencast` produced a truncated file in a headless session, and `Eval` returns `(false, '')` because unsafe mode is off with no D-Bus property to enable it.

What works is a temporary `console.log` probe inside `enable()`, reading the widgets' own state and printing to the throwaway shell's log — label text, bar `value`, `overdriveStart`, visibility. Revert it before committing. A missing colour shows up as `Did not find color property` in that log, which is worth grepping for after any stylesheet change: St resolves an undeclared `-barlevel-*` property to transparent and only warns.

## Rate limits

The usage endpoint answers `429` with `retry-after: 119`, and every Claude extension on the machine shares that allowance. Do not poll it in a loop while debugging: a burst pins the window, and each retry inside it re-arms the limit. `lib/policy.js` exists to keep the extension itself out of that state.
