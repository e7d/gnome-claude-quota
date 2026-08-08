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
| `extension.js`, or any `lib/` module as executed code | a new shell process, i.e. `./tools/preview.sh` |

That asymmetry is a trap worth remembering: a disable/enable cycle picks up CSS while silently keeping old JS, so a change can appear to work while the code under test never ran.

## Running the tests

```bash
TZ=UTC node --test
```

Bare — no path argument. `node --test test/` fails on node 24, which tries to execute a file literally named `test`. `TZ=UTC` is required because two assertions pin absolute times and `Intl.DateTimeFormat` resolves against the system zone.

`lib/format.js`, `lib/model.js`, `lib/policy.js` and `lib/cache.js` import nothing from `gi://`, which is what lets node run them directly. Logic belongs there rather than in `extension.js` for exactly that reason.

## Seeing what rendered

```bash
./tools/preview.sh
```

That renders every popup state into `preview/` (gitignored), one PNG per theme/scenario plus an `overview.png` contact sheet. It runs a throwaway shell, so it picks up changed `extension.js` without a logout, and every state is fabricated in the running shell, so it never calls the usage endpoint.

The mechanics, in case a state needs adding by hand:

- **`--devkit` is the way to run a shell in parallel.** `--nested` was removed in GNOME 50: `meta_context_main_create_backend` now offers only headless or native, so plain `--wayland` picks the native backend and dies on `Failed to take control of the session: EBUSY`. `--devkit` selects the headless backend. Its viewer binary `/usr/lib/mutter-devkit` is not packaged on Arch, so it logs `Failed to launch devkit`, but that is not fatal — the shell runs on the `--virtual-monitor` and can be driven and captured over D-Bus.
- **`--unsafe-mode` is what enables `Eval`.** It is a hidden option and does not appear in `--help`. Without it `org.gnome.Shell.Eval` answers `(false, '')`, which is indistinguishable from a broken script.
- **`org.gnome.Shell.Screenshot` works on the throwaway shell's own bus.** It is portal-restricted only on the live session. `ScreenshotArea` takes a box, and measuring it from the actors (`get_transformed_position` / `get_transformed_size`) beats cropping afterwards.
- **Take the bus address from the real `gnome-shell` process.** A `pgrep -f` pattern also matches the wrapper shell whose argv contains it, and that wrapper carries the *parent* bus address, so `gdbus` would silently drive the live session instead.

A missing colour shows up as `Did not find color property` in the shell log, worth grepping after any stylesheet change: St resolves an undeclared `-barlevel-*` property to transparent and only warns.

Geometry questions are better answered from the actors than from pixels. Measuring the panel button's padding by thresholding a screenshot returned a plausible constant that was really the hover pill's own anti-aliased edge; reading `get_theme_node().get_padding()` gave the true figure and a different answer.

## Rate limits

The usage endpoint answers `429` with `retry-after: 119`, and every Claude extension on the machine shares that allowance. Do not poll it in a loop while debugging: a burst pins the window, and each retry inside it re-arms the limit. `lib/policy.js` exists to keep the extension itself out of that state.

`tools/preview.sh` stubs the indicator's `_refresh` before capturing, so the whole matrix costs at most the one fetch the shell makes at startup.
