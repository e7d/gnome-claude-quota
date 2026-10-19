import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {ACCOUNT_KEY, CONFIG_DIR_KEY, KEYS, LANGUAGE_KEY, PLAN_KEY, SCOPES, SCOPE_IDS, THRESHOLDS, readSettings, scopeForKind} from '../lib/settings.js';

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
        'show-account': false, 'show-plan': false,
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
    assert.ok(keys.includes(ACCOUNT_KEY), `${ACCOUNT_KEY} missing from schema`);
    assert.ok(keys.includes(PLAN_KEY), `${PLAN_KEY} missing from schema`);
    assert.ok(keys.includes(LANGUAGE_KEY), `${LANGUAGE_KEY} missing from schema`);
    assert.ok(keys.includes(CONFIG_DIR_KEY), `${CONFIG_DIR_KEY} missing from schema`);
});

test('the schema names no key the table does not', () => {
    const named = new Set(THRESHOLDS.flatMap(level => [level.percentKey, level.notifyKey])
        .concat(SCOPES.flatMap(scope => [scope.barKey, scope.menuKey]), [ACCOUNT_KEY, CONFIG_DIR_KEY, PLAN_KEY, LANGUAGE_KEY]));
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

test('the account is off unless the key says otherwise', () => {
    assert.equal(readSettings(stub()).account, false);
    assert.equal(readSettings(stub({'show-account': true})).account, true);
});

test('the plan is off unless the key says otherwise', () => {
    assert.equal(readSettings(stub()).plan, false);
    assert.equal(readSettings(stub({'show-plan': true})).plan, true);
});

test('the account and plan keys are not among the keys that re-plan alerts', () => {
    assert.ok(!KEYS.includes(ACCOUNT_KEY));
    assert.ok(!KEYS.includes(PLAN_KEY));
});

test('the language key is not among the keys that re-plan alerts', () => {
    assert.ok(!KEYS.includes(LANGUAGE_KEY));
});

test('the config directory key is not among the keys that re-plan alerts', () => {
    assert.ok(!KEYS.includes(CONFIG_DIR_KEY));
});

test('the login is read from the default directory unless the key says otherwise', () => {
    const xml = readFileSync(new URL('../schemas/org.gnome.shell.extensions.claude-quota.gschema.xml',
        import.meta.url), 'utf8');
    assert.match(xml, new RegExp(`<key name="${CONFIG_DIR_KEY}" type="s">\\s*<default>''</default>`));
});

test('the language follows the system unless the key says otherwise', () => {
    const xml = readFileSync(new URL('../schemas/org.gnome.shell.extensions.claude-quota.gschema.xml',
        import.meta.url), 'utf8');
    assert.match(xml, new RegExp(`<key name="${LANGUAGE_KEY}" type="s">\\s*<default>''</default>`));
});

test('the account and plan keys are off in the committed schema', () => {
    const xml = readFileSync(new URL('../schemas/org.gnome.shell.extensions.claude-quota.gschema.xml',
        import.meta.url), 'utf8');
    [ACCOUNT_KEY, PLAN_KEY].forEach(key => {
        assert.match(xml, new RegExp(`<key name="${key}" type="b">\\s*<default>false</default>`));
    });
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
