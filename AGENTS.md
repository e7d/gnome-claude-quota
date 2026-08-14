# claude-quota — agent instructions

A GNOME Shell 50 extension showing Claude Code subscription quotas in the top bar. Plain GJS, no build step, no runtime dependencies — what ships to a user is the checkout itself. `oxlint` is the one devDependency, so `node_modules/` exists on a developer's machine and nowhere else.

Workspace-wide rules (commit identity, Forgejo tooling) live in [`../AGENTS.md`](../AGENTS.md). Vendor-neutral rules — no WHAT comments, small functions, tests travel with code — live in `~/.config/agents/AGENTS.md` and are not restated here. On conflict, those win.

## Shape of the code

| Path | Runs in | Rule |
| --- | --- | --- |
| `extension.js` | GNOME Shell (GJS) | Actors, signals, timers, D-Bus. The only file allowed to touch the shell. |
| `lib/*.js` | Shell **and** `node --test` | Pure logic: formatting, policy, model, theme, cache, HTTP shaping. |
| `tools/*.sh`, `tools/*.js` | Your machine | Entrypoints. Never shipped to users. |
| `tools/lib/*` | Your machine | Sourced or imported by the entrypoints, never run directly. |
| `test/*.test.js` | `node --test` | Unit tests for `lib/` and `tools/`. |
| `po/*.po`, `po/*.pot` | Translators | The wording. Regenerate with `npm run i18n` after any string change. |
| `locale/**/*.mo` | GNOME Shell | Compiled and committed, because the checkout is what a user installs. Never edited. |

**Every `lib/` module except `usage.js` must stay free of `gi://`.** All of them are imported by the Node test runner as well as the shell, and one `gi://` import makes the whole module untestable. `lib/usage.js` is the deliberate exception — it wraps Soup and Gio for HTTP, and is consequently the one module with no unit tests, so keep it thin and put any decision it would make into `policy.js` instead. When you want a unit test for logic stuck inside `extension.js`, move the logic to `lib/` first; that is the intended direction of travel.

Rendering is one-way: state fields on the indicator (`_quotas`, `_error`, `_service`, `_block`, `_refreshing`, `_fetchedAt`) are the truth, and `_render()` derives every actor from them. Never mutate an actor outside a render path; set the state and re-render.

`_block` is one object (`{until, reason}`) or `null`, deliberately: it was briefly two fields and the harness caught them out of sync on the first run. `_service` (`{status, until}` or `null`) follows the same rule for the same reason.

## Checking your work

`npm run lint` — oxlint over every `.js` in the repo, silent when clean. `.oxlintrc.json` runs `correctness`, `suspicious` and `perf`, and switches `no-underscore-dangle` off because `_private` is the shell's own convention and 324 findings would have buried everything else. The GJS-side `globals` block (`global`, `log`, `logError`, `TextDecoder`, `TextEncoder`) is what keeps `no-undef` usable across files that run in both the shell and Node — remove it and 12 real symbols read as undefined. Add a rule only with a run that proves it fires on this codebase.

`npm test` — the unit suite. `TZ` is pinned to `UTC` in the script; the suite asserts absolute times and would otherwise fail outside UTC. `LC_ALL` is pinned to `C` for the same reason applied to words and to `Intl.NumberFormat`.

`npm run i18n:check` — fails when a msgid exists in the code but not in the committed catalog. Run it after touching any user-facing string; `xgettext` reads call sites literally, so a string reached through a wrapper or a constant is invisible to extraction until that wrapper is named in `tools/i18n.sh`.

**When a change affects what the popup or panel looks like, put the state on screen and look at it.**

    npm run preview -- --dark --scenario=loading

That opens a Mutter devkit window and blocks. Recall it from another terminal to
change the shape live — `--light`, `--open`, `--scenario=no-data` — and only what
you name changes. `--headless --detach --capture` shoots the tile instead of
showing it, which is the form to reach for when nobody is watching.

Every screenshot stacks the panel button's three states: resting, hovered, then pressed with the popup open below it. If a change concerns a state no scenario covers, add the scenario to `SCENARIOS` and `setup_for` in `tools/lib/indicator.sh` rather than eyeballing it once by hand.

**For a screenshot that is also asserted, narrow the suite instead:**

    npm run e2e -- --group=state --dark-only --scenario=loading

A bare `npm run e2e` now shoots every scenario in both themes by default — 31 × 2, minutes rather than seconds. `--a11y` narrows the shoot to the ten scenarios `npm run a11y` scores; `--assert` shoots nothing at all, which is the form to reach for when only behaviour, not pixels, is in question. Every assertion is proven able to fail before it is trusted, on every run. A `control …` line on stderr with a non-zero exit means **the assertion is dead, not the extension** — fix the assertion, never the control. `docs/development.md` § Asserting what it does carries the rest.

`npm run a11y` scores the contrast of whatever is currently in `preview/`, so it is only as current as your last capture or full e2e run — the e2e state group shoots the ten scenarios it scores, and a narrowed run leaves the rest as they were. It exits non-zero on a finding.

`npm run dev` and `npm run dev:watch` run a throwaway nested shell for interactive work. Reach for a headless `--capture` when you only need to see a result; a windowed session is for behaviour a human has to drive, and `--watch` refuses to attach to a session someone else already owns.

**`~/.claude.json` is read, never written.** It is Claude Code's own config — a live MCP API key, `oauthAccount`, per-project prompt text — rewritten every few seconds by whichever client is running, with no locking we could join. We take `cachedUsageUtilization` when it is fresher than ours and leave the file alone; `docs/development.md` § Claude Code's cache is checked first carries the guards and why each one exists.

**A nested session spends no requests, and it must stay that way.** It runs with a `HOME` of its own holding no credentials, so the startup fetch is refused before a socket opens; scenarios are fabricated and `--live` reads your cached `usage.json` rather than the endpoint. If you add a code path that fetches for real, you are reintroducing the thing that made the tooling outspend the product three to one — `docs/development.md` § The tooling spends nothing has the measurements. The check is cheap: `wc -l ~/.cache/claude-quota/attempts.jsonl` before and after a run, and it must not move.

`npm run logs` prints what the extension actually exchanged with the two endpoints — every request and every one it declined to send, with statuses, `retry-after`, and error bodies. **Reach for it before theorising about a refusal**, and before adding instrumentation: it is already recording, and `--all --runs` shows a bad morning in a dozen lines. `docs/development.md` § Reading the exchange log carries the fields and the redaction rule; § Rate limits carries the two measured limiters and why a `401` is the expensive one.

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

**Retrying a `401` is the one mistake that costs an hour.** Three consecutive auth failures and the endpoint blocks the account for 3600 s, so anything that polls has to check `expiresAt` before spending a request, and treat a server `401` as a reason to back off rather than a reason to try again in five minutes. The block is scoped to the token that earned it, so a newly written `~/.claude/.credentials.json` ends it — which is why the extension watches that file rather than waiting the hour out. `docs/development.md` § Rate limits has the measurements.

**Two `npm run e2e` runs used to share one nested shell**, interleaving their state and their pointer, which surfaces as a control failure anywhere in the suite and reads as a real defect. `claim_session` now refuses the second with a `flock`; `preview.sh` deliberately does not take it, because recalling a live session is what that tool is for.

**A flag that only takes effect on a fresh shell is silently dropped on an attached one.** `preview.sh` reuses a live session, so `--language` and `--locale` render the *previous* session's values and report success. `stale_axis()` in `tools/lib/devkit.sh` is the list of axes that force a restart — anything new that is fixed at `start_shell` goes in it. The same flag reaches `e2e.sh` only because it is exported: `preview.sh` runs there as a subprocess.

**Translating a module constant where it is declared freezes English, silently.** `NAMES` and `SERVICE_ISSUES` are evaluated at import, before `enable()` installs a translator. Mark the msgid with `N_()` there and resolve it with `_()` where the value is read. Nothing errors, nothing warns, and the string is English forever.

**Verify against a real shell, not by reading the code.** Shell widget behaviour is frequently not what the API names suggest: `hover: false` on a menu item does not stop the `:hover` pseudo-class (that is `track_hover`), overriding `activate()` does not stop the menu closing (the `activate` *signal* does that), and `warp_pointer` silently does nothing under the devkit backend. Assert the property back over `Eval` before believing a fix.

**A `MessageTray.Source` destroys itself when its last notification is removed.** So a held source reference goes stale with no error and the next post lands on a dead object — the shell's own `getSystemSource()` re-creates lazily and nulls its reference on `destroy`, and `_notifySource()` does the same. The e2e `notify` group asserts `_source` went `null` after the last alert was withdrawn, because nothing else would say so.
