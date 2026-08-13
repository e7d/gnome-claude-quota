import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    OPEN_REFRESH_SECONDS,
    POLL_SECONDS,
    RATE_LIMIT_CAP_SECONDS,
    RATE_LIMIT_FLOOR_SECONDS,
    MIN_REQUEST_SECONDS,
    RATE_LIMIT,
    SERVICE_ERROR,
    UNAUTHORIZED,
    blockReason,
    isBlocked,
    minIntervalWait,
    rateLimitBlock,
    markExpired,
    nextPollSeconds,
    serviceIssue,
    shouldFetchOnOpen,
    throttledUntil,
} from '../lib/policy.js';

const now = new Date('2026-08-04T07:51:00Z');

test('the first request of a session waits for nothing', () => {
    assert.equal(minIntervalWait(null, now), 0);
    assert.equal(minIntervalWait(undefined, now), 0);
    assert.equal(minIntervalWait(new Date('nonsense'), now), 0);
});

test('a request inside the minimum interval waits out its remainder', () => {
    assert.equal(minIntervalWait(new Date(now.getTime() - 30_000), now), MIN_REQUEST_SECONDS - 30);
    assert.equal(minIntervalWait(now, now), MIN_REQUEST_SECONDS);
});

test('a remainder is rounded up, so the wait never lands a second early', () => {
    assert.equal(minIntervalWait(new Date(now.getTime() - 30_500), now), MIN_REQUEST_SECONDS - 30);
});

test('a request past the minimum interval waits for nothing', () => {
    assert.equal(minIntervalWait(new Date(now.getTime() - MIN_REQUEST_SECONDS * 1000), now), 0);
    assert.equal(minIntervalWait(new Date(now.getTime() - 3_600_000), now), 0);
});

test('the interval leaves room for the other tenant of a five-per-five-minutes allowance', () => {
    assert.equal(300 / MIN_REQUEST_SECONDS < 5, true);
});

test('a refusal from the server arms a block whichever refusal it was', () => {
    assert.equal(blockReason({rateLimited: true, status: 429}), RATE_LIMIT);
    assert.equal(blockReason({rateLimited: false, status: 401}), UNAUTHORIZED);
});

test('declining to send on a token we know is expired arms no block', () => {
    assert.equal(blockReason({rateLimited: false, expired: true, status: null}), null);
});

test('an ordinary failure arms no block', () => {
    assert.equal(blockReason({rateLimited: false, status: 503}), null);
    assert.equal(blockReason({rateLimited: false, status: null}), null);
});

test('only a rate limit may claim the throttle line', () => {
    const until = new Date('2026-08-04T08:51:00Z');
    assert.equal(throttledUntil({until, reason: RATE_LIMIT}), until);
    assert.equal(throttledUntil({until, reason: UNAUTHORIZED}), null);
    assert.equal(throttledUntil(null), null);
    assert.equal(throttledUntil(undefined), null);
});

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

test('rateLimitBlock lands five seconds past a usable retry-after, rounded up', () => {
    const {until, seconds} = rateLimitBlock(119, now, 0);
    assert.equal(seconds, 124);
    assert.equal(until.toISOString(), '2026-08-04T07:53:04.000Z');
});

// The endpoint answers 429 with retry-after: 0 and no rate-limit headers, which
// read as "no hint" and armed no block at all, so every popup open and timer tick
// earned another refusal.
test('rateLimitBlock still blocks when the server offers no usable retry-after', () => {
    for (const hint of [null, undefined, 0, -1, Number.NaN]) {
        const {seconds} = rateLimitBlock(hint, now, 0);
        assert.equal(seconds, RATE_LIMIT_FLOOR_SECONDS, `hint ${hint}`);
    }
});

test('rateLimitBlock doubles the floor for each consecutive refusal', () => {
    assert.equal(rateLimitBlock(0, now, 1).seconds, RATE_LIMIT_FLOOR_SECONDS * 2);
    assert.equal(rateLimitBlock(0, now, 2).seconds, RATE_LIMIT_FLOOR_SECONDS * 4);
});

test('rateLimitBlock caps the exponential growth', () => {
    assert.equal(rateLimitBlock(0, now, 99).seconds, RATE_LIMIT_CAP_SECONDS);
});

test('rateLimitBlock honours a retry-after longer than the cap', () => {
    assert.equal(rateLimitBlock(3600, now, 0).seconds, 3605);
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
