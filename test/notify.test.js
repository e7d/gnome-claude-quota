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

test('the returned bookkeeping never aliases the caller\'s entries', () => {
    const fired = {'session|warning': {window: resetsAt.toISOString()}};
    const result = plan([quota({percent: 80})], fired);
    assert.deepEqual(result.fired, fired);
    assert.notEqual(result.fired['session|warning'], fired['session|warning']);
});

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
    assert.deepEqual(Object.keys(result.fired).toSorted(), ['session|critical', 'session|warning']);
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

test('a warning cannot post beside a critical that fired in an earlier pass', () => {
    const inverted = {warning: {percent: 90}, critical: {percent: 50}};
    const first = plan([quota({percent: 60})], {}, inverted);
    assert.deepEqual(first.post.map(alert => alert.key), ['session|critical']);
    const result = plan([quota({percent: 95})], first.fired, inverted);
    assert.deepEqual(result.post, []);
    assert.deepEqual(result.withdraw, ['session|warning']);
});
