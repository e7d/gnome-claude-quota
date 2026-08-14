import assert from 'node:assert/strict';
import {test} from 'node:test';

import {NOTIFY_DEFAULTS, alertPlan, alertRefresh, refreshDelayMs, thresholdsFrom} from '../lib/notify.js';

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
    assert.equal(result.post[0].body, '');
});

test('a percentage that is not a number withdraws its alert and holds nothing', () => {
    const fired = {'session|warning': {window: resetsAt.toISOString()}};
    const result = plan([quota({percent: NaN})], fired);
    assert.deepEqual(result.withdraw, ['session|warning']);
    assert.deepEqual(result.post, []);
    assert.deepEqual(result.fired, {});
});

test('an entry whose quota left the payload is withdrawn and forgotten', () => {
    const fired = {
        'session|warning': {window: resetsAt.toISOString()},
        'weekly_scoped:opus|critical': {window: resetsAt.toISOString()},
    };
    const result = plan([quota({percent: 80})], fired);
    assert.deepEqual(result.withdraw, ['weekly_scoped:opus|critical']);
    assert.deepEqual(result.post, []);
    assert.deepEqual(Object.keys(result.fired), ['session|warning']);
});

test('an empty quota list is unknown data, not an empty payload, and prunes nothing', () => {
    const fired = {'session|warning': {window: resetsAt.toISOString()}};
    const result = plan([], fired);
    assert.deepEqual(result.withdraw, []);
    assert.deepEqual(result.fired, fired);
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

// The window is held still across all four steps on purpose: every rule this exercises
// is about a quota that moved, and a changing resetsAt would re-arm each level for the
// unrelated reason that the window rolled.
test('the full arc 0 to warning to critical and back leaves nothing behind', () => {
    const quiet = plan([quota({percent: 0})]);
    assert.deepEqual(quiet.post, []);
    assert.deepEqual(quiet.fired, {});
    const warned = plan([quota({percent: 78})], quiet.fired);
    assert.deepEqual(warned.post.map(alert => alert.key), ['session|warning']);
    assert.deepEqual(Object.keys(warned.fired), ['session|warning']);
    const alarmed = plan([quota({percent: 96})], warned.fired);
    assert.deepEqual(alarmed.post.map(alert => alert.key), ['session|critical']);
    assert.deepEqual(alarmed.withdraw, ['session|warning']);
    assert.deepEqual(Object.keys(alarmed.fired).toSorted(), ['session|critical', 'session|warning']);
    const recovered = plan([quota({percent: 0})], alarmed.fired);
    assert.deepEqual(recovered.post, []);
    assert.deepEqual(recovered.withdraw.toSorted(), ['session|critical', 'session|warning']);
    assert.deepEqual(recovered.fired, {});
});

test('the arc re-arms, so a second climb in the same window fires again', () => {
    const climbed = plan([quota({percent: 96})]);
    const dropped = plan([quota({percent: 0})], climbed.fired);
    const again = plan([quota({percent: 78})], dropped.fired);
    assert.deepEqual(again.post.map(alert => alert.key), ['session|warning']);
});

test('the refresh delay lands just past the next minute boundary', () => {
    assert.equal(refreshDelayMs(new Date('2026-08-14T09:00:00.000Z')), 60_250);
    assert.equal(refreshDelayMs(new Date('2026-08-14T09:00:30.000Z')), 30_250);
    assert.equal(refreshDelayMs(new Date('2026-08-14T09:00:59.900Z')), 350);
});

test('the refresh delay never lands before a boundary, whatever the offset', () => {
    for (let ms = 0; ms < 60_000; ms += 137) {
        const at = new Date(Date.UTC(2026, 7, 14, 9, 0, 0) + ms);
        const landing = new Date(at.getTime() + refreshDelayMs(at));
        assert.equal(landing.getUTCSeconds(), 0);
        assert.ok(landing.getTime() > at.getTime());
    }
});

function refresh(quotas, fired, at = now) {
    return alertRefresh({quotas, fired, now: at, locale: 'en-US', percentLocale: 'en-US'});
}

test('a refresh re-words what is on record and proposes nothing new', () => {
    const fired = {'session|warning': {window: resetsAt.toISOString()}};
    const later = new Date('2026-08-14T10:00:00Z');
    const [alert] = refresh([quota({percent: 80})], fired, later);
    assert.deepEqual(Object.keys(alert).toSorted(), ['body', 'key', 'title']);
    assert.equal(alert.key, 'session|warning');
    assert.match(alert.title, /80\s*%/);
    assert.equal(alert.body, '1h 30m left · 11:30 AM');
});

test('a refresh follows the clock, which is the whole point of it', () => {
    const fired = {'session|warning': {window: resetsAt.toISOString()}};
    const [early] = refresh([quota({percent: 80})], fired);
    const [late] = refresh([quota({percent: 80})], fired, new Date('2026-08-14T11:00:00Z'));
    assert.equal(early.body, '2h 30m left · 11:30 AM');
    assert.equal(late.body, '30m left · 11:30 AM');
});

test('a refresh covers a level only while it is on record', () => {
    assert.deepEqual(refresh([quota({percent: 96})], {}), []);
    const both = {
        'session|warning': {window: resetsAt.toISOString()},
        'session|critical': {window: resetsAt.toISOString()},
    };
    assert.deepEqual(refresh([quota({percent: 96})], both).map(alert => alert.key),
        ['session|warning', 'session|critical']);
});

test('a refresh ignores a record whose quota is gone', () => {
    const fired = {'weekly_scoped:Opus|critical': {window: resetsAt.toISOString()}};
    assert.deepEqual(refresh([quota({percent: 80})], fired), []);
});

test('settings values become the threshold list alertPlan takes', () => {
    assert.deepEqual(thresholdsFrom({
        warning: {percent: 70, notify: true},
        critical: {percent: 95, notify: false},
    }), [
        {level: 'warning', percent: 70, enabled: true},
        {level: 'critical', percent: 95, enabled: false},
    ]);
});
