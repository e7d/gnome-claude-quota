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
| `extension.js`, or any `lib/` module as executed code | a new shell process, i.e. `./tools/preview.sh` or `./tools/e2e.sh` |

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
- **Every `dconf`/`gsettings` write belongs inside the `dbus-run-session`.** `XDG_CONFIG_HOME` does not sandbox dconf: writes travel over the session bus to the dconf service, which reads its own environment. A write issued before the private bus exists lands in the *live* session — that is how the user's `enabled-extensions` list was replaced with a single entry, twice, and how their interface font got repointed. The script now writes `enabled-extensions` (this extension alone, so no other indicator lands in the panel) and pins the font to `Cantarell 11` from inside that inner shell, and nowhere else.
- **Take the bus address from the real `gnome-shell` process.** A `pgrep -f` pattern also matches the wrapper shell whose argv contains it, and that wrapper carries the *parent* bus address, so `gdbus` would silently drive the live session instead.

- **The reset pins `_locale` to `en-US`.** The indicator resolves its own from `LC_ALL`/`LC_TIME`/`LANG`, so on a machine whose `LC_TIME` is not American every clock reading in the matrix would shift and no two contributors' shots would match. The `locale` scenario sets `fr-FR` to capture the 24-hour rendering deliberately.
- **The harness backdates `_fetchedAt` by six minutes** in the per-scenario reset. Every state would otherwise be freshly fetched, so the whole matrix would render the refresh row as the disabled `Up to date` and never show the actionable label. The `fresh` scenario re-stamps it to now to capture that state deliberately, and `refreshing` sets `_refreshing`.

A missing colour shows up as `Did not find color property` in the shell log, worth grepping after any stylesheet change: St resolves an undeclared `-barlevel-*` property to transparent and only warns.

Geometry questions are better answered from the actors than from pixels. Measuring the panel button's padding by thresholding a screenshot returned a plausible constant that was really the hover pill's own anti-aliased edge; reading `get_theme_node().get_padding()` gave the true figure and a different answer.

## Asserting what it does

```bash
./tools/e2e.sh
./tools/e2e.sh --group=hover
```

The same throwaway shell as the preview, driven for verdicts instead of pixels. Four groups run in the order below, and `--group=<name>` runs one of them; the theme and scenario flags are `preview.sh`'s.

| Group | What it holds to account |
| --- | --- |
| `state` | every scenario in both themes: every row filled, no `null`/`undefined`/`NaN` reaching a label, one block per quota, each panel label ending in its block's percentage — plus a severity resolving to different colours in the two schemes |
| `hover` | the indicator's hover shape read live against `quickSettings`, the display rows staying inert, and the status row highlighting |
| `refresh` | a click leaves the popup open, spins the icon while the fetch is in flight, and leaves no transition behind afterwards |
| `lifecycle` | disable releases the timer, cancels the in-flight fetch and empties the panel entry; enable registers exactly one indicator |

`lifecycle` destroys the indicator, so it runs last and every earlier group needs a live one. The `state` group is also what writes `preview/`, so a run excluding it leaves whatever was already there for `npm run a11y` to score.

**Every assertion is proven able to fail, on every run.** `prove` evaluates a check three times — untouched, with a deliberate runtime mutation applied, then after the restore — and requires it to pass, fail and pass again. A check that survives its own break is a dead check, and the run stops there, non-zero, with its reason on stderr:

```
control status row highlights: still passed with the break applied
```

That line says **the assertion is dead, not the extension**. Fix the assertion, never the control. A `prove …` line on stdout is therefore not a passing test but a licence for the tests after it, and it leaves the tally alone — the counters are saved and restored around every control, so the summary counts real assertions only.

The breaks are mutations over `Eval` and the restores are re-renders, since `_render()` rebuilds every actor from state. Staging a failure by editing `extension.js` is the one thing a control must never be: it has to be undone inside the run, and a control that outlives its run is a broken checkout.

## Rate limits

The usage endpoint answers `429` with `retry-after: 119`, and every Claude extension on the machine shares that allowance. Do not poll it in a loop while debugging: a burst pins the window, and each retry inside it re-arms the limit. `lib/policy.js` exists to keep the extension itself out of that state.

`tools/preview.sh` stubs the indicator's `_refresh` before capturing, so the whole matrix costs at most the one fetch the shell makes at startup. `tools/e2e.sh` inherits that stub, and its refresh group — which has to remove it to make the button do anything — replaces `_fetchCycle` with a promise that never resolves, so asserting the spinner still spends nothing.

What is measured is the *recovery*, not the budget: a `429` asks for 119 s and 139 s of silence restored a `200`. Nothing observed so far reports how many requests the window allows, or how much of it the neighbouring extensions have already spent. Treat any interval shorter than `POLL_SECONDS` as unmeasured until a successful response is shown to carry `anthropic-ratelimit-*` headers.

## Popup actions

The service-status line is the only activatable row; everything else comes from `displayItem()`, which strips the `popup-inactive-menu-item` class the theme paints at 50% alpha.

- **`PopupMenuItem.activate()` closes the menu it belongs to**, which would hide the numbers a refresh was asked to update — hence the refresh affordance being an `St.Button` in the header rather than a row. The status line keeps the inherited behaviour, because leaving for a browser *should* close the menu.
- **A client-side failure and a service issue share one line but not one nature.** An expired token or an unreachable host renders into the non-reactive `_message`; only a `serviceIssue` renders into the activatable row, so nothing offers a status page that cannot explain the failure.
- **The header timestamp carries the refresh button's disabled reason.** A popup menu has no tooltip surface, so `Last refresh: <time>` beside a greyed button is the only explanation the user gets for why pressing it does nothing.
- **The manual path reuses `shouldFetchOnOpen` rather than a second constant.** Manual and open-triggered fetches spend the same shared allowance, so one rule governs both.
- **Nothing re-renders while the popup sits open**, so `Up to date` and `Refresh at <time>` are re-evaluated on the next open or the next poll, not on a ticker. Both windows are ≤2 minutes, which is why that is acceptable — worth knowing before adding a state where the staleness matters more.

## The status page

`https://status.claude.com/api/v2/summary.json` is a stock Atlassian Statuspage feed — no auth, no key, ~2 KB. Claude Code is component `yyzkbfz2thpt`; the other five (`claude.ai`, Console, API, Cowork, Government) are not consulted, and neither is the page-wide `status.indicator`, which aggregates across products that have nothing to do with this extension.

- **A component status is hand-set by Anthropic staff**, so it lags a real outage and can never be the trigger. Our own `5xx` is the trigger; the page only supplies the wording. `lib/policy.js` `serviceIssue()` maps the five states, and anything unmapped falls to `Service error` — the vocabulary is theirs to extend, so the default arm is load-bearing, not defensive padding.
- **It is fetched only after a `5xx`.** During a real outage the status page is the likeliest thing to be down too, and a lazy fetch degrades to `🚨 Service error` rather than to a stalled poll.
- **`claudeCodeStatus()` lives in `lib/model.js`, not `lib/usage.js`.** Anything importing `gi://` cannot be loaded by `node --test`, so payload parsing stays in the pure layer where a fixture can reach it (`test/fixtures/status.json`).

Emoji in an `St.Label` render through Noto Color Emoji and **ignore the theme foreground entirely** — the `#d97757` / `popup-inactive-menu-item` work does not reach them. They also render taller than adjacent text, which is why `.cq-panel-issue` caps the size: uncapped, the glyph grows the whole top bar row. Write `⚠️` with its VS16 selector (`U+26A0 U+FE0F`); bare `U+26A0` falls back to text presentation at half the width and the line jitters between states. `test/policy.test.js` asserts that code point pair rather than comparing string literals, which would pass if both sides lost the selector together.
