# Claude Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GNOME Shell 50 extension showing Claude session and weekly quota percentages in the top bar, with a popup recapping each quota's usage, reset time, and window pace.

**Architecture:** A thin `extension.js` holds every St/Clutter widget and the 60-second poll. All logic that can be silently wrong lives in two GI-free modules (`lib/format.js`, `lib/model.js`) unit-tested with `node --test`. `lib/usage.js` isolates the single HTTP call and the credential read.

**Tech Stack:** GJS ESM (GNOME Shell 50 / GJS 1.88), `libsoup3` via `gi://Soup?version=3.0`, `BarLevel` from `resource:///org/gnome/shell/ui/barLevel.js`, `node --test` (node 24) for unit tests.

**Spec:** [`docs/superpowers/specs/2026-08-04-claude-quota-design.md`](../specs/2026-08-04-claude-quota-design.md)

## Global Constraints

- Target GNOME Shell **50 only**. `metadata.json` declares `"shell-version": ["50"]`.
- `St.BoxLayout` takes `orientation: Clutter.Orientation.VERTICAL`. The `vertical: true` property does not exist in Shell 50 — zero occurrences remain in the shell's own JS.
- Add children with `add_child()`, never `add()`.
- **No comments** unless they document a non-obvious WHY. No file headers, no restatements of what the code does.
- No `prefs.js`, no `schemas/`, no `glib-compile-schemas` step, no gettext.
- `~/.claude/.credentials.json` is **read-only**. Never write to it, never print its contents, never log the token.
- UI strings are inline English. Only times and dates are locale-aware, through `Intl.DateTimeFormat`.
- Endpoint: `https://api.anthropic.com/api/oauth/usage` with headers `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20`.
- Window lengths: `session` = 5 hours, `weekly` = 7 days.
- Every commit is signed: `git commit -S`.

## Delegation

| Task | Who | Why |
| --- | --- | --- |
| 1. `lib/format.js` | Sonnet subagent | Pure functions, full test code supplied, no repo context needed |
| 2. `lib/model.js` | Sonnet subagent | Same, plus a fixture that is already written out below |
| 3. `lib/usage.js` | Main session (Opus) | GJS async promisify and Soup3 error handling are where subtle breakage lives |
| 4. `metadata.json` + icon | Haiku subagent | Mechanical: one JSON file and one 6-element SVG |
| 5. `extension.js` + `stylesheet.css` | Main session (Opus) | Internal shell API, widget lifecycle, the part that cannot be unit-tested |
| 6. Live verification | Main session (Opus) | Needs a nested shell and judgement about what "looks right" means |
| 7. `README.md` | Haiku subagent | Descriptive, written last against finished code |

Subagent prompts must carry the Global Constraints section verbatim, plus their task's own section. They get nothing else.

---

### Task 1: Duration, time, and window-progress formatting

**Files:**
- Create: `package.json`
- Create: `lib/format.js`
- Test: `test/format.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `WINDOW_LENGTH_MS` — `{session: number, weekly: number}` in milliseconds.
  - `relativeDuration(target: Date, now: Date) => string`
  - `absoluteTime(target: Date, now: Date, locale?: string) => string`
  - `windowProgress(resetsAt: Date | null, now: Date, windowMs: number) => number | null`

- [ ] **Step 1: Create `package.json`**

Node needs this to treat `.js` files as ESM. GNOME ignores the file entirely.

```json
{
  "name": "claude-quota",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: Write the failing tests**

`test/format.test.js`:

```js
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {WINDOW_LENGTH_MS, absoluteTime, relativeDuration, windowProgress} from '../lib/format.js';

const now = new Date('2026-08-04T07:51:00Z');

test('relativeDuration renders days and hours past a day', () => {
    assert.equal(relativeDuration(new Date('2026-08-08T07:59:00Z'), now), '4d 0h');
});

test('relativeDuration zero-pads the minutes below a day', () => {
    assert.equal(relativeDuration(new Date('2026-08-04T11:59:00Z'), now), '4h 08m');
});

test('relativeDuration drops to minutes below an hour', () => {
    assert.equal(relativeDuration(new Date('2026-08-04T08:03:00Z'), now), '12m');
});

test('relativeDuration reports a minute while any time remains', () => {
    assert.equal(relativeDuration(new Date('2026-08-04T07:51:30Z'), now), '1m');
});

test('relativeDuration collapses to now at and past the reset', () => {
    assert.equal(relativeDuration(now, now), 'now');
    assert.equal(relativeDuration(new Date('2026-08-04T07:00:00Z'), now), 'now');
});

test('absoluteTime shows only the time when the reset is today', () => {
    assert.equal(absoluteTime(new Date('2026-08-04T11:59:00Z'), now, 'en-GB'), '11:59');
});

test('absoluteTime adds the weekday on another day', () => {
    const text = absoluteTime(new Date('2026-08-08T07:59:00Z'), now, 'en-GB');
    assert.match(text, /Sat/);
    assert.match(text, /07:59/);
});

test('windowProgress measures elapsed time in the session window', () => {
    const value = windowProgress(new Date('2026-08-04T11:59:00Z'), now, WINDOW_LENGTH_MS.session);
    assert.equal(Math.round(value * 100), 17);
});

test('windowProgress measures elapsed time in the weekly window', () => {
    const value = windowProgress(new Date('2026-08-08T07:59:00Z'), now, WINDOW_LENGTH_MS.weekly);
    assert.equal(Math.round(value * 100), 43);
});

test('windowProgress clamps a reset already in the past', () => {
    assert.equal(windowProgress(new Date('2026-08-04T07:00:00Z'), now, WINDOW_LENGTH_MS.session), 1);
});

test('windowProgress is null without a reset time', () => {
    assert.equal(windowProgress(null, now, WINDOW_LENGTH_MS.weekly), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `TZ=UTC node --test test/format.test.js`

Expected: FAIL — `Cannot find module '.../lib/format.js'`.

`TZ=UTC` is mandatory. `Intl.DateTimeFormat` uses the system zone, so without it the two `absoluteTime` assertions fail on any machine outside UTC.

- [ ] **Step 4: Write the implementation**

`lib/format.js`:

```js
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const WINDOW_LENGTH_MS = {
    session: 5 * HOUR,
    weekly: 7 * DAY,
};

export function relativeDuration(target, now) {
    const remaining = target - now;
    if (remaining <= 0)
        return 'now';
    if (remaining >= DAY)
        return `${Math.floor(remaining / DAY)}d ${Math.floor((remaining % DAY) / HOUR)}h`;
    if (remaining >= HOUR) {
        const minutes = Math.floor((remaining % HOUR) / MINUTE);
        return `${Math.floor(remaining / HOUR)}h ${String(minutes).padStart(2, '0')}m`;
    }
    return `${Math.max(1, Math.floor(remaining / MINUTE))}m`;
}

export function absoluteTime(target, now, locale = undefined) {
    const sameDay = target.getFullYear() === now.getFullYear() &&
        target.getMonth() === now.getMonth() &&
        target.getDate() === now.getDate();
    const options = {hour: '2-digit', minute: '2-digit'};
    if (!sameDay)
        options.weekday = 'short';
    return new Intl.DateTimeFormat(locale, options).format(target);
}

export function windowProgress(resetsAt, now, windowMs) {
    if (!resetsAt)
        return null;
    const elapsed = 1 - (resetsAt - now) / windowMs;
    return Math.min(1, Math.max(0, elapsed));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `TZ=UTC node --test test/format.test.js`

Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json lib/format.js test/format.test.js
git commit -S -m "feat: duration, time and window-progress formatting"
```

---

### Task 2: The view model

**Files:**
- Create: `lib/model.js`
- Create: `test/fixtures/usage.json`
- Test: `test/model.test.js`

**Interfaces:**
- Consumes: `WINDOW_LENGTH_MS` and `windowProgress` from `lib/format.js` (Task 1).
- Produces: `quotas(payload: object, now: Date) => Array<{short: string, name: string, percent: number, severity: string, resetsAt: Date | null, windowProgress: number | null}>`, in the order the API returned them.

`short` is `S` for the session quota and `W` for the weekly one. A scoped quota takes its model's first letter, and its second letter in lowercase when the first would collide with `S` or `W` — so `Fable` is `F` while `Sonnet` is `So`. The panel is unreadable if two counters share a letter.

- [ ] **Step 1: Write the fixture**

`test/fixtures/usage.json` — a real captured response, reduced to the `limits` array this extension reads:

```json
{
  "limits": [
    {
      "kind": "session",
      "group": "session",
      "percent": 5,
      "severity": "normal",
      "resets_at": "2026-08-04T11:59:59.583771+00:00",
      "scope": null,
      "is_active": false
    },
    {
      "kind": "weekly_all",
      "group": "weekly",
      "percent": 37,
      "severity": "normal",
      "resets_at": "2026-08-08T07:59:59.583794+00:00",
      "scope": null,
      "is_active": true
    },
    {
      "kind": "weekly_scoped",
      "group": "weekly",
      "percent": 0,
      "severity": "normal",
      "resets_at": null,
      "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null},
      "is_active": false
    }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

`test/model.test.js`:

```js
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {quotas} from '../lib/model.js';

const now = new Date('2026-08-04T07:51:00Z');

function payload() {
    return JSON.parse(readFileSync(new URL('./fixtures/usage.json', import.meta.url), 'utf8'));
}

test('session and weekly always render, a scoped quota at zero does not', () => {
    assert.deepEqual(quotas(payload(), now).map(quota => quota.name), ['Session', 'Weekly']);
});

test('the session entry carries every field the UI needs', () => {
    const [session] = quotas(payload(), now);
    assert.equal(session.short, 'S');
    assert.equal(session.percent, 5);
    assert.equal(session.severity, 'normal');
    assert.equal(session.resetsAt.toISOString(), '2026-08-04T11:59:59.583Z');
    assert.equal(Math.round(session.windowProgress * 100), 17);
});

test('a scoped quota renders once it is above zero, named after its model', () => {
    const data = payload();
    data.limits[2].percent = 12;
    data.limits[2].resets_at = '2026-08-08T07:59:59.583794+00:00';
    const scoped = quotas(data, now).at(-1);
    assert.equal(scoped.name, 'Fable');
    assert.equal(scoped.short, 'F');
    assert.equal(scoped.percent, 12);
    assert.equal(Math.round(scoped.windowProgress * 100), 43);
});

test('a scoped short label takes a second lowercase letter when it would collide', () => {
    const data = payload();
    data.limits[2].percent = 12;
    data.limits[2].scope.model.display_name = 'Sonnet';
    const [session, weekly, scoped] = quotas(data, now);
    assert.equal(scoped.short, 'So');
    assert.equal(session.short, 'S');
    assert.equal(weekly.short, 'W');
});

test('a quota without a reset time has no window progress', () => {
    const data = payload();
    data.limits[2].percent = 12;
    assert.equal(quotas(data, now).at(-1).resetsAt, null);
    assert.equal(quotas(data, now).at(-1).windowProgress, null);
});

test('severity passes through when known and degrades to normal otherwise', () => {
    const data = payload();
    data.limits[0].severity = 'warning';
    data.limits[1].severity = 'something_new';
    const [session, weekly] = quotas(data, now);
    assert.equal(session.severity, 'warning');
    assert.equal(weekly.severity, 'normal');
});

test('a response without limits yields no quotas', () => {
    assert.deepEqual(quotas({}, now), []);
    assert.deepEqual(quotas(null, now), []);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `TZ=UTC node --test test/model.test.js`

Expected: FAIL — `Cannot find module '.../lib/model.js'`.

- [ ] **Step 4: Write the implementation**

`lib/model.js`:

```js
import {WINDOW_LENGTH_MS, windowProgress} from './format.js';

const ALWAYS_VISIBLE = new Set(['session', 'weekly_all']);
const KNOWN_SEVERITIES = new Set(['warning', 'critical']);
const NAMES = {session: 'Session', weekly_all: 'Weekly'};
const SHORTS = {session: 'S', weekly_all: 'W'};
const RESERVED_SHORTS = new Set(Object.values(SHORTS));

function quotaName(limit) {
    return NAMES[limit.kind] ?? limit.scope?.model?.display_name ?? limit.kind;
}

function shortLabel(kind, name) {
    if (SHORTS[kind])
        return SHORTS[kind];
    const initial = name.slice(0, 1).toUpperCase();
    return RESERVED_SHORTS.has(initial) ? initial + name.slice(1, 2).toLowerCase() : initial;
}

export function quotas(payload, now) {
    return (payload?.limits ?? [])
        .filter(limit => ALWAYS_VISIBLE.has(limit.kind) || limit.percent > 0)
        .map(limit => {
            const name = quotaName(limit);
            const resetsAt = limit.resets_at ? new Date(limit.resets_at) : null;
            const windowMs = WINDOW_LENGTH_MS[limit.group] ?? WINDOW_LENGTH_MS.weekly;
            return {
                short: shortLabel(limit.kind, name),
                name,
                percent: limit.percent,
                severity: KNOWN_SEVERITIES.has(limit.severity) ? limit.severity : 'normal',
                resetsAt,
                windowProgress: windowProgress(resetsAt, now, windowMs),
            };
        });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `TZ=UTC node --test test/`

Expected: PASS, 18 tests across both files.

- [ ] **Step 6: Commit**

```bash
git add lib/model.js test/model.test.js test/fixtures/usage.json
git commit -S -m "feat: map the usage payload to a view model"
```

---

### Task 3: The usage client

**Files:**
- Create: `lib/usage.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `class UsageClient` with `async fetch(cancellable: Gio.Cancellable) => object` (the parsed response) and `destroy() => void`. Failures reject with an `Error` whose `message` is user-facing text.

This task has no unit test: every line touches GI or the network. It is verified in Task 6 against the live endpoint.

- [ ] **Step 1: Write the implementation**

`lib/usage.js`:

```js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

function accessToken() {
    let contents;
    try {
        [, contents] = Gio.File.new_for_path(CREDENTIALS_PATH).load_contents(null);
    } catch {
        throw new Error('Cannot read ~/.claude/.credentials.json');
    }
    const token = JSON.parse(new TextDecoder().decode(contents))?.claudeAiOauth?.accessToken;
    if (!token)
        throw new Error('No Claude token in ~/.claude/.credentials.json');
    return token;
}

export class UsageClient {
    constructor() {
        this._session = new Soup.Session({timeout: 10});
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }

    async fetch(cancellable) {
        const message = Soup.Message.new('GET', ENDPOINT);
        message.request_headers.append('Authorization', `Bearer ${accessToken()}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        const status = message.get_status();
        if (status === Soup.Status.UNAUTHORIZED)
            throw new Error('Token expired — run Claude Code once');
        if (status !== Soup.Status.OK)
            throw new Error(`Usage request failed (HTTP ${status})`);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }
}
```

- [ ] **Step 2: Verify the module parses**

Run: `gjs -m -c "import('./lib/usage.js').then(() => print('ok'))"`

Expected: `ok`. This only proves the imports and syntax are valid outside the shell; `Soup.Session` construction is not exercised.

- [ ] **Step 3: Commit**

```bash
git add lib/usage.js
git commit -S -m "feat: read the OAuth usage endpoint"
```

---

### Task 4: Manifest and icon

**Files:**
- Create: `metadata.json`
- Create: `icons/claude-quota-symbolic.svg`

**Interfaces:**
- Consumes: nothing.
- Produces: the extension UUID `claude-quota@e7d.io`, consumed by Task 6's install path, and the icon path `icons/claude-quota-symbolic.svg`, consumed by Task 5.

- [ ] **Step 1: Write `metadata.json`**

```json
{
  "name": "Claude Quota",
  "description": "Claude session and weekly quota in the top bar, with reset times and window pace.",
  "uuid": "claude-quota@e7d.io",
  "shell-version": ["50"],
  "version": 1
}
```

- [ ] **Step 2: Write `icons/claude-quota-symbolic.svg`**

Twelve tapered rays as six rounded capsules rotated about the centre. The `-symbolic.svg` suffix is what makes St recolour it with the panel foreground; renaming the file breaks the recolouring.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <g fill="#000000" transform="translate(8,8)">
    <rect x="-0.85" y="-6.6" width="1.7" height="13.2" rx="0.85"/>
    <rect x="-0.85" y="-6.6" width="1.7" height="13.2" rx="0.85" transform="rotate(30)"/>
    <rect x="-0.85" y="-6.6" width="1.7" height="13.2" rx="0.85" transform="rotate(60)"/>
    <rect x="-0.85" y="-6.6" width="1.7" height="13.2" rx="0.85" transform="rotate(90)"/>
    <rect x="-0.85" y="-6.6" width="1.7" height="13.2" rx="0.85" transform="rotate(120)"/>
    <rect x="-0.85" y="-6.6" width="1.7" height="13.2" rx="0.85" transform="rotate(150)"/>
  </g>
</svg>
```

- [ ] **Step 3: Verify both files**

Run: `jq -e . metadata.json > /dev/null && echo "metadata ok" && xmllint --noout --nonet icons/claude-quota-symbolic.svg && echo "svg ok"`

Expected: `metadata ok` then `svg ok`.

- [ ] **Step 4: Commit**

```bash
git add metadata.json icons/claude-quota-symbolic.svg
git commit -S -m "feat: extension manifest and panel icon"
```

---

### Task 5: Indicator and popup

**Files:**
- Create: `extension.js`
- Create: `stylesheet.css`

**Interfaces:**
- Consumes: `quotas` (Task 2), `relativeDuration` / `absoluteTime` (Task 1), `UsageClient` (Task 3), the icon path and UUID (Task 4).
- Produces: the default-exported `Extension` subclass the shell loads.

Two mechanics were verified against the Shell 50 source and must not be "simplified" away:

- `BarLevel._init` spreads `...params` **after** `style_class: 'barlevel'`, so passing `style_class` at construction **replaces** it and loses every theme default. Add the class afterwards with `add_style_class_name()`.
- The popup is not a descendant of the panel button in the actor tree, so a colour-scheme class on the button cannot style the menu. Severity classes therefore carry the scheme in their own name (`cq-warning-dark`), with no ancestor dependency.

- [ ] **Step 1: Write `stylesheet.css`**

Dimming uses actor opacity in JS rather than a hardcoded `rgba()`, so it modulates whatever foreground the current theme provides. Only the severity colours need real values, and they exist twice because no single amber clears 4.5:1 against both a dark and a light panel.

```css
.cq-panel {
    spacing: 6px;
}

.cq-body {
    spacing: 10px;
}

.cq-block {
    spacing: 4px;
    min-width: 260px;
}

.cq-name,
.cq-percent {
    font-weight: 500;
}

.cq-bar {
    -barlevel-height: 6px;
    -barlevel-overdrive-separator-width: 2px;
}

.cq-caption {
    font-size: 0.9em;
}

.cq-legend {
    font-size: 0.85em;
}

.cq-warning-dark {
    color: #f5c211;
}

.cq-critical-dark {
    color: #ff7b63;
}

.cq-warning-light {
    color: #a6600a;
}

.cq-critical-light {
    color: #c01c28;
}
```

- [ ] **Step 2: Write `extension.js`**

```js
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {absoluteTime, relativeDuration} from './lib/format.js';
import {quotas} from './lib/model.js';
import {UsageClient} from './lib/usage.js';

const POLL_SECONDS = 60;
const LEGEND = 'tick: window elapsed · red: over pace';
const CAPTION_OPACITY = 180;
const SEPARATOR_OPACITY = 120;

function severityClass(base, severity, scheme) {
    return severity === 'normal' ? base : `${base} cq-${severity}-${scheme}`;
}

const QuotaBlock = GObject.registerClass(
class QuotaBlock extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'cq-block',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._name = new St.Label({style_class: 'cq-name'});
        this._percent = new St.Label({style_class: 'cq-percent'});
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(this._name);
        header.add_child(new St.Widget({x_expand: true}));
        header.add_child(this._percent);
        this._bar = new BarLevel({x_expand: true});
        this._bar.add_style_class_name('cq-bar');
        this._caption = new St.Label({style_class: 'cq-caption', opacity: CAPTION_OPACITY});
        this.add_child(header);
        this.add_child(this._bar);
        this.add_child(this._caption);
    }

    update(quota, now, scheme) {
        this._name.text = quota.name;
        this._percent.text = `${quota.percent}%`;
        this._percent.style_class = severityClass('cq-percent', quota.severity, scheme);
        this._bar.value = quota.percent / 100;
        this._bar.overdriveStart = quota.windowProgress ?? 1;
        this._caption.visible = quota.resetsAt !== null;
        if (quota.resetsAt)
            this._caption.text = `${relativeDuration(quota.resetsAt, now)} left · ${absoluteTime(quota.resetsAt, now)}`;
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(iconPath) {
        super._init(0.5, 'Claude Quota');
        this._client = new UsageClient();
        this._settings = St.Settings.get();
        this._cancellable = null;
        this._quotas = [];
        this._blocks = [];
        this._error = null;
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            style_class: 'system-status-icon',
            gicon: Gio.icon_new_for_string(iconPath),
        }));
        this._panelQuotas = new St.BoxLayout({style_class: 'cq-panel'});
        box.add_child(this._panelQuotas);
        this.add_child(box);
        this._message = new PopupMenu.PopupMenuItem('Loading…', {reactive: false});
        this._body = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._blockBox = new St.BoxLayout({
            style_class: 'cq-body',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._body.add_child(this._blockBox);
        this._legend = new PopupMenu.PopupMenuItem(LEGEND, {reactive: false});
        this._legend.label.style_class = 'cq-legend';
        this._legend.opacity = CAPTION_OPACITY;
        this.menu.addMenuItem(this._message);
        this.menu.addMenuItem(this._body);
        this.menu.addMenuItem(this._legend);
        this._schemeId = this._settings.connect('notify::color-scheme', () => this._render());
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                return;
            this._render();
            this._refresh();
        });
        this.connect('destroy', () => this._onDestroy());
        this._render();
        this._refresh();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get _scheme() {
        return this._settings.color_scheme === St.SystemColorScheme.PREFER_DARK ? 'dark' : 'light';
    }

    async _refresh() {
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        try {
            const payload = await this._client.fetch(this._cancellable);
            this._quotas = quotas(payload, new Date());
            this._error = null;
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._error = error.message;
        }
        this._render();
    }

    _render() {
        const now = new Date();
        const scheme = this._scheme;
        this._renderPanel(scheme);
        if (this._blocks.length !== this._quotas.length) {
            this._blockBox.destroy_all_children();
            this._blocks = this._quotas.map(() => {
                const block = new QuotaBlock();
                this._blockBox.add_child(block);
                return block;
            });
        }
        this._quotas.forEach((quota, index) => this._blocks[index].update(quota, now, scheme));
        const hasQuotas = this._quotas.length > 0;
        this._body.visible = hasQuotas;
        this._legend.visible = hasQuotas;
        this._message.visible = !hasQuotas || this._error !== null;
        this._message.label.text = this._error ?? 'Loading…';
    }

    _renderPanel(scheme) {
        this._panelQuotas.destroy_all_children();
        if (!this._quotas.length) {
            this._panelQuotas.add_child(new St.Label({
                text: this._error ? '—' : '…',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }
        this._quotas.forEach((quota, index) => {
            if (index > 0) {
                this._panelQuotas.add_child(new St.Label({
                    text: '·',
                    y_align: Clutter.ActorAlign.CENTER,
                    opacity: SEPARATOR_OPACITY,
                }));
            }
            this._panelQuotas.add_child(new St.Label({
                text: `${quota.short} ${quota.percent}%`,
                style_class: severityClass('cq-panel-quota', quota.severity, scheme),
                y_align: Clutter.ActorAlign.CENTER,
            }));
        });
    }

    _onDestroy() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        this._settings.disconnect(this._schemeId);
        this._cancellable?.cancel();
        this._client.destroy();
    }
});

export default class ClaudeQuotaExtension extends Extension {
    enable() {
        this._indicator = new Indicator(`${this.path}/icons/claude-quota-symbolic.svg`);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
```

- [ ] **Step 3: Verify the whole tree still parses**

Run: `TZ=UTC node --test test/ && gjs -c "print('gjs ok')"`

Expected: 18 tests pass, then `gjs ok`. `extension.js` cannot be imported outside the shell — Task 6 is its real test.

- [ ] **Step 4: Commit**

```bash
git add extension.js stylesheet.css
git commit -S -m "feat: panel indicator and quota popup"
```

---

### Task 6: Install and verify in a live shell

**Files:**
- No source changes expected. Any fix found here is committed as its own follow-up.

**Interfaces:**
- Consumes: everything.
- Produces: a working installed extension.

- [ ] **Step 1: Install as a symlink**

A symlink means editing the repo edits the installed extension, so the loop is edit → restart shell.

```bash
ln -sfn "$PWD" ~/.local/share/gnome-shell/extensions/claude-quota@e7d.io
gnome-extensions list | grep claude-quota@e7d.io
```

Expected: the UUID is listed.

- [ ] **Step 2: Run it in a nested shell**

A nested shell avoids restarting the running session and gives isolated logs.

```bash
dbus-run-session -- gnome-shell --nested --wayland 2>&1 | tee /tmp/claude-quota-shell.log &
sleep 8
gnome-extensions enable claude-quota@e7d.io
```

Expected: the panel shows `✳ …` and then percentages within a couple of seconds.

- [ ] **Step 3: Check the log for exceptions**

```bash
grep -iE "claude-quota|JS ERROR|JS WARNING" /tmp/claude-quota-shell.log | head -20
```

Expected: no `JS ERROR`. A `JS WARNING` about a deprecated property must be fixed, not ignored — it is the first sign of a Shell 51 break.

- [ ] **Step 4: Compare against the source of truth**

Run `claude` and use `/usage` in it, then compare the session and weekly percentages to the panel. They must match.

- [ ] **Step 5: Verify the four failure paths deliberately**

Each of these must show its message in the popup and leave the panel readable:

```bash
# 1. Unreadable credentials: point the client at nothing by renaming, then restore.
mv ~/.claude/.credentials.json ~/.claude/.credentials.json.probe
# Expected popup: "Cannot read ~/.claude/.credentials.json", panel: "✳ —"
mv ~/.claude/.credentials.json.probe ~/.claude/.credentials.json

# 2. Offline: drop DNS for the API host in the nested session's resolver, or
#    disable networking briefly. Expected popup: a "Usage request failed" or
#    resolution error message; previous values stay on the panel.

# 3. Over-pace bar: no code path to force this, so verify the drawing instead —
#    temporarily set `this._bar.overdriveStart = 0.05` in extension.js, restart,
#    confirm the fill past the tick is red, then revert the edit.

# 4. Scoped quota: temporarily map `weekly_scoped` percent to a non-zero value in
#    `_refresh` (e.g. `this._quotas.push({...})`), confirm a third panel counter
#    and a third block appear, then revert.
```

Never commit the probe edits from 3 and 4. `git diff --stat` must be empty before the next step.

- [ ] **Step 6: Screenshot both themes**

Switch the nested session between light and dark (`gsettings set org.gnome.desktop.interface color-scheme prefer-dark` / `default`), screenshot the popup in each, and confirm captions and severity colours stay legible.

- [ ] **Step 7: Commit any fix found**

```bash
git add -p
git commit -S -m "fix: <what the live shell revealed>"
```

---

### Task 7: README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the finished tree.
- Produces: nothing consumed by code.

- [ ] **Step 1: Write `README.md`**

Contents, in this order:

1. One-sentence description, and a fenced block showing the panel (`✳ S 5% · W 37%`) and the popup as it appears in the spec.
2. What each part means: `S` session, `W` weekly, a letter per scoped model shown only above 0%; the tick marks how far the window has run; fill past the tick is red because usage is outrunning the clock.
3. Requirements: GNOME Shell 50, Claude Code signed in (the extension reads `~/.claude/.credentials.json` read-only and never writes to it).
4. Install: `git clone` then `ln -s` into `~/.local/share/gnome-shell/extensions/claude-quota@e7d.io`, then `gnome-extensions enable claude-quota@e7d.io`.
5. Tests: `TZ=UTC node --test test/`, and why `TZ` is pinned (`Intl` uses the system zone).
6. A "Not affiliated with Anthropic" line, matching what comparable extensions state.

No badges, no feature-bullet marketing, no roadmap.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -S -m "docs: README"
```

---

## Verification summary

| Spec requirement | Verified by |
| --- | --- |
| Quota selection, scoped-quota visibility | Task 2 tests |
| Window progress for both window lengths | Tasks 1 and 2 tests |
| Duration and absolute-time rendering | Task 1 tests |
| Unknown severity degrades to normal | Task 2 test |
| Panel layout, popup layout, bar behaviour | Task 6 steps 2, 5, 6 |
| Error and loading states | Task 6 step 5 |
| Light and dark legibility | Task 6 step 6 |
| Percentages match the API | Task 6 step 4 |
