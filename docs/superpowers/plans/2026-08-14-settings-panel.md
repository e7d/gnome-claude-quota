# Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a preferences window that owns the two severity thresholds and which quotas appear in the top bar and in the menu, with the thresholds — not the endpoint — defining severity.

**Architecture:** One gi-free `lib/settings.js` holds the key table, the three scope ids and their labels; `lib/policy.js` derives severity from a percentage at render time; `extension.js` filters its two surfaces by scope; `prefs.js` builds three `Adw.PreferencesGroup`s from that same table. No new runtime dependency, no build step.

**Tech Stack:** GJS (GNOME Shell 50), GTK 4 / libadwaita 1 via `Adw.PreferencesPage`, GSettings/dconf, `node --test` for `lib/`, bash harness (`tools/*.sh`) for the shell.

**Spec:** `docs/superpowers/specs/2026-08-14-settings-panel-design.md`

## Global Constraints

- Every `lib/` module except `usage.js` must stay free of `gi://` — they are imported by `node --test` as well as by the shell.
- No WHAT comments. A comment must name a hidden constraint a reader would otherwise break.
- No blank lines inside a function body; ≤ 20 lines per function is the soft cap; ≤ 3 positional args before an options object.
- Rendering is one-way: state fields on the indicator are the truth, `_render()` derives every actor. Never mutate an actor outside a render path.
- `N_()` at declaration, `_()` at read time. A module constant translated where it is declared freezes English, because module scope runs before `enable()` installs the translator.
- Defaults are **ours**, not Anthropic's: warning 75, critical 90. Any user-facing wording must not attribute them to Anthropic.
- Never write the host's dconf or kill a shell by name. Every settings write in the harness goes through the private `dbus-run-session` with `XDG_CONFIG_HOME="$CFG"`.
- Commits are signed (`git commit -S`) and carry no `Co-Authored-By` trailer, matching this repo's history.
- After any user-facing string change: `npm run i18n`, translate into `po/fr.po`, `npm run i18n:check` must pass, and the compiled `locale/**/*.mo` is committed.
- `npm run lint` and `npm test` must be clean before every commit.

### Divergences from the spec, decided while planning

- The spec described `scopeOf(quota)` as a predicate over the view object. It becomes `scopeForKind(kind)` in `lib/settings.js`, materialised as a **`scope` field on the model's quota** instead: the e2e harness fabricates quota objects whose `key` is a display name, so a predicate reading `key` would misclassify every fixture. Fixtures set `scope` explicitly, exactly as they already set `modelScoped`.
- `severityFor(percent, {warning, critical})` takes plain numbers rather than the spec's `{warningPercent, criticalPercent}`, so it composes directly with what `readSettings()` returns.
- Scenario `model-scoped` currently renders a 72% quota as `warning`. Under a 75% threshold that becomes `normal`, so its percentage moves to 78 to keep the scenario's meaning. The spec claimed every fixture percentage already crossed the defaults; this is the one that did not.

---

### Task 1: The key table and the schema

**Files:**
- Create: `lib/settings.js`
- Create: `test/settings.test.js`
- Modify: `schemas/org.gnome.shell.extensions.claude-quota.gschema.xml` (whole file)
- Modify: `schemas/gschemas.compiled` (regenerated)
- Modify: `extension.js:386-401` (`_notifyPrefs`, `_watchNotifyPrefs`)
- Modify: `lib/notify.js:21-26` (`thresholdsFrom` argument names)
- Modify: `test/notify.test.js` (calls to `thresholdsFrom`)

**Interfaces:**
- Consumes: nothing.
- Produces: `SCOPES`, `THRESHOLDS`, `SCOPE_IDS`, `scopeForKind(kind)`, `readSettings(get)` from `lib/settings.js`. `readSettings` returns
  `{warning: {percent, notify}, critical: {percent, notify}, visible: {session: {bar, menu}, weekly: {…}, scoped: {…}}}`, frozen. Its `get` argument is `{int(key), boolean(key)}`.

- [ ] **Step 1: Write the failing test**

Create `test/settings.test.js`:

```js
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {SCOPES, SCOPE_IDS, THRESHOLDS, readSettings, scopeForKind} from '../lib/settings.js';

function schemaKeys() {
    const xml = readFileSync(new URL('../schemas/org.gnome.shell.extensions.claude-quota.gschema.xml',
        import.meta.url), 'utf8');
    return [...xml.matchAll(/<key name="([^"]+)"/g)].map(([, name]) => name);
}

function stub(overrides = {}) {
    const values = {
        'warning-percent': 75, 'critical-percent': 90,
        'warning-notify': true, 'critical-notify': true,
        'session-in-bar': true, 'session-in-menu': true,
        'weekly-in-bar': true, 'weekly-in-menu': true,
        'scoped-in-bar': true, 'scoped-in-menu': true,
        ...overrides,
    };
    return {int: key => values[key], boolean: key => values[key]};
}

test('every key the table names exists in the committed schema', () => {
    const keys = schemaKeys();
    THRESHOLDS.forEach(level => {
        assert.ok(keys.includes(level.percentKey), `${level.percentKey} missing from schema`);
        assert.ok(keys.includes(level.notifyKey), `${level.notifyKey} missing from schema`);
    });
    SCOPES.forEach(scope => {
        assert.ok(keys.includes(scope.barKey), `${scope.barKey} missing from schema`);
        assert.ok(keys.includes(scope.menuKey), `${scope.menuKey} missing from schema`);
    });
});

test('the schema names no key the table does not', () => {
    const named = new Set(THRESHOLDS.flatMap(level => [level.percentKey, level.notifyKey])
        .concat(SCOPES.flatMap(scope => [scope.barKey, scope.menuKey])));
    schemaKeys().forEach(key => assert.ok(named.has(key), `${key} is in the schema and not in the table`));
});

test('scopeForKind maps the three payload kinds', () => {
    assert.equal(scopeForKind('session'), 'session');
    assert.equal(scopeForKind('weekly_all'), 'weekly');
    assert.equal(scopeForKind('weekly_scoped'), 'scoped');
    assert.equal(scopeForKind('something_new'), 'scoped');
});

test('SCOPE_IDS lists the scopes in display order', () => {
    assert.deepEqual(SCOPE_IDS, ['session', 'weekly', 'scoped']);
});

test('readSettings shapes the thresholds and the visibility', () => {
    const settings = readSettings(stub({'warning-percent': 60, 'weekly-in-bar': false}));
    assert.deepEqual(settings.warning, {percent: 60, notify: true});
    assert.deepEqual(settings.critical, {percent: 90, notify: true});
    assert.equal(settings.visible.weekly.bar, false);
    assert.equal(settings.visible.weekly.menu, true);
    assert.equal(settings.visible.scoped.bar, true);
});

test('readSettings returns a frozen object', () => {
    const settings = readSettings(stub());
    assert.throws(() => {
        settings.warning = null;
    }, TypeError);
    assert.throws(() => {
        settings.visible.session.bar = false;
    }, TypeError);
});

test('the shipped defaults are 75 and 90', () => {
    assert.deepEqual(THRESHOLDS.map(level => level.percent), [75, 90]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../lib/settings.js'`.

- [ ] **Step 3: Write `lib/settings.js`**

```js
import {N_} from './i18n.js';

export const SCOPES = [
    {id: 'session', name: N_('Session (5h)'), barKey: 'session-in-bar', menuKey: 'session-in-menu'},
    {id: 'weekly', name: N_('Weekly'), barKey: 'weekly-in-bar', menuKey: 'weekly-in-menu'},
    {id: 'scoped', name: N_('Model-specific'), barKey: 'scoped-in-bar', menuKey: 'scoped-in-menu'},
];

export const SCOPE_IDS = SCOPES.map(scope => scope.id);

export const THRESHOLDS = [
    {level: 'warning', percent: 75, percentKey: 'warning-percent', notifyKey: 'warning-notify'},
    {level: 'critical', percent: 90, percentKey: 'critical-percent', notifyKey: 'critical-notify'},
];

const KINDS = {session: 'session', weekly_all: 'weekly'};

export function scopeForKind(kind) {
    return KINDS[kind] ?? 'scoped';
}

function levelFrom(get, level) {
    return Object.freeze({percent: get.int(level.percentKey), notify: get.boolean(level.notifyKey)});
}

function visibilityFrom(get) {
    return Object.freeze(Object.fromEntries(SCOPES.map(scope =>
        [scope.id, Object.freeze({bar: get.boolean(scope.barKey), menu: get.boolean(scope.menuKey)})])));
}

export function readSettings(get) {
    return Object.freeze(Object.assign(
        Object.fromEntries(THRESHOLDS.map(level => [level.level, levelFrom(get, level)])),
        {visible: visibilityFrom(get)}));
}

export const KEYS = THRESHOLDS.flatMap(level => [level.percentKey, level.notifyKey])
    .concat(SCOPES.flatMap(scope => [scope.barKey, scope.menuKey]));
```

- [ ] **Step 4: Rewrite the schema**

Replace `schemas/org.gnome.shell.extensions.claude-quota.gschema.xml` entirely:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <schema id="org.gnome.shell.extensions.claude-quota" path="/org/gnome/shell/extensions/claude-quota/">
    <key name="warning-percent" type="i">
      <range min="1" max="100"/>
      <default>75</default>
      <summary>High usage threshold</summary>
      <description>Percentage of a quota at which it is shown as high usage.</description>
    </key>
    <key name="warning-notify" type="b">
      <default>true</default>
      <summary>Notify at high usage</summary>
      <description>Show a notification when a quota reaches the high usage threshold.</description>
    </key>
    <key name="critical-percent" type="i">
      <range min="1" max="100"/>
      <default>90</default>
      <summary>Critical usage threshold</summary>
      <description>Percentage of a quota at which it is shown as critical.</description>
    </key>
    <key name="critical-notify" type="b">
      <default>true</default>
      <summary>Notify at critical usage</summary>
      <description>Show a notification when a quota reaches the critical usage threshold.</description>
    </key>
    <key name="session-in-bar" type="b">
      <default>true</default>
      <summary>Show the session quota in the top bar</summary>
      <description>Whether the session quota appears in the top bar.</description>
    </key>
    <key name="session-in-menu" type="b">
      <default>true</default>
      <summary>Show the session quota in the menu</summary>
      <description>Whether the session quota appears in the menu.</description>
    </key>
    <key name="weekly-in-bar" type="b">
      <default>true</default>
      <summary>Show the weekly quota in the top bar</summary>
      <description>Whether the weekly quota appears in the top bar.</description>
    </key>
    <key name="weekly-in-menu" type="b">
      <default>true</default>
      <summary>Show the weekly quota in the menu</summary>
      <description>Whether the weekly quota appears in the menu.</description>
    </key>
    <key name="scoped-in-bar" type="b">
      <default>true</default>
      <summary>Show model-specific quotas in the top bar</summary>
      <description>Whether model-specific quotas appear in the top bar.</description>
    </key>
    <key name="scoped-in-menu" type="b">
      <default>true</default>
      <summary>Show model-specific quotas in the menu</summary>
      <description>Whether model-specific quotas appear in the menu.</description>
    </key>
  </schema>
</schemalist>
```

Then recompile: `glib-compile-schemas schemas/`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, count up by 7.

- [ ] **Step 6: Rename the keys at the two read sites**

`lib/notify.js:21` — rename the destructured argument names so they match `readSettings`:

```js
export function thresholdsFrom({warning, critical}) {
    return [
        {level: 'warning', percent: warning.percent, enabled: warning.notify},
        {level: 'critical', percent: critical.percent, enabled: critical.notify},
    ];
}
```

`extension.js` — replace `_notifyPrefs()` and `_watchNotifyPrefs()` with one settings read over the whole table:

```js
    _settingsValues() {
        return readSettings({
            int: key => this._prefs.get_int(key),
            boolean: key => this._prefs.get_boolean(key),
        });
    }

    _watchPrefs() {
        KEYS.forEach(key => this._prefsSignals.push(
            this._prefs.connect(`changed::${key}`, () => {
                this._syncAlerts(new Date());
                this._render();
            })));
    }
```

Import `{KEYS, readSettings}` from `./lib/settings.js`, replace the `_notifyPrefs()` call site with `this._settingsValues()`, and rename the `_watchNotifyPrefs()` call to `_watchPrefs()`. Update `test/notify.test.js` calls to pass `{warning: {percent, notify}, critical: {…}}`.

- [ ] **Step 7: Verify the whole suite and the linter**

Run: `npm test 2>&1 | tail -5 && npm run lint`
Expected: PASS, lint silent.

- [ ] **Step 8: Commit**

```bash
git add lib/settings.js test/settings.test.js schemas/ extension.js lib/notify.js test/notify.test.js
git commit -S -m "feat(settings): name every key once, in one table

Ten keys replace the four notify-* ones, which were never pushed and so need
no migration. The table lives in lib/settings.js because prefs.js, the shell
and the tests all have to agree on it, and a test parses the committed gschema
so the table and the schema cannot drift apart."
```

---

### Task 2: Thresholds define severity

**Files:**
- Modify: `lib/policy.js` (add `severityFor`, `markSeverity`)
- Modify: `lib/model.js:8,9,88-100` (drop `KNOWN_SEVERITIES` and the `severity` field, add `scope`, read names from `SCOPES`)
- Modify: `test/policy.test.js`
- Modify: `test/model.test.js`

**Interfaces:**
- Consumes: `SCOPES`, `scopeForKind` from Task 1.
- Produces: `severityFor(percent, {warning, critical})` → `'normal' | 'warning' | 'critical'`, and `markSeverity(quotas, thresholds)` → the same array with a `severity` field, both from `lib/policy.js`. `quotas()` output gains `scope` and loses `severity`.

- [ ] **Step 1: Write the failing tests**

Append to `test/policy.test.js`:

```js
test('severityFor reads the boundaries inclusively', () => {
    const thresholds = {warning: 75, critical: 90};
    assert.equal(severityFor(74, thresholds), 'normal');
    assert.equal(severityFor(75, thresholds), 'warning');
    assert.equal(severityFor(89, thresholds), 'warning');
    assert.equal(severityFor(90, thresholds), 'critical');
    assert.equal(severityFor(100, thresholds), 'critical');
});

test('severityFor treats a non-finite percentage as normal', () => {
    assert.equal(severityFor(null, {warning: 75, critical: 90}), 'normal');
    assert.equal(severityFor(Number.NaN, {warning: 75, critical: 90}), 'normal');
});

test('severityFor leaves no band uncoloured when the pair is inverted', () => {
    const inverted = {warning: 95, critical: 80};
    assert.equal(severityFor(79, inverted), 'normal');
    assert.equal(severityFor(85, inverted), 'critical');
    assert.equal(severityFor(96, inverted), 'critical');
});

test('markSeverity derives a severity per quota and leaves an expired one normal', () => {
    const marked = markSeverity([
        {percent: 30, expired: false},
        {percent: 96, expired: false},
        {percent: 96, expired: true},
    ], {warning: 75, critical: 90});
    assert.deepEqual(marked.map(quota => quota.severity), ['normal', 'critical', 'normal']);
});

test('markSeverity does not mutate its input', () => {
    const quotas = [{percent: 96, expired: false}];
    markSeverity(quotas, {warning: 75, critical: 90});
    assert.equal(quotas[0].severity, undefined);
});
```

Add to `test/model.test.js`:

```js
test('a quota carries its settings scope and no severity of its own', () => {
    const result = quotas(payload(), now);
    assert.deepEqual(result.map(quota => quota.scope), ['session', 'weekly', 'scoped']);
    result.forEach(quota => assert.equal(quota.severity, undefined));
});
```

Import `severityFor` and `markSeverity` in `test/policy.test.js`, and adjust any existing `model.test.js` assertion that reads `severity`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `severityFor is not a function`, and the model test failing on `scope`.

- [ ] **Step 3: Add the two functions to `lib/policy.js`**

```js
export function severityFor(percent, {warning, critical}) {
    if (!Number.isFinite(percent))
        return 'normal';
    if (percent >= critical)
        return 'critical';
    return percent >= warning ? 'warning' : 'normal';
}

export function markSeverity(quotas, thresholds) {
    return quotas.map(quota => ({
        ...quota,
        severity: quota.expired ? 'normal' : severityFor(quota.percent, thresholds),
    }));
}
```

- [ ] **Step 4: Take severity out of the model, put the scope in**

In `lib/model.js`: delete `const KNOWN_SEVERITIES = …`, delete the `NAMES` map and import the labels instead, and replace the `severity` field with `scope`:

```js
import {SCOPES, scopeForKind} from './settings.js';

const NAMES = Object.fromEntries(SCOPES
    .filter(scope => scope.id !== 'scoped')
    .map(scope => [scope.id === 'session' ? 'session' : 'weekly_all', scope.name]));
```

and inside the mapped object:

```js
                scope: scopeForKind(limit.kind),
```

`SHORTS` stays in `model.js` — a panel initial is a rendering concern, not a setting.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -5 && npm run lint`
Expected: PASS, count up by 6, lint silent.

- [ ] **Step 6: Commit**

```bash
git add lib/policy.js lib/model.js test/policy.test.js test/model.test.js
git commit -S -m "feat(severity): derive severity from the thresholds, not the payload

The endpoint's severity field left nothing to configure and handed Anthropic the
decision about when a user is interrupted. severityFor tests critical first, so
an inverted pair written straight into dconf degrades to 'critical from the lower
number up' rather than leaving a band with no severity at all.

quotas() also stops naming its own labels: they come from the scope table, so the
popup and the preferences window cannot disagree about what a quota is called."
```

---

### Task 3: Colour resolves at render time

**Files:**
- Modify: `extension.js:807-812` (`_render`), `extension.js:68-70` (`quotaClass`)
- Modify: `tools/lib/indicator.sh:63-70,97,137-151` (`q()` and every scenario)
- Modify: `tools/e2e.sh` (one assertion plus its control)

**Interfaces:**
- Consumes: `markSeverity` from Task 2, `readSettings` from Task 1.
- Produces: quota view objects reaching `_renderPanel()` and the blocks already carry `severity` and `scope`. `q()` in the harness takes `(short, name, percent, leftMin, winMin)` — the `severity` argument is gone.

- [ ] **Step 1: Write the failing e2e assertion**

In `tools/e2e.sh`, beside the other state assertions:

```bash
assert_threshold_repaints() {
    local before after
    before="$(probe "$IND._blocks[0]._percent.get_style_class_name()")"
    set_quota_pref warning-percent 5
    after="$(probe "$IND._blocks[0]._percent.get_style_class_name()")"
    set_quota_pref warning-percent 75
    assert_ne "$1 a lower warning threshold repaints a normal quota" "$before" "$after"
}

assert_threshold_repaints_probe() { assert_threshold_repaints control; }
```

and add its control to `prove_state`, inverted by pinning the class so the repaint cannot show:

```bash
    render_state normal
    prove 'a lower warning threshold repaints' \
        "shell_eval \"$IND._blocks[0]._percent.style_class = 'cq-percent cq-warning-dark'; $IND._render = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._render(); 'ok'\" >/dev/null" \
        assert_threshold_repaints_probe
```

Add the helper it needs to `tools/lib/devkit.sh`, next to `set_animations`:

```bash
set_quota_pref() {
    XDG_CONFIG_HOME="$CFG" GSETTINGS_SCHEMA_DIR="$ROOT/schemas" \
        gsettings set org.gnome.shell.extensions.claude-quota "$1" "$2"
    await_paint
}
```

- [ ] **Step 2: Run the narrowed group and watch it fail**

Run: `npm run e2e -- --group=state --dark-only --scenario=normal 2>&1 | tail -20`
Expected: FAIL — the class does not change, because severity is still whatever the fixture said.

- [ ] **Step 3: Derive severity in `_render()`**

```js
    _render() {
        const now = new Date();
        const scheme = this._scheme;
        const settings = this._settingsValues();
        const quotaViews = markSeverity(markExpired(this._quotas, now), {
            warning: settings.warning.percent,
            critical: settings.critical.percent,
        });
```

`quotaClass` loses its `expired` special case, since `markSeverity` already applied it:

```js
function quotaClass(base, quota, scheme) {
    return severityClass(base, quota.severity, scheme);
}
```

- [ ] **Step 4: Take severity out of the fixtures**

`tools/lib/indicator.sh` — `q()` drops the argument and derives the scope the way the model does:

```bash
QUOTA="const q = (short, name, percent, leftMin, winMin) => {
    const progress = Math.min(1, Math.max(0, 1 - leftMin / winMin));
    const scoped = !['Session (5h)', 'Weekly'].includes(name);
    return {
        key: name, short, name, percent,
        modelScoped: scoped,
        scope: scoped ? 'scoped' : (name === 'Weekly' ? 'weekly' : 'session'),
        resetsAt: new Date(ANCHOR + leftMin * 60000),
        windowProgress: progress,
        aheadOfPace: percent / 100 - progress > 0.1,
    };
};
const SESSION = 300, WEEK = 10080;"
```

Then drop the severity argument from every `q(...)` call in `setup_quotas` and `setup_for`, and raise `model-scoped`'s third quota from 72 to 78 so it stays a warning under a 75% threshold:

```bash
        model-scoped) echo "i._quotas = [q('S','Session (5h)',30,200,SESSION), q('W','Weekly',44,5000,WEEK), q('O','Opus',78,200,SESSION)];" ;;
```

- [ ] **Step 5: Run the state group in both themes to verify it passes**

Run: `npm run e2e -- --group=state 2>&1 | tail -15`
Expected: PASS, including the new assertion and its control. `control …` on stderr with a non-zero exit means the assertion is dead — fix the assertion, never the control.

- [ ] **Step 6: Check the colours are still the colours**

Run: `npm run a11y`
Expected: exit 0, findings unchanged from before the task.

- [ ] **Step 7: Commit**

```bash
git add extension.js tools/lib/indicator.sh tools/e2e.sh tools/lib/devkit.sh
git commit -S -m "feat(severity): resolve a quota's colour when it renders

Severity is now a function of the percentage and the current thresholds, so it
has to be computed where the render happens rather than carried from the parse.
That is also what makes it observable: the harness lowers warning-percent and
asserts the row repaints, which was impossible while the fixture named the
severity itself."
```

---

### Task 4: Two surfaces, filtered by scope

**Files:**
- Modify: `extension.js` (`_render`, `_renderPanel` call, block construction, a new hidden-state label)
- Modify: `tools/e2e.sh` (two assertions plus controls)
- Modify: `po/claude-quota.pot`, `po/fr.po`, `locale/fr/LC_MESSAGES/claude-quota.mo`

**Interfaces:**
- Consumes: `readSettings` (Task 1), quota views carrying `scope` (Tasks 2–3).
- Produces: `_visibleOn(surface, views)` on the indicator, returning the subset whose scope is enabled for `'bar'` or `'menu'`.

- [ ] **Step 1: Write the failing assertions**

In `tools/e2e.sh`:

```bash
assert_scope_leaves_the_bar() {
    local before after
    before="$(probe "$SHOWN_CELLS.length")"
    set_quota_pref weekly-in-bar false
    after="$(probe "$SHOWN_CELLS.length")"
    set_quota_pref weekly-in-bar true
    assert_eq "$1 hiding the weekly quota takes a cell out of the bar" \
        "$((before - 1))" "$after"
}

assert_scope_leaves_the_menu() {
    local hidden
    set_quota_pref weekly-in-menu false
    hidden="$(probe "$IND._blocks.length")"
    set_quota_pref weekly-in-menu true
    assert_eq "$1 hiding the weekly quota takes a block out of the menu" \
        "$(( $(probe "$IND._quotas.length") - 1 ))" "$hidden"
}

assert_all_hidden_says_so() {
    set_quota_pref session-in-menu false
    set_quota_pref weekly-in-menu false
    set_quota_pref scoped-in-menu false
    local shown text
    shown="$(probe "$IND._hiddenNote.visible")"
    text="$(probe "$IND._hiddenNote.text")"
    set_quota_pref session-in-menu true
    set_quota_pref weekly-in-menu true
    set_quota_pref scoped-in-menu true
    assert_eq "$1 a menu with every quota hidden says why it is empty" 'true' "$shown"
    assert_ne "$1 the hidden note carries a string" '""' "$text"
}

assert_scope_leaves_the_bar_probe() { assert_scope_leaves_the_bar control; }
assert_scope_leaves_the_menu_probe() { assert_scope_leaves_the_menu control; }
assert_all_hidden_says_so_probe() { assert_all_hidden_says_so control; }
```

Call the three from `assert_state`, and add controls to `prove_state` that make the filter a no-op:

```bash
    render_state normal
    prove 'hiding a scope empties its cell' \
        "shell_eval \"$IND._visibleOn = (surface, views) => views; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._visibleOn; $IND._render(); 'ok'\" >/dev/null" \
        assert_scope_leaves_the_bar_probe
    prove 'hiding a scope empties its block' \
        "shell_eval \"$IND._visibleOn = (surface, views) => views; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._visibleOn; $IND._render(); 'ok'\" >/dev/null" \
        assert_scope_leaves_the_menu_probe
    prove 'an all-hidden menu explains itself' \
        "shell_eval \"$IND._hiddenNote.visible = false; $IND._render = () => {}; 'ok'\" >/dev/null" \
        "shell_eval \"delete $IND._render; $IND._render(); 'ok'\" >/dev/null" \
        assert_all_hidden_says_so_probe
```

- [ ] **Step 2: Run the narrowed group and watch it fail**

Run: `npm run e2e -- --group=state --dark-only --scenario=normal 2>&1 | tail -25`
Expected: FAIL on all three — `_visibleOn` and `_hiddenNote` do not exist.

- [ ] **Step 3: Filter both surfaces**

Add the filter and use it in `_render()`:

```js
    _visibleOn(surface, views) {
        const visible = this._settingsValues().visible;
        return views.filter(quota => visible[quota.scope][surface]);
    }
```

`_render()` passes the bar subset to `_renderPanel()` and builds the blocks from the menu subset:

```js
        const menuViews = this._visibleOn('menu', quotaViews);
        this._renderActions(now);
        this._renderPanel(this._visibleOn('bar', quotaViews));
        if (this._blocks.length !== menuViews.length) {
```

with `menuViews` replacing `quotaViews` through the block construction, the `forEach` that updates them, and `hasQuotas`. The bar filter runs **before** `_fitPanel()` measures, which it does by construction: `_renderPanel()` builds `_panelCells` from what it is handed.

- [ ] **Step 4: Add the hidden note**

Beside the block box, one label built in `_init` and driven from `_render`:

```js
        this._hiddenNote = new St.Label({style_class: 'cq-caption', text: ''});
        this._body.add_child(this._hiddenNote);
```

and in `_render()`, after the blocks:

```js
        const allHidden = quotaViews.length > 0 && menuViews.length === 0;
        this._hiddenNote.visible = allHidden;
        if (allHidden)
            this._hiddenNote.text = _('Every quota is hidden — see the extension settings');
```

- [ ] **Step 5: Run the group to verify it passes**

Run: `npm run e2e -- --group=state 2>&1 | tail -15`
Expected: PASS, three new assertions and three new controls.

- [ ] **Step 6: Extract and translate the new string**

Run: `npm run i18n`
Then add to `po/fr.po`:

```po
msgid "Every quota is hidden — see the extension settings"
msgstr "Tous les quotas sont masqués — voir les réglages de l'extension"
```

Compile and check: `msgfmt po/fr.po -o locale/fr/LC_MESSAGES/claude-quota.mo && npm run i18n:check`
Expected: silent.

- [ ] **Step 7: Verify it renders in French**

Run: `npm run preview -- --headless --detach --capture --language=fr_FR --scenario=normal && npm run preview -- --stop`
Expected: a tile in `preview/`; the run must not spend a request — `wc -l ~/.cache/claude-quota/attempts.jsonl` unchanged.

- [ ] **Step 8: Commit**

```bash
git add extension.js tools/e2e.sh po locale
git commit -S -m "feat(settings): let a quota leave the bar, the menu, or both

The two surfaces filter on the quota's scope, and the bar filters before the
responsive fit measures, so hiding the weekly quota gives the remaining cells
its room instead of leaving a gap. A menu with every quota hidden says so
rather than reusing the no-data empty state, which would claim the fetch had
failed when the user simply hid everything."
```

---

### Task 5: The preferences window, and a way to look at it

**Files:**
- Create: `prefs.js`
- Modify: `tools/preview.sh` (a `--prefs` flag, its usage line)
- Modify: `tools/lib/devkit.sh` (`--wayland-display` on the nested shell, a `prefs_window` launcher)
- Modify: `tools/lib/capture.sh` (`capture_prefs`)
- Modify: `po/claude-quota.pot`, `po/fr.po`, `locale/fr/LC_MESSAGES/claude-quota.mo`
- Modify: `README.md`, `docs/development.md`

**Interfaces:**
- Consumes: `SCOPES`, `THRESHOLDS` from Task 1.
- Produces: `preview/prefs-<theme>.png`, and `npm run preview -- --prefs [--capture]`.

- [ ] **Step 1: Write `prefs.js`**

```js
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SCOPES, THRESHOLDS} from './lib/settings.js';

const TITLES = {
    warning: () => _('High usage threshold'),
    critical: () => _('Critical usage threshold'),
};

const NOTIFY_TITLES = {
    warning: () => _('Notify at high usage'),
    critical: () => _('Notify at critical usage'),
};

function resetButton(settings, key) {
    const button = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: _('Restore the default'),
        valign: Gtk.Align.CENTER,
        has_frame: false,
    });
    const sync = () => {
        button.sensitive = settings.get_int(key) !== settings.get_default_value(key).get_int32();
    };
    button.connect('clicked', () => settings.reset(key));
    settings.connect(`changed::${key}`, sync);
    sync();
    return button;
}

function thresholdRow(settings, level) {
    const row = new Adw.SpinRow({
        title: TITLES[level.level](),
        adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 1, page_increment: 5}),
    });
    settings.bind(level.percentKey, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(resetButton(settings, level.percentKey));
    return row;
}

function notifyRow(settings, level) {
    const row = new Adw.SwitchRow({title: NOTIFY_TITLES[level.level]()});
    settings.bind(level.notifyKey, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function surfaceGroup(settings, {title, key}) {
    const group = new Adw.PreferencesGroup({title});
    SCOPES.forEach(scope => {
        const row = new Adw.SwitchRow({title: _(scope.name)});
        settings.bind(scope[key], row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    });
    return group;
}

// A pair the user cannot cross is a pair severityFor never has to disambiguate on
// screen; dconf can still be written by hand, which is why the function clamps too.
function clampToEachOther(settings, rows) {
    const [warning, critical] = rows;
    const sync = () => {
        warning.adjustment.set_upper(settings.get_int('critical-percent'));
        critical.adjustment.set_lower(settings.get_int('warning-percent'));
    };
    settings.connect('changed::warning-percent', sync);
    settings.connect('changed::critical-percent', sync);
    sync();
}

export default class ClaudeQuotaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const thresholds = new Adw.PreferencesGroup({title: _('Thresholds')});
        const spins = THRESHOLDS.map(level => {
            const row = thresholdRow(settings, level);
            thresholds.add(row);
            thresholds.add(notifyRow(settings, level));
            return row;
        });
        clampToEachOther(settings, spins);
        page.add(thresholds);
        page.add(surfaceGroup(settings, {title: _('Show in top bar'), key: 'barKey'}));
        page.add(surfaceGroup(settings, {title: _('Show in menu'), key: 'menuKey'}));
        window.add(page);
    }
}
```

- [ ] **Step 2: Teach the harness to open it**

In `tools/lib/devkit.sh`, give the nested shell a deterministic Wayland socket by adding to the `gnome-shell` arguments in `start_shell`: `--wayland-display="$DEVKIT_NAME"`. Then add the launcher:

```bash
prefs_window() {
    env -u LC_ALL HOME="$SANDBOX_HOME" XDG_CONFIG_HOME="$CFG" \
        WAYLAND_DISPLAY="$DEVKIT_NAME" GDK_BACKEND=wayland \
        LC_MESSAGES="$DEVKIT_LANGUAGE" LC_TIME="$DEVKIT_LOCALE" LC_NUMERIC="$DEVKIT_LOCALE" \
        gnome-extensions prefs "$UUID" >>"$LOG" 2>&1 &
    for _ in $(seq 100); do
        [ "$(eval_json "global.get_window_actors().length")" != '0' ] && return 0
        sleep 0.2
    done
    die 'the preferences window never appeared'
}
```

In `tools/lib/capture.sh`:

```bash
prefs_box() {
    shell_eval "const a = global.get_window_actors()
        .find(a => a.meta_window.get_gtk_application_id() !== null) ?? global.get_window_actors()[0];
        const r = a.meta_window.get_frame_rect();
        [r.x, r.y, r.width, r.height].join(' ')" | unwrap
}

capture_prefs() {
    local box rect
    box="$(prefs_box)"
    [ -n "$box" ] || die 'could not measure the preferences window'
    read -r -a rect <<<"$box"
    await_style
    shoot "$(out_dir)/prefs-$1.png" "${rect[@]}"
    SHOTS+=("$(out_dir)/prefs-$1.png")
    echo "$(out_dir)/prefs-$1.png"
}
```

In `tools/preview.sh`: a `PREFS=0` default, `--prefs) PREFS=1 ;;` in the argument loop, the usage line `  --prefs            Open the preferences window in the session`, and after the shape is applied:

```bash
open_prefs() {
    [ "$PREFS" -eq 1 ] || return 0
    prefs_window
    [ "$CAPTURE" -eq 1 ] && capture_prefs "$WANT_THEME"
    return 0
}
```

- [ ] **Step 3: Run it and look at the window**

Run: `npm run preview -- --headless --detach --prefs --capture --dark && npm run preview -- --stop`
Expected: `preview/prefs-dark.png` exists. Open it and check: three groups, the two spin rows carry a reset button, the reset is insensitive at 75 and 90.

- [ ] **Step 4: Prove the window writes what the shell reads**

Run:

```bash
npm run preview -- --headless --detach --prefs --scenario=normal
gsettings --schemadir schemas set org.gnome.shell.extensions.claude-quota warning-percent 5
npm run preview -- --capture --dark
gsettings --schemadir schemas reset org.gnome.shell.extensions.claude-quota warning-percent
npm run preview -- --stop
```

Expected: the captured tile shows both quotas amber. This proves the round trip end to end; the assertions from Tasks 3–4 are what keep it proven.

- [ ] **Step 5: Extract and translate the eight new strings**

Run: `npm run i18n`
Then add to `po/fr.po` — *Thresholds*, *High usage threshold*, *Notify at high usage*, *Critical usage threshold*, *Notify at critical usage*, *Show in top bar*, *Show in menu*, *Restore the default*, *Model-specific*:

```po
msgid "Thresholds"
msgstr "Seuils"

msgid "High usage threshold"
msgstr "Seuil d'usage élevé"

msgid "Notify at high usage"
msgstr "Notifier à l'usage élevé"

msgid "Critical usage threshold"
msgstr "Seuil d'usage critique"

msgid "Notify at critical usage"
msgstr "Notifier à l'usage critique"

msgid "Show in top bar"
msgstr "Afficher dans la barre supérieure"

msgid "Show in menu"
msgstr "Afficher dans le menu"

msgid "Restore the default"
msgstr "Rétablir la valeur par défaut"

msgid "Model-specific"
msgstr "Par modèle"
```

Run: `msgfmt po/fr.po -o locale/fr/LC_MESSAGES/claude-quota.mo && npm run i18n:check`
Expected: silent.

- [ ] **Step 6: Document it**

`README.md` — a Settings section naming the three groups, stating the defaults are the extension's own (75 and 90, not Anthropic's), and that the thresholds decide colour and notification alike; plus `--prefs` in the Development flag list.

`docs/development.md` — `--prefs` under the preview flags, with the two facts a reader would otherwise rediscover: the window is a separate process reached over the session's own Wayland socket, and it earns a screenshot rather than assertions because driving Adw from outside needs AT-SPI.

- [ ] **Step 7: Verify everything**

Run: `npm run lint && npm test 2>&1 | tail -3 && npm run e2e 2>&1 | tail -8 && npm run a11y`
Expected: lint silent, unit suite green, e2e green with every control firing, `a11y` exit 0.

Then confirm the host session is untouched:

Run: `sha256sum ~/.config/dconf/user && gsettings get org.gnome.shell enabled-extensions | wc -c`
Expected: the same digest and length as before the run.

- [ ] **Step 8: Commit**

```bash
git add prefs.js tools/preview.sh tools/lib/devkit.sh tools/lib/capture.sh po locale README.md docs/development.md
git commit -S -m "feat(prefs): a preferences window built from the key table

Three groups of stock rows: the two thresholds with a reset button that is
insensitive while the value is already the default, and one switch per quota per
surface. Rows are generated from the same table the shell reads, so a key cannot
exist in the window and not in the schema.

A row carrying two switches was mocked and rejected — add_suffix is native API,
but nothing in Adw means 'two booleans', so the accessible labelling would have
depended on us remembering to add it.

preview.sh --prefs opens the window inside the devkit session over that session's
own Wayland socket and shoots it. It gets a screenshot and no assertions, because
driving Adw from outside the process needs AT-SPI; what the settings do is
asserted in the shell, where the harness already lives."
```

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: the key table and schema → Task 1; severity from thresholds, the dropped `severity` field and the scope labels → Task 2; render-time colour and the fixtures → Task 3; both visibility filters and the all-hidden string → Task 4; the preferences window, `--prefs`, i18n and the docs → Task 5. The spec's `test/settings.test.js` schema cross-check is Task 1 Step 1; its "no silent caps" equivalent — every new assertion carrying a control — is in Tasks 3 and 4.

**Placeholders.** None: every step carries the code or the exact command it needs.

**Type consistency.** `readSettings` returns `{warning, critical, visible}` and is consumed with that shape by `thresholdsFrom` (Task 1), `markSeverity` (Task 3) and `_visibleOn` (Task 4). `severityFor` takes `{warning, critical}` as numbers throughout. `q()` is five-argument from Task 3 onwards, and `scope` is set by both the model (Task 2) and the fixtures (Task 3) using the same three ids as `SCOPE_IDS`.

**Known risk.** Task 5 Step 2 assumes `gnome-extensions prefs` can reach the nested compositor over `--wayland-display`. The flag exists in this GNOME Shell (`gnome-shell --help`), but the round trip is unverified until that step runs. If the window refuses to appear, the fallback is to shoot the whole virtual monitor with the window centred on it — the same picture, cropped less precisely — and the task's other steps are unaffected.
