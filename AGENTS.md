# claude-quota — agent instructions

A GNOME Shell 50 extension showing Claude Code subscription quotas in the top bar. Plain GJS, no build step, no runtime dependencies, no npm packages.

Workspace-wide rules (commit identity, Forgejo tooling) live in [`../AGENTS.md`](../AGENTS.md). Vendor-neutral rules — no WHAT comments, small functions, tests travel with code — live in `~/.config/agents/AGENTS.md` and are not restated here. On conflict, those win.

## Shape of the code

| Path | Runs in | Rule |
| --- | --- | --- |
| `extension.js` | GNOME Shell (GJS) | Actors, signals, timers, D-Bus. The only file allowed to touch the shell. |
| `lib/*.js` | Shell **and** `node --test` | Pure logic: formatting, policy, model, theme, cache, HTTP shaping. |
| `tools/*.sh`, `tools/*.js` | Your machine | Entrypoints. Never shipped to users. |
| `tools/lib/*` | Your machine | Sourced or imported by the entrypoints, never run directly. |
| `test/*.test.js` | `node --test` | Unit tests for `lib/` and `tools/`. |

**Every `lib/` module except `usage.js` must stay free of `gi://`.** Those six are imported by the Node test runner as well as the shell, and one `gi://` import makes the whole module untestable. `lib/usage.js` is the deliberate exception — it wraps Soup and Gio for HTTP, and is consequently the one module with no unit tests, so keep it thin and put any decision it would make into `policy.js` instead. When you want a unit test for logic stuck inside `extension.js`, move the logic to `lib/` first; that is the intended direction of travel.

Rendering is one-way: state fields on the indicator (`_quotas`, `_error`, `_blockedUntil`, `_refreshing`, `_fetchedAt`) are the truth, and `_render()` derives every actor from them. Never mutate an actor outside a render path; set the state and re-render.

## Checking your work

`npm test` — the unit suite. `TZ` is pinned to `UTC` in the script; the suite asserts absolute times and would otherwise fail outside UTC.

**When a change affects what the popup or panel looks like, put the state on screen and look at it.**

    npm run preview -- --dark --scenario=loading

That opens a Mutter devkit window and blocks. Recall it from another terminal to
change the shape live — `--light`, `--open`, `--scenario=no-data` — and only what
you name changes. `--headless --detach --capture` shoots the tile instead of
showing it, which is the form to reach for when nobody is watching.

Every screenshot stacks the panel button's three states: resting, hovered, then pressed with the popup open below it. If a change concerns a state no scenario covers, add the scenario to `SCENARIOS` and `setup_for` in `tools/lib/indicator.sh` rather than eyeballing it once by hand.

**For a screenshot that is also asserted, narrow the suite instead:**

    npm run e2e -- --group=state --dark-only --scenario=loading

A bare `npm run e2e` now shoots every scenario in both themes by default — 24 × 2, minutes rather than seconds. `--a11y` narrows the shoot to the ten scenarios `npm run a11y` scores; `--assert` shoots nothing at all, which is the form to reach for when only behaviour, not pixels, is in question. Every assertion is proven able to fail before it is trusted, on every run. A `control …` line on stderr with a non-zero exit means **the assertion is dead, not the extension** — fix the assertion, never the control. `docs/development.md` § Asserting what it does carries the rest.

`npm run a11y` scores the contrast of whatever is currently in `preview/`, so it is only as current as your last capture or full e2e run — the e2e state group shoots the ten scenarios it scores, and a narrowed run leaves the rest as they were. It exits non-zero on a finding.

`npm run dev` and `npm run dev:watch` run a throwaway nested shell for interactive work. Prefer a preview subset when you only need to see a result; a nested session is for behaviour you have to drive.

`README.md` § Development is the user-facing reference for all of these and their flags. Update it in the same change when you alter a flag or add a script.

## Behave like the platform

The extension should be indistinguishable from a native part of the shell. Whatever GNOME does for a panel button — its resting, hover and pressed backgrounds, its focus ring, its spacing, its symbolic icons — is what this indicator does too, and overriding any of it is a defect rather than a style choice. A user who cannot tell which panel items ship with GNOME and which are ours is the target.

That extends to colour: severity colours are judged against the surfaces a reader rests on (the top bar, the popup card), never against the transient pill under a pressed or hovered button. Darkening a warning until it clears 4.5:1 there turns amber into brown and destroys the meaning the colour exists to carry. `tools/a11y.js` encodes exactly that, listing the transient surfaces it accepts and printing what it accepted rather than hiding it.

Suppressing a shell behaviour to satisfy a measurement is the wrong trade in both directions: it broke platform consistency once (a panel button with no hover state at all) and cost a colour its meaning once. Change what is ours; leave what is GNOME's.

## Things that will bite you

**GNOME caches extension modules for the life of a shell process.** Disabling and re-enabling the extension re-runs the *old* code. Watch mode restarts the whole nested shell for this reason; never replace that with a disable/enable cycle.

**Never touch the host GNOME session.** Every dconf write belongs inside the private `dbus-run-session` that `tools/lib/devkit.sh` sets up — `XDG_CONFIG_HOME` alone does not sandbox dconf, and a write issued outside that session lands in the live database and has already wiped the user's extension list twice. After anything that starts a shell, confirm the host is intact: `sha256sum ~/.config/dconf/user` and the length of `gsettings get org.gnome.shell enabled-extensions`.

**Kill nested shells by pid only.** The host session's process is also called `gnome-shell`; matching by name kills the user's desktop. `tools/lib/devkit.sh` `stop_shell` does it correctly. Also beware `pgrep -f` matching the very command that runs it, which makes a dead session look alive.

**Editing a running `.sh` corrupts it.** Bash re-reads the script by byte offset, so stop a watcher (`npm run dev:watch`) before editing `tools/preview.sh`.

**`preview/` is gitignored.** The screenshots are local artifacts whose exact dimensions shift with the live quota text, and a full run deletes them all before it starts.

**Verify against a real shell, not by reading the code.** Shell widget behaviour is frequently not what the API names suggest: `hover: false` on a menu item does not stop the `:hover` pseudo-class (that is `track_hover`), overriding `activate()` does not stop the menu closing (the `activate` *signal* does that), and `warp_pointer` silently does nothing under the devkit backend. Assert the property back over `Eval` before believing a fix.
