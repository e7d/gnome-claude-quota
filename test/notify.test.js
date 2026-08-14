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
