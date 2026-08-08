import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    OPEN_REFRESH_SECONDS,
    POLL_SECONDS,
    SERVICE_ERROR,
    blockedUntil,
    isBlocked,
    markExpired,
    nextPollSeconds,
    serviceIssue,
    shouldFetchOnOpen,
} from '../lib/policy.js';

const now = new Date('2026-08-04T07:51:00Z');

test('nextPollSeconds falls back to the steady-state interval without a retry-after', () => {
    assert.equal(nextPollSeconds(null), POLL_SECONDS);
    assert.equal(nextPollSeconds(undefined), POLL_SECONDS);
    assert.equal(nextPollSeconds(0), POLL_SECONDS);
});

test('nextPollSeconds keeps the steady-state interval when the retry-after is smaller', () => {
    assert.equal(nextPollSeconds(30), POLL_SECONDS);
});

test('nextPollSeconds adds a five-second margin past a retry-after larger than the interval', () => {
    assert.equal(nextPollSeconds(400), 405);
});

test('nextPollSeconds rounds a fractional retry-after up before adding the margin', () => {
    assert.equal(nextPollSeconds(400.2), 406);
});

test('blockedUntil returns null without a retry-after', () => {
    assert.equal(blockedUntil(null, now), null);
    assert.equal(blockedUntil(0, now), null);
});

test('blockedUntil lands five seconds past the retry-after, rounded up', () => {
    const until = blockedUntil(119, now);
    assert.equal(until.toISOString(), '2026-08-04T07:53:04.000Z');
});

test('isBlocked is true strictly before the blocked-until time', () => {
    const until = new Date('2026-08-04T07:53:00Z');
    assert.equal(isBlocked(until, new Date('2026-08-04T07:52:59Z')), true);
});

test('isBlocked is false at and past the blocked-until time', () => {
    const until = new Date('2026-08-04T07:53:00Z');
    assert.equal(isBlocked(until, until), false);
    assert.equal(isBlocked(until, new Date('2026-08-04T07:53:01Z')), false);
});

test('isBlocked is false without a blocked-until time', () => {
    assert.equal(isBlocked(null, now), false);
});

test('shouldFetchOnOpen fetches when there is no prior fetch', () => {
    assert.equal(shouldFetchOnOpen(null, now, null), true);
});

test('shouldFetchOnOpen skips a fetch still within the open-refresh window', () => {
    const fetchedAt = new Date(now.getTime() - (OPEN_REFRESH_SECONDS - 1) * 1000);
    assert.equal(shouldFetchOnOpen(fetchedAt, now, null), false);
});

test('shouldFetchOnOpen fetches once the data is older than the open-refresh window', () => {
    const fetchedAt = new Date(now.getTime() - (OPEN_REFRESH_SECONDS + 1) * 1000);
    assert.equal(shouldFetchOnOpen(fetchedAt, now, null), true);
});

test('shouldFetchOnOpen refuses while blocked, even with stale data', () => {
    const fetchedAt = new Date(now.getTime() - (OPEN_REFRESH_SECONDS + 1) * 1000);
    const until = new Date(now.getTime() + 60_000);
    assert.equal(shouldFetchOnOpen(fetchedAt, now, until), false);
});

test('serviceIssue reports nothing without a service status', () => {
    assert.equal(serviceIssue(null), null);
    assert.equal(serviceIssue(undefined), null);
});

test('serviceIssue maps each status the status page publishes', () => {
    assert.deepEqual(serviceIssue('degraded_performance'), {emoji: '🐢', text: 'Degraded performance'});
    assert.deepEqual(serviceIssue('partial_outage'), {emoji: '⚠️', text: 'Partial outage'});
    assert.deepEqual(serviceIssue('major_outage'), {emoji: '🔴', text: 'Major outage'});
    assert.deepEqual(serviceIssue('under_maintenance'), {emoji: '🚧', text: 'Under maintenance'});
});

test('serviceIssue keeps the warning glyph in emoji presentation', () => {
    const points = [...serviceIssue('partial_outage').emoji].map(char => char.codePointAt(0));
    assert.deepEqual(points, [0x26A0, 0xFE0F]);
});

test('serviceIssue falls back to the generic error when the page reads operational', () => {
    assert.deepEqual(serviceIssue('operational'), SERVICE_ERROR);
});

test('serviceIssue falls back to the generic error for an unknown status', () => {
    assert.deepEqual(serviceIssue('unknown'), SERVICE_ERROR);
    assert.deepEqual(serviceIssue('some_future_status'), SERVICE_ERROR);
});

test('markExpired flags a quota whose reset time has passed', () => {
    const quotas = [{name: 'Session', resetsAt: new Date('2026-08-04T07:00:00Z')}];
    const result = markExpired(quotas, now);
    assert.equal(result[0].expired, true);
});

test('markExpired flags a quota resetting exactly now', () => {
    const quotas = [{name: 'Session', resetsAt: now}];
    const result = markExpired(quotas, now);
    assert.equal(result[0].expired, true);
});

test('markExpired leaves a future reset unflagged', () => {
    const quotas = [{name: 'Weekly', resetsAt: new Date('2026-08-08T07:59:00Z')}];
    const result = markExpired(quotas, now);
    assert.equal(result[0].expired, false);
});

test('markExpired never flags a quota without a reset time', () => {
    const quotas = [{name: 'Scoped', resetsAt: null}];
    const result = markExpired(quotas, now);
    assert.equal(result[0].expired, false);
});

test('markExpired does not mutate the input array or its entries', () => {
    const quotas = [{name: 'Session', resetsAt: new Date('2026-08-04T07:00:00Z')}];
    const result = markExpired(quotas, now);
    assert.notEqual(result, quotas);
    assert.notEqual(result[0], quotas[0]);
    assert.equal(quotas[0].expired, undefined);
});
