# claude-quota — agent instructions

A GNOME Shell 50 extension showing Claude Code subscription quotas in the top bar. Plain GJS, no build step, no runtime dependencies, no npm packages.

Workspace-wide rules (commit identity, Forgejo tooling) live in [`../AGENTS.md`](../AGENTS.md). Vendor-neutral rules — no WHAT comments, small functions, tests travel with code — live in `~/.config/agents/AGENTS.md` and are not restated here. On conflict, those win.

## Shape of the code

| Path | Runs in | Rule |
| --- | --- | --- |
| `extension.js` | GNOME Shell (GJS) | Actors, signals, timers, D-Bus. The only file allowed to touch the shell. |
| `lib/*.js` | Shell **and** `node --test` | Pure logic: formatting, policy, model, theme, cache, HTTP shaping. |
| `tools/*.sh`, `tools/*.js` | Your machine | Development tooling. Never shipped to users. |
| `test/*.test.js` | `node --test` | Unit tests for `lib/` and `tools/`. |

**Every `lib/` module except `usage.js` must stay free of `gi://`.** Those five are imported by the Node test runner as well as the shell, and one `gi://` import makes the whole module untestable. `lib/usage.js` is the deliberate exception — it wraps Soup and Gio for HTTP, and is consequently the one module with no unit tests, so keep it thin and put any decision it would make into `policy.js` instead. When you want a unit test for logic stuck inside `extension.js`, move the logic to `lib/` first; that is the intended direction of travel.

Rendering is one-way: state fields on the indicator (`_quotas`, `_error`, `_blockedUntil`, `_refreshing`, `_fetchedAt`) are the truth, and `_render()` derives every actor from them. Never mutate an actor outside a render path; set the state and re-render.

## Checking your work

`npm test` — the unit suite. `TZ` is pinned to `UTC` in the script; the suite asserts absolute times and would otherwise fail outside UTC.

**When a change affects what the popup or panel looks like, shoot the affected scenarios headless and look at the result.** That is the fast path and the default:

```bash
npm run preview -- --dark-only --scenario=loading --scenario=no-data
```

Seconds, versus a few minutes for the full matrix. Headless is the default and is what you want — a window is for a human watching, not for you. A subset run leaves the other screenshots alone. Reach for `--windowed` only when the user asked to watch, and for the full run only before treating `overview.png` as complete or when handing the set over.

Every screenshot is a stacked pair: panel with the menu shut on top, popup open below. If a change concerns a state no scenario covers, add the scenario to `SCENARIOS` and `setup_for` in `tools/preview.sh` rather than eyeballing it once by hand.

`npm run a11y` scores the contrast of whatever is currently in `preview/`, so it is only as current as your last preview run. It exits non-zero on a finding.

`npm run dev` and `npm run dev:watch` run a throwaway nested shell for interactive work. Prefer a preview subset when you only need to see a result; a nested session is for behaviour you have to drive.

`README.md` § Development is the user-facing reference for all of these and their flags. Update it in the same change when you alter a flag or add a script.

## Things that will bite you

**GNOME caches extension modules for the life of a shell process.** Disabling and re-enabling the extension re-runs the *old* code. Watch mode restarts the whole nested shell for this reason; never replace that with a disable/enable cycle.

**Never touch the host GNOME session.** Every dconf write belongs inside the private `dbus-run-session` that `tools/devkit.sh` sets up — `XDG_CONFIG_HOME` alone does not sandbox dconf, and a write issued outside that session lands in the live database and has already wiped the user's extension list twice. After anything that starts a shell, confirm the host is intact: `sha256sum ~/.config/dconf/user` and the length of `gsettings get org.gnome.shell enabled-extensions`.

**Kill nested shells by pid only.** The host session's process is also called `gnome-shell`; matching by name kills the user's desktop. `tools/devkit.sh` `stop_shell` does it correctly. Also beware `pgrep -f` matching the very command that runs it, which makes a dead session look alive.

**Editing a running `.sh` corrupts it.** Bash re-reads the script by byte offset, so stop a watcher before editing `tools/dev.sh`.

**`preview/` is gitignored.** The screenshots are local artifacts whose exact dimensions shift with the live quota text, and a full run deletes them all before it starts.

**Verify against a real shell, not by reading the code.** Shell widget behaviour is frequently not what the API names suggest: `hover: false` on a menu item does not stop the `:hover` pseudo-class (that is `track_hover`), overriding `activate()` does not stop the menu closing (the `activate` *signal* does that), and `warp_pointer` silently does nothing under the devkit backend. Assert the property back over `Eval` before believing a fix.
