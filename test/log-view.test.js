import assert from 'node:assert/strict';
import {test} from 'node:test';

import {formatDetail, formatRow, refusalRuns, selectRecords, summarize} from '../tools/lib/log-view.js';

function record(ts, overrides = {}) {
    return {
        ts,
        trigger: 'timer',
        endpoint: 'usage',
        outcome: 'ok',
        status: 200,
        retryAfter: null,
        durationMs: 275,
        tokenExpiresAt: null,
        tokenExpired: false,
        headers: {},
        body: null,
        ...overrides,
    };
}

const morning = [
    record('2026-08-13T07:12:39.000Z', {outcome: 'unauthorized', status: 401, trigger: 'startup'}),
    record('2026-08-13T07:17:40.000Z', {outcome: 'unauthorized', status: 401}),
    record('2026-08-13T07:22:40.000Z', {outcome: 'unauthorized', status: 401}),
    record('2026-08-13T07:27:39.000Z', {outcome: 'rate-limited', status: 429, retryAfter: 3600}),
];

test('records before the requested instant are dropped', () => {
    const kept = selectRecords(morning, {since: '2026-08-13T07:20'});
    assert.deepEqual(kept.map(one => one.ts.slice(11, 16)), ['07:22', '07:27']);
});

test('an upper bound is inclusive of its own instant', () => {
    const kept = selectRecords(morning, {since: '', until: '2026-08-13T07:17:40.000Z'});
    assert.equal(kept.length, 2);
});

test('filtering by outcome keeps only that outcome', () => {
    assert.equal(selectRecords(morning, {outcome: 'rate-limited'}).length, 1);
    assert.equal(selectRecords(morning, {outcome: 'ok'}).length, 0);
});

test('filtering by endpoint treats a record written before endpoints existed as usage', () => {
    const legacy = [record('2026-08-11T10:00:00.000Z', {endpoint: undefined})];
    assert.equal(selectRecords(legacy, {endpoint: 'usage'}).length, 1);
    assert.equal(selectRecords(legacy, {endpoint: 'status'}).length, 0);
});

test('a tail keeps the newest records, not the oldest', () => {
    assert.deepEqual(selectRecords(morning, {tail: 2}).map(one => one.status), [401, 429]);
});

test('no filters keeps everything', () => {
    assert.equal(selectRecords(morning).length, 4);
});

test('the summary counts each outcome', () => {
    assert.deepEqual(summarize(morning), {total: 4, byOutcome: {unauthorized: 3, 'rate-limited': 1}});
});

test('the summary of an empty selection is empty rather than absent', () => {
    assert.deepEqual(summarize([]), {total: 0, byOutcome: {}});
});

test('consecutive equal outcomes collapse into one run carrying its span', () => {
    const runs = refusalRuns(morning);
    assert.deepEqual(runs.map(run => [run.outcome, run.count]), [['unauthorized', 3], ['rate-limited', 1]]);
    assert.equal(runs[0].from, '2026-08-13T07:12:39.000Z');
    assert.equal(runs[0].to, '2026-08-13T07:22:40.000Z');
});

test('an outcome returning after an interruption starts a new run', () => {
    const runs = refusalRuns([
        record('2026-08-13T07:00:00.000Z', {outcome: 'ok'}),
        record('2026-08-13T07:05:00.000Z', {outcome: 'rate-limited'}),
        record('2026-08-13T07:10:00.000Z', {outcome: 'ok'}),
    ]);
    assert.deepEqual(runs.map(run => run.outcome), ['ok', 'rate-limited', 'ok']);
});

test('a row names the outcome, the status and the retry-after it was given', () => {
    const row = formatRow(morning[3], 'UTC');
    assert.match(row, /^07:27:39 /);
    assert.match(row, /rate-limited/);
    assert.match(row, /429/);
    assert.match(row, /ra=3600/);
});

test('a row says plainly when the token was already expired', () => {
    const row = formatRow(record('2026-08-13T09:00:00.000Z', {
        outcome: 'token-expired', status: null, durationMs: null, tokenExpired: true,
    }), 'UTC');
    assert.match(row, /token=expired/);
    assert.match(row, /token-expired/);
});

test('a row reports the expiry a valid token carried', () => {
    const row = formatRow(record('2026-08-13T09:00:00.000Z', {
        tokenExpiresAt: '2026-08-13T16:06:11.791Z',
    }), 'UTC');
    assert.match(row, /token=valid until 2026-08-13T16:06:11\.791Z/);
});

test('a record written before a field existed renders a dash, not undefined', () => {
    const row = formatRow({ts: '2026-08-11T10:00:00.000Z', trigger: 'timer', outcome: 'ok', status: 200}, 'UTC');
    assert.equal(row.includes('undefined'), false);
    assert.match(row, / - +- *$/);
});

test('a row renders in the requested zone, not in UTC', () => {
    assert.match(formatRow(morning[0], 'Europe/Paris'), /^09:12:39 /);
});

test('the detail lines carry the response headers and the error body', () => {
    const detail = formatDetail(record('2026-08-13T07:27:39.000Z', {
        headers: {'retry-after': '3600', 'request-id': 'req_123'},
        body: '{"error":{"type":"rate_limit_error"}}',
    }));
    assert.deepEqual(detail, [
        '      retry-after: 3600',
        '      request-id: req_123',
        '      body: {"error":{"type":"rate_limit_error"}}',
    ]);
});

test('a record with nothing to detail produces no lines', () => {
    assert.deepEqual(formatDetail(record('2026-08-13T07:00:00.000Z')), []);
});
