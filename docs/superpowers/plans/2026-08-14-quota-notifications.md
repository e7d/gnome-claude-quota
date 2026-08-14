# Quota Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the user when a quota crosses a warning or critical percentage threshold, once per threshold per reset window, and withdraw the notification when it stops being true.

**Architecture:** A pure module, `lib/notify.js`, turns the current quota list plus persisted bookkeeping into a diff — `{post, withdraw, fired}` — and decides everything. `extension.js` translates that diff into GNOME `MessageTray` calls and decides nothing. Thresholds come from four new GSettings keys with no preferences UI, and the bookkeeping rides along in the existing cache file so a shell restart does not re-notify.

**Tech Stack:** Plain GJS (GNOME Shell 50), `node --test` for units, the existing nested-shell e2e harness for wiring, gettext for the one new string.

**Spec:** `docs/superpowers/specs/2026-08-14-quota-notifications-design.md`

## Global Constraints

- Target GNOME Shell 50 only (`metadata.json` `shell-version: ["50"]`). No build step; the checkout is what a user installs, so generated artifacts (`locale/**/*.mo`, `schemas/gschemas.compiled`) are committed.
- Every `lib/` module except `lib/usage.js` must stay free of `gi://` imports — they are all imported by `node --test`. `lib/notify.js` is a `lib/` module and therefore has no `gi://`.
- No WHAT comments. A comment must document a WHY a reader could not derive, or it is deleted.
- Functions ≤ 20 lines soft cap; no blank lines inside a function body; ≤ 3 positional args before an options object; immutability by default; no `any`-style escape hatches.
- Rendering stays one-way: state fields are the truth and `_render()` derives actors. Notifications are a side effect of a state change, never of a render.
- `npm run lint` must be silent. `npm test` runs as `TZ=UTC LC_ALL=C node --test` — tests assert absolute times and formatted numbers, so never rely on the ambient locale.
- `npm run i18n:check` must pass after any user-facing string change.
- Commits are signed (`git commit -S`) and carry **no** `Co-Authored-By` trailer — this repo's history has none.
- Every e2e assertion must be proven able to fail via `prove`; a `control …` line on stderr means the assertion is dead, not the extension.

---

### Task 1: A stable identity for every quota

A scoped limit's `kind` is not unique — `test/fixtures/usage.json` holds `kind: "weekly_scoped"` with `scope.model.display_name: "Fable"`, so two model-scoped quotas would collide into one alert. Every later task keys alerts on this field.

**Files:**
- Modify: `lib/model.js:69-90`
- Modify: `tools/lib/indicator.sh:63-73` (the `QUOTA` fixture helper)
- Test: `test/model.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: every object returned by `quotas(payload, now)` carries `key: string`, unique within one payload. Format: `kind` alone when the limit has no model scope, otherwise `` `${kind}:${scope.model.id ?? scope.model.display_name}` ``.

- [ ] **Step 1: Write the failing test**

Add to `test/model.test.js`:

```js
test('every quota carries a key, and two scoped limits of one kind do not collide', () => {
    const limits = [
        {kind: 'session', group: 'session', percent: 5, severity: 'normal', resets_at: '2026-08-10T12:00:00Z', scope: null},
        {kind: 'weekly_scoped', group: 'weekly', percent: 12, severity: 'normal', resets_at: '2026-08-15T08:00:00Z', scope: {model: {id: null, display_name: 'Fable'}}},
        {kind: 'weekly_scoped', group: 'weekly', percent: 30, severity: 'warning', resets_at: '2026-08-15T08:00:00Z', scope: {model: {id: 'opus-x', display_name: 'Opus'}}},
    ];
    const keys = quotas({limits}, now).map(quota => quota.key);
    assert.deepEqual(keys, ['session', 'weekly_scoped:Fable', 'weekly_scoped:opus-x']);
    assert.equal(new Set(keys).size, keys.length);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --test-name-pattern='carries a key'`
Expected: FAIL — the keys come back as `[undefined, undefined, undefined]`, so `deepEqual` reports the mismatch.

- [ ] **Step 3: Implement**

In `lib/model.js`, add above `quotas`:

```js
function quotaKey(limit) {
    const model = limit.scope?.model;
    const scope = model?.id ?? model?.display_name ?? '';
    return scope === '' ? limit.kind : `${limit.kind}:${scope}`;
}
```

and add one field to the object `quotas()` maps, immediately before `short`:

```js
                key: quotaKey(limit),
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, including every pre-existing `model` test — `key` is additive and nothing else reads it yet.

- [ ] **Step 5: Teach the e2e fixture to emit a key**

The harness fabricates quota objects rather than parsing a payload, so `render_state` would hand the notifier keyless quotas. In `tools/lib/indicator.sh`, inside the `QUOTA` heredoc's returned object, add `key` beside `short`:

```bash
QUOTA="const q = (short, name, percent, severity, leftMin, winMin) => {
    const progress = Math.min(1, Math.max(0, 1 - leftMin / winMin));
    return {
        key: name, short, name, percent, severity,
```

The scenario names are unique within a scenario, which is all `key` has to be here.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add lib/model.js test/model.test.js tools/lib/indicator.sh
git commit -S -m "feat(model): give every quota a collision-free key

A scoped limit's kind is generic — the fixture holds two weekly_scoped
limits distinguished only by their model — so kind alone cannot identify
a quota across refreshes. Notifications key their bookkeeping on this."
```

---

### Task 2: Carry alert bookkeeping in the cache

The bookkeeping has to outlive the shell process or every login re-notifies. It rides in the existing cache file, and a version-1 file is accepted rather than discarded so nobody loses a cached first paint on upgrade.

**Files:**
- Modify: `lib/cache.js`
- Modify: `extension.js:268-296` (`_loadCache`, `_saveCache`), `extension.js:145-180` (`_init` field)
- Test: `test/cache.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `serialize(limits, fetchedAt, fired = {})` writes version 2. `deserialize(text)` returns `{limits, fetchedAt, fired}` or `null`, accepting versions 1 and 2 and defaulting `fired` to `{}`. `extension.js` gains `this._fired`, an object, initialised to `{}`.

- [ ] **Step 1: Write the failing tests**

In `test/cache.test.js`, replace the existing `deserialize rejects a different version` test — it asserts version 2 is rejected, which is exactly what stops being true — with these three:

```js
test('deserialize rejects a version it does not know', () => {
    assert.equal(deserialize(JSON.stringify({version: 3, fetchedAt: fetchedAt.toISOString(), limits})), null);
    assert.equal(deserialize(JSON.stringify({fetchedAt: fetchedAt.toISOString(), limits})), null);
});

test('a round trip preserves the alert bookkeeping', () => {
    const fired = {'session|warning': {window: '2026-08-04T14:59:59.000Z'}};
    assert.deepEqual(deserialize(serialize(limits, fetchedAt, fired)).fired, fired);
});

test('a version 1 file is read as legacy with no alerts fired', () => {
    const legacy = JSON.stringify({version: 1, fetchedAt: fetchedAt.toISOString(), limits});
    const restored = deserialize(legacy);
    assert.deepEqual(restored.limits, limits);
    assert.deepEqual(restored.fired, {});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- --test-name-pattern='alert bookkeeping|version 1 file|version it does not know'`
Expected: FAIL — `serialize` takes two arguments so `fired` is dropped, and a version-1 payload is currently rejected outright.

- [ ] **Step 3: Implement**

Rewrite `lib/cache.js`:

```js
const VERSION = 2;
const ACCEPTED = new Set([1, VERSION]);

export function serialize(limits, fetchedAt, fired = {}) {
    return JSON.stringify({version: VERSION, fetchedAt: fetchedAt.toISOString(), limits, fired});
}

function firedOf(data) {
    const fired = data.fired;
    return fired !== null && typeof fired === 'object' && !Array.isArray(fired) ? fired : {};
}

export function deserialize(text) {
    if (!text)
        return null;
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    if (!ACCEPTED.has(data?.version) || !Array.isArray(data.limits))
        return null;
    const fetchedAt = new Date(data.fetchedAt);
    if (Number.isNaN(fetchedAt.getTime()))
        return null;
    return {limits: data.limits, fetchedAt, fired: firedOf(data)};
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 5: Wire the field through the extension**

In `extension.js` `_init`, beside `this._limits = [];`:

```js
        this._fired = {};
```

In `_loadCache`, after `this._fetchedAt = cached.fetchedAt;`:

```js
        this._fired = cached.fired;
```

In `_saveCache`, pass it:

```js
                new TextEncoder().encode(serialize(this._limits, this._fetchedAt, this._fired)),
```

Nothing reads `_fired` yet; Task 6 does.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add lib/cache.js test/cache.test.js extension.js
git commit -S -m "feat(cache): persist alert bookkeeping alongside the limits

Notification state has to outlive the shell process or every login
re-notifies a quota the user already dismissed. Version 1 files are read
as legacy with an empty record rather than rejected, so no cached first
paint is lost on upgrade."
```

---

### Task 3: The alert plan — crossing, dedup, window roll

The heart of the feature, and pure, so its whole behaviour is a unit test. This task covers firing, per-window dedup, the window roll, and expiry. Task 4 adds the quieting rules on top.

**Files:**
- Create: `lib/notify.js`
- Test: `test/notify.test.js`
- Modify: `po/claude-quota.pot`, `po/fr.po`, `locale/fr/LC_MESSAGES/claude-quota.mo` (via `npm run i18n`)

**Interfaces:**
- Consumes: `quotas()[].key` from Task 1; `captionLine`, `percentLine` from `lib/format.js`; `_`, `format` from `lib/i18n.js`.
- Produces:
  - `HYSTERESIS: number` (`2`)
  - `NOTIFY_DEFAULTS: {warning: number, critical: number}` (`{warning: 75, critical: 90}`)
  - `alertPlan({quotas, fired, thresholds, now, locale, percentLocale}) → {post, withdraw, fired}` where `thresholds` is `[{level, percent, enabled}]`, `post` is `[{key, quotaKey, level, title, body}]`, `withdraw` is `string[]` of alert keys, and `fired` is the next bookkeeping object `{[alertKey]: {window: string}}`. An alert key is `` `${quota.key}|${level}` ``; a window is the quota's `resetsAt.toISOString()`, or `''` when it has none.

- [ ] **Step 1: Write the failing tests**

Create `test/notify.test.js`:

```js
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {NOTIFY_DEFAULTS, alertPlan} from '../lib/notify.js';

const now = new Date('2026-08-14T09:00:00Z');
const resetsAt = new Date('2026-08-14T11:30:00Z');

function quota(overrides = {}) {
    return {
        key: 'session',
        short: 'S',
        name: 'Session (5h)',
        modelScoped: false,
        percent: 10,
        severity: 'normal',
        resetsAt,
        windowProgress: 0.5,
        aheadOfPace: false,
        expired: false,
        ...overrides,
    };
}

function thresholds(overrides = {}) {
    return [
        {level: 'warning', percent: NOTIFY_DEFAULTS.warning, enabled: true, ...overrides.warning},
        {level: 'critical', percent: NOTIFY_DEFAULTS.critical, enabled: true, ...overrides.critical},
    ];
}

function plan(quotas, fired = {}, overrides = {}) {
    return alertPlan({
        quotas,
        fired,
        thresholds: thresholds(overrides),
        now,
        locale: 'en-US',
        percentLocale: 'en-US',
    });
}

test('a quota below every threshold says nothing', () => {
    const result = plan([quota({percent: 60})]);
    assert.deepEqual(result.post, []);
    assert.deepEqual(result.withdraw, []);
    assert.deepEqual(result.fired, {});
});

test('crossing the warning threshold posts once and records the window', () => {
    const result = plan([quota({percent: 78})]);
    assert.deepEqual(result.post.map(alert => alert.key), ['session|warning']);
    assert.deepEqual(result.fired, {'session|warning': {window: resetsAt.toISOString()}});
});

test('the notification names the quota and its percentage', () => {
    const [alert] = plan([quota({percent: 78})]).post;
    assert.match(alert.title, /Session \(5h\)/);
    assert.match(alert.title, /78\s*%/);
    assert.equal(alert.body, '2h 30m left · 11:30 AM');
    assert.equal(alert.level, 'warning');
    assert.equal(alert.quotaKey, 'session');
});

test('a threshold already fired for this window does not post again', () => {
    const fired = {'session|warning': {window: resetsAt.toISOString()}};
    const result = plan([quota({percent: 80})], fired);
    assert.deepEqual(result.post, []);
    assert.deepEqual(result.withdraw, []);
    assert.deepEqual(result.fired, fired);
});

test('a rolled window withdraws the stale alert and re-arms the level', () => {
    const fired = {'session|warning': {window: '2026-08-14T06:30:00.000Z'}};
    const result = plan([quota({percent: 78})], fired);
    assert.deepEqual(result.withdraw, ['session|warning']);
    assert.deepEqual(result.post.map(alert => alert.key), ['session|warning']);
    assert.deepEqual(result.fired, {'session|warning': {window: resetsAt.toISOString()}});
});

test('an expired quota withdraws its alert and holds nothing', () => {
    const fired = {'session|warning': {window: resetsAt.toISOString()}};
    const result = plan([quota({percent: 78, expired: true})], fired);
    assert.deepEqual(result.withdraw, ['session|warning']);
    assert.deepEqual(result.post, []);
    assert.deepEqual(result.fired, {});
});

test('quotas are independent, and each keeps its own bookkeeping', () => {
    const result = plan([
        quota({percent: 78}),
        quota({key: 'weekly_all', name: 'Weekly', percent: 20, resetsAt}),
    ]);
    assert.deepEqual(result.post.map(alert => alert.key), ['session|warning']);
    assert.deepEqual(Object.keys(result.fired), ['session|warning']);
});

test('a quota with no reset time still fires, under an empty window', () => {
    const result = plan([quota({percent: 78, resetsAt: null})]);
    assert.deepEqual(result.fired, {'session|warning': {window: ''}});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- test/notify.test.js`
Expected: FAIL — `Cannot find module '../lib/notify.js'`.

- [ ] **Step 3: Implement**

Create `lib/notify.js`:

```js
import {captionLine, percentLine} from './format.js';
import {_, format} from './i18n.js';

export const HYSTERESIS = 2;
export const NOTIFY_DEFAULTS = {warning: 75, critical: 90};

function windowOf(quota) {
    return quota.resetsAt === null ? '' : quota.resetsAt.toISOString();
}

function armed(quota, threshold) {
    return threshold.enabled && !quota.expired && Number.isFinite(quota.percent);
}

function stale(quota, threshold, entry) {
    if (entry === undefined)
        return false;
    if (!armed(quota, threshold))
        return true;
    return entry.window !== windowOf(quota) ||
        quota.percent <= threshold.percent - HYSTERESIS;
}

function fires(quota, threshold, entry) {
    return entry === undefined && armed(quota, threshold) &&
        quota.percent >= threshold.percent;
}

function alertText(quota, {now, locale, percentLocale}) {
    return {
        title: format(_('{name} at {percent}'), {
            name: quota.name,
            percent: percentLine(quota, percentLocale),
        }),
        body: captionLine(quota, now, locale),
    };
}

function pairs(quotas, thresholds) {
    return thresholds.flatMap(threshold => quotas.map(quota => ({quota, threshold})));
}

export function alertPlan({quotas, fired, thresholds, now, locale, percentLocale}) {
    const next = {...fired};
    const withdraw = [];
    const post = [];
    pairs(quotas, thresholds).forEach(({quota, threshold}) => {
        const key = `${quota.key}|${threshold.level}`;
        if (stale(quota, threshold, next[key])) {
            delete next[key];
            withdraw.push(key);
        }
        if (!fires(quota, threshold, next[key]))
            return;
        next[key] = {window: windowOf(quota)};
        post.push({
            key,
            quotaKey: quota.key,
            level: threshold.level,
            ...alertText(quota, {now, locale, percentLocale}),
        });
    });
    return {post, withdraw, fired: next};
}
```

`pairs` iterates thresholds outermost so `warning` is always evaluated before `critical`, which Task 4's supersede rule relies on.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS. If the `body` assertion fails on the time, check that the script's `TZ=UTC` is in effect — `npm test` sets it, a bare `node --test` does not.

- [ ] **Step 5: Extract the new string and translate it**

One new msgid, `{name} at {percent}`.

```bash
npm run i18n
```

Then in `po/fr.po`, translate it — the French reads `{name} à {percent}`:

```
#: lib/notify.js
msgid "{name} at {percent}"
msgstr "{name} à {percent}"
```

Re-run `npm run i18n` to recompile `locale/fr/LC_MESSAGES/claude-quota.mo`, then verify:

```bash
npm run i18n:check
```

Expected: silent. A msgid present in the code but absent from the catalog fails here.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add lib/notify.js test/notify.test.js po locale
git commit -S -m "feat(notify): plan quota alerts as a pure diff

alertPlan takes the quota list and the persisted record and answers with
what to post and what to withdraw, so the shell side translates a diff
and decides nothing. Firing is once per threshold per reset window, keyed
on the window's own reset timestamp, which is what makes a restart silent.

The title is a msgid with both values as placeholders rather than a
sentence built by concatenation: the body reuses captionLine, whose
trailing word lives inside each plural branch because French agrees it
with whichever unit leads."
```

---

### Task 4: The quieting rules — hysteresis, disabled levels, supersede

Three rules that stop the feature being a nuisance. Each is independently rejectable, which is why they are not folded into Task 3.

**Files:**
- Modify: `lib/notify.js`
- Test: `test/notify.test.js`

**Interfaces:**
- Consumes: everything Task 3 produced.
- Produces: no signature change. `post` now excludes a `warning` alert superseded by a `critical` alert in the same plan, and `withdraw` is de-duplicated.

- [ ] **Step 1: Write the failing tests**

Append to `test/notify.test.js`:

```js
test('a percentage inside the hysteresis margin neither re-posts nor withdraws', () => {
    const fired = {'session|warning': {window: resetsAt.toISOString()}};
    const result = plan([quota({percent: 74})], fired);
    assert.deepEqual(result.post, []);
    assert.deepEqual(result.withdraw, []);
    assert.deepEqual(result.fired, fired);
});

test('a percentage below the hysteresis margin withdraws and re-arms', () => {
    const fired = {'session|warning': {window: resetsAt.toISOString()}};
    const result = plan([quota({percent: 73})], fired);
    assert.deepEqual(result.withdraw, ['session|warning']);
    assert.deepEqual(result.post, []);
    assert.deepEqual(result.fired, {});
});

test('a re-armed level fires again in the same window', () => {
    const dropped = plan([quota({percent: 73})], {'session|warning': {window: resetsAt.toISOString()}});
    const result = plan([quota({percent: 80})], dropped.fired);
    assert.deepEqual(result.post.map(alert => alert.key), ['session|warning']);
});

test('a disabled level withdraws its alert and forgets it', () => {
    const fired = {'session|warning': {window: resetsAt.toISOString()}};
    const result = plan([quota({percent: 80})], fired, {warning: {enabled: false}});
    assert.deepEqual(result.withdraw, ['session|warning']);
    assert.deepEqual(result.post, []);
    assert.deepEqual(result.fired, {});
});

test('a disabled level never fires', () => {
    const result = plan([quota({percent: 99})], {}, {critical: {enabled: false}});
    assert.deepEqual(result.post.map(alert => alert.level), ['warning']);
});

test('critical supersedes the warning banner but keeps its record', () => {
    const result = plan([quota({percent: 95})]);
    assert.deepEqual(result.post.map(alert => alert.key), ['session|critical']);
    assert.deepEqual(result.withdraw, ['session|warning']);
    assert.deepEqual(Object.keys(result.fired).sort(), ['session|critical', 'session|warning']);
});

test('a superseded warning does not fire again once critical is up', () => {
    const first = plan([quota({percent: 95})]);
    const result = plan([quota({percent: 96})], first.fired);
    assert.deepEqual(result.post, []);
    assert.deepEqual(result.withdraw, []);
});

test('withdraw never repeats a key', () => {
    const fired = {
        'session|warning': {window: '2026-08-14T06:30:00.000Z'},
        'session|critical': {window: '2026-08-14T06:30:00.000Z'},
    };
    const result = plan([quota({percent: 95})], fired);
    assert.deepEqual(result.withdraw.filter(key => key === 'session|warning').length, 1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- test/notify.test.js`
Expected: FAIL on the supersede tests — Task 3 posts both levels and never withdraws the warning. The hysteresis and disabled-level tests should already pass, because `stale`/`armed` were written with them in mind; if any of those three fails, the bug is in Task 3 and belongs fixed there.

- [ ] **Step 3: Implement supersede**

In `lib/notify.js`, add:

```js
function supersede({post, withdraw, fired}) {
    const critical = new Set(post.filter(alert => alert.level === 'critical')
        .map(alert => alert.quotaKey));
    const shadowed = [...critical].map(quotaKey => `${quotaKey}|warning`);
    return {
        fired,
        post: post.filter(alert =>
            alert.level !== 'warning' || !critical.has(alert.quotaKey)),
        withdraw: [...new Set([...withdraw, ...shadowed])],
    };
}
```

and return through it from `alertPlan`:

```js
    return supersede({post, withdraw, fired: next});
```

A warning superseded in the same pass is dropped from `post` rather than posted and withdrawn, so no banner flashes; its `fired` entry stays, so it will not fire later in the window.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add lib/notify.js test/notify.test.js
git commit -S -m "feat(notify): quiet the flap, the disabled level and the double banner

A session window rolls, so a percentage genuinely falls and a level has to
re-arm — but re-arming on the exact threshold re-posts on every poll, so a
level only re-arms two points below it.

Crossing both thresholds in one refresh still records both, keeping the
early ping on a gradual climb, while showing only the critical banner:
two notifications about one quota reading 78% and 95% is noise."
```

---

### Task 5: Thresholds as settings

Four GSettings keys with no preferences UI, so the settings-panel ticket builds widgets over keys that already work.

**Files:**
- Create: `schemas/org.gnome.shell.extensions.claude-quota.gschema.xml`
- Create: `schemas/gschemas.compiled` (generated, committed)
- Modify: `metadata.json`
- Modify: `lib/notify.js`
- Test: `test/notify.test.js`

**Interfaces:**
- Consumes: `NOTIFY_DEFAULTS` from Task 3.
- Produces: `thresholdsFrom({warningEnabled, warningPercent, criticalEnabled, criticalPercent}) → [{level, percent, enabled}]`, ordered warning then critical — the exact shape `alertPlan` takes. Schema id `org.gnome.shell.extensions.claude-quota`, path `/org/gnome/shell/extensions/claude-quota/`, keys `notify-warning-enabled` (`b`, `true`), `notify-warning-percent` (`i`, 1–100, `75`), `notify-critical-enabled` (`b`, `true`), `notify-critical-percent` (`i`, 1–100, `90`).

- [ ] **Step 1: Write the failing test**

Append to `test/notify.test.js`:

```js
test('settings values become the threshold list alertPlan takes', () => {
    assert.deepEqual(thresholdsFrom({
        warningEnabled: true,
        warningPercent: 70,
        criticalEnabled: false,
        criticalPercent: 95,
    }), [
        {level: 'warning', percent: 70, enabled: true},
        {level: 'critical', percent: 95, enabled: false},
    ]);
});
```

and extend the import at the top of the file:

```js
import {NOTIFY_DEFAULTS, alertPlan, thresholdsFrom} from '../lib/notify.js';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- test/notify.test.js`
Expected: FAIL — `thresholdsFrom is not a function`.

- [ ] **Step 3: Implement the builder**

In `lib/notify.js`:

```js
export function thresholdsFrom({warningEnabled, warningPercent, criticalEnabled, criticalPercent}) {
    return [
        {level: 'warning', percent: warningPercent, enabled: warningEnabled},
        {level: 'critical', percent: criticalPercent, enabled: criticalEnabled},
    ];
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Write the schema**

Create `schemas/org.gnome.shell.extensions.claude-quota.gschema.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <schema id="org.gnome.shell.extensions.claude-quota" path="/org/gnome/shell/extensions/claude-quota/">
    <key name="notify-warning-enabled" type="b">
      <default>true</default>
      <summary>Notify at the warning threshold</summary>
      <description>Show a notification when a quota reaches the warning percentage.</description>
    </key>
    <key name="notify-warning-percent" type="i">
      <range min="1" max="100"/>
      <default>75</default>
      <summary>Warning threshold</summary>
      <description>Percentage of a quota at which the warning notification is shown.</description>
    </key>
    <key name="notify-critical-enabled" type="b">
      <default>true</default>
      <summary>Notify at the critical threshold</summary>
      <description>Show a notification when a quota reaches the critical percentage.</description>
    </key>
    <key name="notify-critical-percent" type="i">
      <range min="1" max="100"/>
      <default>90</default>
      <summary>Critical threshold</summary>
      <description>Percentage of a quota at which the critical notification is shown.</description>
    </key>
  </schema>
</schemalist>
```

The defaults must match `NOTIFY_DEFAULTS` in `lib/notify.js`; they are two declarations of one decision and there is no mechanism keeping them in step.

- [ ] **Step 6: Validate and compile with the native tool**

```bash
glib-compile-schemas --strict --dry-run schemas/
glib-compile-schemas schemas/
```

Expected: both silent. `gschemas.compiled` is committed for the same reason `locale/**/*.mo` is — there is no build step, so the checkout is what a user installs.

- [ ] **Step 7: Point metadata at the schema**

In `metadata.json`, add the key (JSON has no trailing commas — put it before `"version"`):

```json
  "settings-schema": "org.gnome.shell.extensions.claude-quota",
```

Verify it still parses:

```bash
python3 -c "import json; print(json.load(open('metadata.json'))['settings-schema'])"
```

Expected: `org.gnome.shell.extensions.claude-quota`

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add schemas metadata.json lib/notify.js test/notify.test.js
git commit -S -m "feat(settings): add notification threshold keys

Landing the schema without a preferences window means the settings-panel
ticket builds widgets over keys that already work, rather than schema,
UI and plumbing at once. gschemas.compiled is committed because there is
no build step: the checkout is what a user installs."
```

---

### Task 6: Post, withdraw, and prove it in a real shell

The shell side. It is the one file with no unit tests, so its verification is a new e2e group driven over `Eval` against a nested shell — which is also where the design's read of the `MessageTray` API stops being a claim.

**Files:**
- Modify: `extension.js` (imports, `_init`, `_applyResult`, `_adoptShared`, `_loadCache`, `_onDestroy`, `enable`)
- Modify: `tools/lib/devkit.sh` (add `catalog_infix`)
- Modify: `tools/lib/indicator.sh` (add `reset_alerts`, `sync_alerts`)
- Modify: `tools/e2e.sh` (add `group_notify` and its assertions)

**Interfaces:**
- Consumes: `alertPlan`, `thresholdsFrom`, `NOTIFY_DEFAULTS` from `lib/notify.js`; `markExpired` from `lib/policy.js` (already imported); `this._fired` from Task 2; `quota.key` from Task 1.
- Produces: on the indicator — `_prefs` (the `Gio.Settings`), `_source` (`MessageTray.Source` or `null`), `_alerts` (`Map<string, MessageTray.Notification>`), `_syncAlerts(now)`, `_postAlert(alert)`, `_withdrawAlert(key)`, `_notifySource()`, `_notifyPrefs()`.

- [ ] **Step 1: Import the tray and the notifier**

In `extension.js`, after the `PopupMenu` import:

```js
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
```

and beside the other `lib/` imports:

```js
import {alertPlan, thresholdsFrom} from './lib/notify.js';
```

Add the level-to-urgency map beside the other module constants near `CAPTION_OPACITY`:

```js
const URGENCY = {
    warning: MessageTray.Urgency.NORMAL,
    critical: MessageTray.Urgency.HIGH,
};
```

- [ ] **Step 2: Take the settings and hold the alert state**

Change the indicator's signature and `enable()` so the `Gio.Settings` arrives from the extension — `getSettings()` exists only on `Extension`:

```js
    _init({iconPath, prefs}) {
```

In `enable()`:

```js
        this._indicator = new Indicator({
            iconPath: `${this.path}/icons/claude-quota-symbolic.svg`,
            prefs: this.getSettings(),
        });
```

In `_init`, immediately after `super._init(0.5, _('Claude Quota'));`:

```js
        this._iconPath = iconPath;
        this._prefs = prefs;
        this._source = null;
        this._alerts = new Map();
        this._prefsSignals = [];
```

`this._settings` is `St.Settings` and keeps its name — renaming or shadowing it silently breaks the colour-scheme watch on line 244.

- [ ] **Step 3: Read the thresholds and watch them**

Add to the indicator:

```js
    _notifyPrefs() {
        return {
            warningEnabled: this._prefs.get_boolean('notify-warning-enabled'),
            warningPercent: this._prefs.get_int('notify-warning-percent'),
            criticalEnabled: this._prefs.get_boolean('notify-critical-enabled'),
            criticalPercent: this._prefs.get_int('notify-critical-percent'),
        };
    }

    _watchNotifyPrefs() {
        ['notify-warning-enabled', 'notify-warning-percent',
            'notify-critical-enabled', 'notify-critical-percent']
            .forEach(key => this._prefsSignals.push(
                this._prefs.connect(`changed::${key}`, () => this._syncAlerts(new Date()))));
    }
```

and call `this._watchNotifyPrefs();` in `_init` beside `this._watchCredentials();`.

- [ ] **Step 4: Post and withdraw**

Add to the indicator:

```js
    // A Source destroys itself when its last notification is removed, so the
    // reference has to be re-made rather than kept — the shell's own
    // getSystemSource() handles it the same way.
    _notifySource() {
        if (this._source !== null)
            return this._source;
        this._source = new MessageTray.Source({
            title: _('Claude Quota'),
            icon: Gio.icon_new_for_string(this._iconPath),
        });
        this._source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(this._source);
        return this._source;
    }

    _postAlert(alert) {
        const source = this._notifySource();
        const notification = new MessageTray.Notification({
            source,
            title: alert.title,
            body: alert.body,
            gicon: Gio.icon_new_for_string(this._iconPath),
            urgency: URGENCY[alert.level],
            isTransient: false,
        });
        notification.connect('activated', () => this.menu.open(true));
        notification.connect('destroy', () => this._alerts.delete(alert.key));
        this._alerts.set(alert.key, notification);
        source.addNotification(notification);
    }

    _withdrawAlert(key) {
        const notification = this._alerts.get(key);
        if (notification === undefined)
            return;
        this._alerts.delete(key);
        notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
    }

    _syncAlerts(now) {
        const plan = alertPlan({
            quotas: markExpired(this._quotas, now),
            fired: this._fired,
            thresholds: thresholdsFrom(this._notifyPrefs()),
            now,
            locale: this._locale,
            percentLocale: this._percentLocale,
        });
        plan.withdraw.forEach(key => this._withdrawAlert(key));
        plan.post.forEach(alert => this._postAlert(alert));
        this._fired = plan.fired;
        this._saveCache();
    }
```

`markExpired` matters: `_quotas` carries no `expired` field — `_render()` derives it per paint (`extension.js:651`) — so passing `this._quotas` raw would treat a finished window as live.

- [ ] **Step 5: Call it from every path that changes the quotas**

In `_applyResult`, in the success branch after `this._saveCache();`:

```js
            this._syncAlerts(new Date());
```

At the end of `_adoptShared`, after the `_appendAttempt(...)` call:

```js
        this._syncAlerts(now);
```

At the end of `_loadCache`, after `this._fired = cached.fired;`:

```js
        this._syncAlerts(new Date());
```

- [ ] **Step 6: Clean up on disable**

In `_onDestroy`, before `this._cancellable?.cancel();`:

```js
        this._prefsSignals.forEach(id => this._prefs.disconnect(id));
        this._prefsSignals = [];
        this._alerts.clear();
        this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._source = null;
```

`Source.destroy(reason)` destroys every notification it holds, so the tray is left clean. `_fired` stays on disk, which is what makes a re-enable silent.

- [ ] **Step 7: Add the harness helpers**

In `tools/lib/devkit.sh`, beside `catalog_prefix`:

```bash
# The notification title's msgid opens on a placeholder, so catalog_prefix returns
# nothing to match on; the connector between the two placeholders is what proves a
# language run reached the catalog.
catalog_infix() {
    local text
    text="$(catalog_msg "$1")"
    text="${text#*\}}"
    printf '%s' "${text%%\{*}"
}
```

In `tools/lib/indicator.sh`, beside `render_state`:

```bash
# render_state sets the quotas directly, bypassing every path that syncs alerts,
# and `fired` survives a scenario change on purpose — so a group asserting alerts
# clears it first and asks for the sync explicitly.
reset_alerts() {
    shell_eval "const i = Main.panel.statusArea['$UUID'];
        [...i._alerts.keys()].forEach(key => i._withdrawAlert(key));
        i._fired = {}; 'ok'" >/dev/null
}

sync_alerts() {
    shell_eval "Main.panel.statusArea['$UUID']._syncAlerts(new Date()); 'ok'" >/dev/null
}
```

- [ ] **Step 8: Add the assertions**

In `tools/e2e.sh`, register the group before `lifecycle` (which destroys the indicator):

```bash
ALL_GROUPS=(state panel hover refresh notify lifecycle)
```

and in `main()`, before the `lifecycle` line:

```bash
    runs_group notify && group_notify
```

Add the probes and assertions beside the other groups' helpers:

```bash
LIVE_ALERTS="[...$IND._alerts.keys()].sort()"
SOURCE_TITLES="($IND._source?.notifications ?? []).map(n => n.title).sort()"

# probe already wraps its expression in JSON.stringify, so the comparison is made
# shell-side against a JSON array literal rather than by matching a printed string.
assert_alert_keys() {
    assert_eq "$1 live alerts" 'true' \
        "$(probe "JSON.stringify($LIVE_ALERTS) === $(js_string "$2")")"
}

assert_source_holds_every_alert() {
    assert_eq "$1 every live alert is in the tray" 'true' \
        "$(probe "[...$IND._alerts.values()].every(n =>
            ($IND._source?.notifications ?? []).includes(n)) &&
            $IND._alerts.size === ($IND._source?.notifications ?? []).length")"
}

assert_alert_urgency() {
    assert_eq "$1 urgency escalates with the level" 'true' \
        "$(probe "[...$IND._alerts.entries()].every(([key, n]) =>
            n.urgency === (key.endsWith('|critical') ? 2 : 1))")"
}

assert_alert_titles_name_the_quota() {
    local infix
    infix="$(js_string "$(catalog_infix '{name} at {percent}')")"
    assert_eq "$1 each title joins a quota name to its percentage" 'true' \
        "$(probe "[...$IND._alerts.entries()].every(([key, n]) => {
            const quota = $IND._quotas.find(q => key.startsWith(q.key + '|'));
            return n.title.includes($infix) && n.title.includes(quota.name) &&
                n.title.includes(String(quota.percent));
        })")"
}

assert_one_alert_per_quota() {
    assert_eq "$1 a quota shows one banner at a time" 'true' \
        "$(probe "new Set(($LIVE_ALERTS).map(k => k.split('|')[0])).size === ($LIVE_ALERTS).length")"
}

assert_alerts() {
    assert_source_holds_every_alert "$1"
    assert_alert_urgency "$1"
    assert_alert_titles_name_the_quota "$1"
    assert_one_alert_per_quota "$1"
}

assert_source_holds_every_alert_probe() { assert_source_holds_every_alert control; }
assert_alert_urgency_probe() { assert_alert_urgency control; }
assert_alert_titles_probe() { assert_alert_titles_name_the_quota control; }
assert_one_alert_per_quota_probe() { assert_one_alert_per_quota control; }
```

- [ ] **Step 9: Add the group and its controls**

```bash
prove_alerts() {
    reset_alerts
    render_state critical
    sync_alerts
    prove 'every live alert is in the tray' \
        "shell_eval \"$IND._alerts.set('ghost|warning', $IND._alerts.values().next().value); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._alerts.delete('ghost|warning'); 'ok'\" >/dev/null" \
        assert_source_holds_every_alert_probe
    prove 'urgency escalates with the level' \
        "shell_eval \"[...$IND._alerts.values()].forEach(n => { n.urgency = 1; }); 'ok'\" >/dev/null" \
        "shell_eval \"[...$IND._alerts.entries()].forEach(([k, n]) => { n.urgency = k.endsWith('|critical') ? 2 : 1; }); 'ok'\" >/dev/null" \
        assert_alert_urgency_probe
    prove 'each title joins a quota name to its percentage' \
        "shell_eval \"[...$IND._alerts.values()].forEach(n => { n.title = 'nothing here'; }); 'ok'\" >/dev/null" \
        "shell_eval \"const i = $IND; [...i._alerts.keys()].forEach(k => i._withdrawAlert(k));
            i._fired = {}; i._syncAlerts(new Date()); 'ok'\" >/dev/null" \
        assert_alert_titles_probe
    prove 'a quota shows one banner at a time' \
        "shell_eval \"$IND._alerts.set('Session (5h)|warning', $IND._alerts.values().next().value); 'ok'\" >/dev/null" \
        "shell_eval \"$IND._alerts.delete('Session (5h)|warning'); 'ok'\" >/dev/null" \
        assert_one_alert_per_quota_probe
}

group_notify() {
    echo 'notify:'
    prove_alerts
    reset_alerts
    render_state normal
    sync_alerts
    assert_alert_keys 'quiet' '[]'
    assert_alerts 'quiet'
    render_state warning
    sync_alerts
    assert_alert_keys 'warning' '["Session (5h)|warning","Weekly|warning"]'
    assert_alerts 'warning'
    sync_alerts
    assert_alert_keys 'warning re-synced' '["Session (5h)|warning","Weekly|warning"]'
    reset_alerts
    render_state critical
    sync_alerts
    assert_alert_keys 'critical' '["Session (5h)|critical","Weekly|critical"]'
    assert_alerts 'critical'
    render_state expired
    sync_alerts
    assert_alert_keys 'expired' '[]'
    assert_eq 'expired empties the source with the last alert' 'null' \
        "$(probe "$IND._source")"
    reset_alerts
    render_state warning
    sync_alerts
    shell_eval "$IND._prefs.set_int('notify-critical-percent', 50); 'ok'" >/dev/null
    assert_alert_keys 'lowered threshold' '["Session (5h)|critical","Weekly|critical"]'
    shell_eval "$IND._prefs.reset('notify-critical-percent'); 'ok'" >/dev/null
    reset_alerts
}
```

Two of those assertions earn their place beyond the obvious: `warning re-synced` is the restart case — a second sync over unchanged state must add nothing — and `expired empties the source with the last alert` is the `Source` self-destruct trap, asserting the reference was nulled rather than left dangling. The lowered-threshold step needs no explicit sync: the `changed::` watch is what is under test.

- [ ] **Step 10: Run the group**

```bash
npm run e2e -- --group=notify --assert
```

Expected: every `ok …` line, four `prove …` lines, `N passed, 0 failed`. A `control …` line on stderr with a non-zero exit means an assertion is dead — fix the assertion, never the control.

- [ ] **Step 11: Prove the tooling still spends nothing**

```bash
wc -l ~/.cache/claude-quota/attempts.jsonl
npm run e2e -- --group=notify --assert
wc -l ~/.cache/claude-quota/attempts.jsonl
```

Expected: the count does not move. The nested shell runs with a `HOME` of its own holding no credentials; a notification path that somehow triggered a fetch would show up here.

- [ ] **Step 12: Check the host session is intact**

```bash
sha256sum ~/.config/dconf/user
gsettings get org.gnome.shell enabled-extensions | wc -c
```

Expected: unchanged from before the run. Every dconf write belongs inside the private `dbus-run-session`; this is the standing check after anything that starts a shell.

- [ ] **Step 13: Run everything and commit**

```bash
npm run lint
npm test
npm run e2e -- --assert
git add extension.js tools/lib/devkit.sh tools/lib/indicator.sh tools/e2e.sh
git commit -S -m "feat: notify when a quota crosses a threshold

The indicator turns alertPlan's diff into MessageTray calls and decides
nothing itself. Warning posts at NORMAL urgency, critical at HIGH, which
stays in the tray and shows over a fullscreen window; CRITICAL would never
auto-dismiss, which is rude about a number that resets on its own.

A Source destroys itself when its last notification is removed, so the
reference is re-made rather than held — the e2e group asserts the
reference went null when the last alert was withdrawn, because a stale
source fails silently.

markExpired is applied before planning: _quotas carries no expired flag,
_render derives it per paint, so the raw list reads a finished window as
live."
```

---

### Task 7: Document what shipped

**Files:**
- Modify: `README.md:233`, `README.md` § Development
- Modify: `docs/development.md:90-100`
- Modify: `AGENTS.md` § Things that will bite you

**Interfaces:**
- Consumes: the group name `notify` from Task 6, the schema id from Task 5.
- Produces: nothing code reads.

- [ ] **Step 1: Update the group list in README**

`README.md:233` currently reads `Groups: \`state\`, \`panel\`, \`hover\`, \`refresh\`, \`lifecycle\`.` — add `notify` in run order, before `lifecycle`:

```markdown
Groups: `state`, `panel`, `hover`, `refresh`, `notify`, `lifecycle`.
```

- [ ] **Step 2: Update the group table in docs/development.md**

`docs/development.md:90` says "Five groups run in the order below" — make it six, and add a row to the table beside the `lifecycle` row:

```markdown
| `notify` | a quota crossing a threshold posts one notification per level, escalates its urgency, withdraws it when the window ends, and re-reads its thresholds from GSettings |
```

- [ ] **Step 3: Document the notification settings for users**

In `README.md` § Development, after the e2e flags table, add a short section:

````markdown
### Notification thresholds

There is no preferences window yet. The four keys are readable and writable now:

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/claude-quota@e7d.io/schemas \
    set org.gnome.shell.extensions.claude-quota notify-warning-percent 70
```

`notify-warning-enabled`, `notify-warning-percent`, `notify-critical-enabled` and
`notify-critical-percent` — booleans default to `true`, the percentages to 75 and 90. A change
takes effect at once: lowering a threshold below a quota's current percentage notifies
immediately, and disabling a level withdraws whatever it had posted.
````

- [ ] **Step 4: Record the trap in AGENTS.md**

In § Things that will bite you, add:

```markdown
**A `MessageTray.Source` destroys itself when its last notification is removed.** So a held source reference goes stale with no error and the next post lands on a dead object — the shell's own `getSystemSource()` re-creates lazily and nulls its reference on `destroy`, and `_notifySource()` does the same. The e2e `notify` group asserts `_source` went `null` after the last alert was withdrawn, because nothing else would say so.
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/development.md AGENTS.md
git commit -S -m "docs: describe the notify group and the threshold keys

The settings have no window yet, so the gsettings invocation is the only
way a user changes a threshold and belongs written down."
```

---

## Self-review

**Spec coverage.** Every section of the design maps to a task: identity → 1; persistence → 2; the state machine's firing, dedup, roll and expiry rows → 3; hysteresis, disabled levels and supersede → 4; settings → 5; wiring, urgency, withdrawal, cleanup and the e2e group → 6; docs → 7. The spec's "what this design does not claim" needs no task — it is a statement about the limits of the evidence, and Task 6's steps 11 and 12 are where the two checkable parts of it (no requests spent, host session intact) actually get checked.

**Type consistency.** `alertPlan` takes `{quotas, fired, thresholds, now, locale, percentLocale}` and returns `{post, withdraw, fired}` in Tasks 3, 4 and 6 alike; `post` items carry `{key, quotaKey, level, title, body}` where they are built (3), filtered (4) and consumed (6); `thresholdsFrom` produces exactly the `[{level, percent, enabled}]` that `alertPlan` destructures. `quota.key` is produced in Task 1, keyed on in 3, and split back apart in the Task 6 assertions on the same `|` separator. `NOTIFY_DEFAULTS` and the schema defaults are two declarations of one decision, which Task 5 step 5 says out loud because nothing enforces it.

**Known soft spot.** Task 4's step 2 expects the hysteresis and disabled-level tests to pass already, since Task 3's `stale`/`armed` were written with them in view; only the supersede tests should fail. That is deliberate — those two rules are cheap to express and expensive to bolt on — but it means Task 4's red step is genuinely red for three tests, not nine. If the executor finds otherwise, the bug is in Task 3.
