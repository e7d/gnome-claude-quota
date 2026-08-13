import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {resetTranslator, setTranslator} from '../lib/i18n.js';
import {claudeCodeService, quotas} from '../lib/model.js';

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

const statusNow = new Date('2026-08-13T12:00:00Z');

function maintenance(overrides = {}) {
    return {
        status: 'in_progress',
        scheduled_for: '2026-08-13T11:30:00.000Z',
        scheduled_until: '2026-08-13T14:30:00.000Z',
        components: [{id: 'yyzkbfz2thpt', name: 'Claude Code'}],
        ...overrides,
    };
}

function maintaining(windows) {
    return {...statusPayload(), scheduled_maintenances: windows};
}

test('claudeCodeService reads the Claude Code component, not the page-wide indicator', () => {
    assert.equal(claudeCodeService(statusPayload(), statusNow).status, 'degraded_performance');
});

test('claudeCodeService ignores a sibling component in a worse state', () => {
    const page = statusPayload();
    assert.equal(page.components.find(entry => entry.id === 'k8w3r06qmzrp').status, 'major_outage');
    assert.equal(claudeCodeService(page, statusNow).status, 'degraded_performance');
});

test('claudeCodeService reports no status when the component is absent', () => {
    const page = statusPayload();
    page.components = page.components.filter(entry => entry.id !== 'yyzkbfz2thpt');
    assert.equal(claudeCodeService(page, statusNow).status, null);
});

test('claudeCodeService reports no status for a malformed or empty payload', () => {
    assert.deepEqual(claudeCodeService(null, statusNow), {status: null, until: null});
    assert.deepEqual(claudeCodeService({}, statusNow), {status: null, until: null});
    assert.deepEqual(claudeCodeService({components: 'nope'}, statusNow), {status: null, until: null});
    assert.equal(claudeCodeService({components: [{id: 'yyzkbfz2thpt'}]}, statusNow).status, null);
});

test('a maintenance window underway on Claude Code carries its end', () => {
    const service = claudeCodeService(maintaining([maintenance()]), statusNow);
    assert.deepEqual(service.until, new Date('2026-08-13T14:30:00.000Z'));
});

test('a window being verified is still underway', () => {
    const service = claudeCodeService(maintaining([maintenance({status: 'verifying'})]), statusNow);
    assert.deepEqual(service.until, new Date('2026-08-13T14:30:00.000Z'));
});

test('a window not yet started or already completed carries no end', () => {
    for (const status of ['scheduled', 'completed']) {
        const service = claudeCodeService(maintaining([maintenance({status})]), statusNow);
        assert.equal(service.until, null, status);
    }
});

test('a window that has overrun its estimate carries no end', () => {
    const overrun = maintenance({scheduled_until: '2026-08-13T11:45:00.000Z'});
    assert.equal(claudeCodeService(maintaining([overrun]), statusNow).until, null);
});

test('a window on another component carries no end', () => {
    const elsewhere = maintenance({components: [{id: 'rwppv331jlwc', name: 'claude.ai'}]});
    assert.equal(claudeCodeService(maintaining([elsewhere]), statusNow).until, null);
});

test('overlapping windows are over when the last of them ends', () => {
    const windows = [
        maintenance({scheduled_until: '2026-08-13T13:00:00.000Z'}),
        maintenance({scheduled_until: '2026-08-13T16:00:00.000Z'}),
    ];
    assert.deepEqual(claudeCodeService(maintaining(windows), statusNow).until,
        new Date('2026-08-13T16:00:00.000Z'));
});

test('a window with an unparseable or missing end carries no end', () => {
    assert.equal(claudeCodeService(maintaining([maintenance({scheduled_until: 'soon'})]), statusNow).until, null);
    assert.equal(claudeCodeService(maintaining([maintenance({scheduled_until: null})]), statusNow).until, null);
    assert.equal(claudeCodeService({scheduled_maintenances: 'nope'}, statusNow).until, null);
});

test('a degraded component with no maintenance window carries no end', () => {
    assert.equal(claudeCodeService(statusPayload(), statusNow).until, null);
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

test('quota names and panel initials come from the catalog', () => {
    setTranslator({
        gettext: msgid => ({'Weekly': 'Hebdomadaire', 'Session (5h)': 'Session (5 h)'})[msgid] ?? msgid,
        ngettext: (msgid, plural, count) => (count > 1 ? plural : msgid),
        pgettext: (context, msgid) => ({W: 'H'})[msgid] ?? msgid,
    });
    const result = quotas({limits: [
        {kind: 'session', group: 'session', percent: 20, resets_at: '2026-08-04T12:00:00Z'},
        {kind: 'weekly_all', group: 'weekly', percent: 40, resets_at: '2026-08-08T12:00:00Z'},
    ]}, new Date('2026-08-04T08:00:00Z'));
    assert.deepEqual(result.map(quota => [quota.short, quota.name]),
        [['S', 'Session (5 h)'], ['H', 'Hebdomadaire']]);
    assert.equal(result[1].modelScoped, false);
    resetTranslator();
});
