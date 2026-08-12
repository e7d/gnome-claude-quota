import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {claudeCodeStatus, quotas} from '../lib/model.js';

const now = new Date('2026-08-10T08:49:59.966Z');
const zeroScopedNow = new Date('2026-08-04T07:51:00Z');

function payload() {
    return JSON.parse(readFileSync(new URL('./fixtures/usage.json', import.meta.url), 'utf8'));
}

function zeroScopedPayload() {
    return JSON.parse(readFileSync(new URL('./fixtures/usage-zero-scoped.json', import.meta.url), 'utf8'));
}

function statusPayload() {
    return JSON.parse(readFileSync(new URL('./fixtures/status.json', import.meta.url), 'utf8'));
}

test('claudeCodeStatus reads the Claude Code component, not the page-wide indicator', () => {
    assert.equal(claudeCodeStatus(statusPayload()), 'degraded_performance');
});

test('claudeCodeStatus ignores a sibling component in a worse state', () => {
    const page = statusPayload();
    assert.equal(page.components.find(entry => entry.id === 'k8w3r06qmzrp').status, 'major_outage');
    assert.equal(claudeCodeStatus(page), 'degraded_performance');
});

test('claudeCodeStatus returns null when the component is absent', () => {
    const page = statusPayload();
    page.components = page.components.filter(entry => entry.id !== 'yyzkbfz2thpt');
    assert.equal(claudeCodeStatus(page), null);
});

test('claudeCodeStatus returns null for a malformed or empty payload', () => {
    assert.equal(claudeCodeStatus(null), null);
    assert.equal(claudeCodeStatus({}), null);
    assert.equal(claudeCodeStatus({components: 'nope'}), null);
    assert.equal(claudeCodeStatus({components: [{id: 'yyzkbfz2thpt'}]}), null);
});

test('every populated limit renders, named after its kind or its model', () => {
    assert.deepEqual(quotas(payload(), now).map(quota => quota.name), ['Session (5h)', 'Weekly', 'Fable']);
});

test('session and weekly always render, a scoped quota at zero does not', () => {
    const names = quotas(zeroScopedPayload(), zeroScopedNow).map(quota => quota.name);
    assert.deepEqual(names, ['Session (5h)', 'Weekly']);
});

test('the session entry carries every field the UI needs', () => {
    const [session] = quotas(payload(), now);
    assert.equal(session.short, 'S');
    assert.equal(session.percent, 7);
    assert.equal(session.severity, 'normal');
    assert.equal(session.resetsAt.toISOString(), '2026-08-10T12:49:59.966Z');
    assert.equal(Math.round(session.windowProgress * 100), 20);
});

test('a scoped quota renders once it is above zero, named after its model', () => {
    const scoped = quotas(payload(), now).at(-1);
    assert.equal(scoped.name, 'Fable');
    assert.equal(scoped.short, 'F');
    assert.equal(scoped.percent, 1);
    assert.equal(Math.round(scoped.windowProgress * 100), 29);
});

test('only model-scoped quotas are flagged as such', () => {
    const [session, weekly, scoped] = quotas(payload(), now);
    assert.equal(session.modelScoped, false);
    assert.equal(weekly.modelScoped, false);
    assert.equal(scoped.modelScoped, true);
});

test('a scoped short label takes a second lowercase letter when it would collide', () => {
    const data = payload();
    data.limits[2].scope.model.display_name = 'Sonnet';
    const [session, weekly, scoped] = quotas(data, now);
    assert.equal(scoped.short, 'So');
    assert.equal(session.short, 'S');
    assert.equal(weekly.short, 'W');
});

test('a quota without a reset time has no window progress', () => {
    const data = zeroScopedPayload();
    data.limits[2].percent = 12;
    assert.equal(quotas(data, zeroScopedNow).at(-1).resetsAt, null);
    assert.equal(quotas(data, zeroScopedNow).at(-1).windowProgress, null);
});

test('a quota spending in step with its window is not ahead of pace', () => {
    const [session] = quotas(payload(), now);
    assert.equal(session.aheadOfPace, false);
});

test('a quota is ahead of pace only once it passes the window by more than the margin', () => {
    const behind = payload();
    behind.limits[0].percent = 29;
    assert.equal(quotas(behind, now)[0].aheadOfPace, false);
    const ahead = payload();
    ahead.limits[0].percent = 31;
    assert.equal(quotas(ahead, now)[0].aheadOfPace, true);
});

test('a quota without a reset time is never ahead of pace', () => {
    const data = zeroScopedPayload();
    data.limits[2].percent = 99;
    assert.equal(quotas(data, zeroScopedNow).at(-1).aheadOfPace, false);
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

test('limits present but not an array yields no quotas rather than throwing', () => {
    assert.deepEqual(quotas({limits: {}}, now), []);
});

test('a blank display_name does not produce an empty short', () => {
    const data = payload();
    data.limits[2].scope.model.display_name = '';
    const scoped = quotas(data, now).at(-1);
    assert.notEqual(scoped.short, '');
});

test('a percent above 100 passes through unclamped', () => {
    const data = payload();
    data.limits[0].percent = 101;
    assert.equal(quotas(data, now)[0].percent, 101);
});

test('a scoped quota named after a single reserved letter does not collapse into it', () => {
    const data = payload();
    data.limits[2].scope.model.display_name = 'S';
    const [session, , scoped] = quotas(data, now);
    assert.equal(session.short, 'S');
    assert.notEqual(scoped.short, 'S');
});

test('two scoped quotas sharing an initial each get a distinct short', () => {
    const data = payload();
    data.limits[2].scope.model.display_name = 'Opus';
    data.limits.push({
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 8,
        severity: 'normal',
        resets_at: null,
        scope: {model: {id: null, display_name: 'Owl'}, surface: null},
        is_active: false,
    });
    const [, , first, second] = quotas(data, now);
    assert.equal(first.name, 'Opus');
    assert.equal(second.name, 'Owl');
    assert.notEqual(first.short, second.short);
});
