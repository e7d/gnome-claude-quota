import assert from 'node:assert/strict';
import {test} from 'node:test';

import {MAX_BODY_CHARS, MAX_RECORDS, appendRecord, attemptRecord, outcomeFor, parseLog} from '../lib/attempts.js';

const now = new Date('2026-08-11T11:55:12.482Z');

function ok(overrides = {}) {
    return attemptRecord({now, trigger: 'timer', outcome: 'ok', status: 200, retryAfter: null, headers: {}, ...overrides});
}

test('a record carries exactly the eleven documented fields', () => {
    assert.deepEqual(Object.keys(ok()), [
        'ts', 'trigger', 'endpoint', 'outcome', 'status', 'retryAfter', 'durationMs',
        'tokenExpiresAt', 'tokenExpired', 'headers', 'body',
    ]);
});

test('the endpoint the attempt went to is recorded', () => {
    assert.equal(ok({endpoint: 'usage'}).endpoint, 'usage');
    assert.equal(ok().endpoint, null);
});

test('the round trip is recorded in milliseconds, or null when it never left', () => {
    assert.equal(ok({durationMs: 275}).durationMs, 275);
    assert.equal(ok({durationMs: undefined}).durationMs, null);
});

test('the token expiry known at request time is recorded, never the token', () => {
    const record = ok({tokenExpiresAt: new Date('2026-08-13T16:06:11.791Z'), tokenExpired: false});
    assert.equal(record.tokenExpiresAt, '2026-08-13T16:06:11.791Z');
    assert.equal(record.tokenExpired, false);
    assert.equal(ok().tokenExpiresAt, null);
    assert.equal(ok({tokenExpiresAt: new Date('nonsense')}).tokenExpiresAt, null);
});

test('a failing response keeps its body, so the reason survives the session', () => {
    const body = '{"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}';
    assert.equal(attemptRecord({now, trigger: 'timer', outcome: 'rate-limited', status: 429, body}).body, body);
});

test('the body of a successful call is dropped, since the cache already holds it', () => {
    assert.equal(ok({body: '{"five_hour":{"utilization":7.0}}'}).body, null);
});

test('an overlong body is truncated rather than allowed to crowd out older records', () => {
    const record = attemptRecord({now, trigger: 'timer', outcome: 'error', body: 'x'.repeat(MAX_BODY_CHARS + 50)});
    assert.equal(record.body.length, MAX_BODY_CHARS + 1);
    assert.equal(record.body.endsWith('…'), true);
});

test('a missing body records null rather than an empty string', () => {
    assert.equal(attemptRecord({now, trigger: 'timer', outcome: 'error'}).body, null);
    assert.equal(attemptRecord({now, trigger: 'timer', outcome: 'error', body: ''}).body, null);
});

test('the timestamp is the ISO 8601 instant of the attempt', () => {
    assert.equal(ok().ts, '2026-08-11T11:55:12.482Z');
});

test('a rate-limited attempt keeps its status and retry-after', () => {
    const record = attemptRecord({
        now, trigger: 'manual', outcome: 'rate-limited', status: 429, retryAfter: 37, headers: {},
    });
    assert.equal(record.outcome, 'rate-limited');
    assert.equal(record.status, 429);
    assert.equal(record.retryAfter, 37);
});

test('a transport failure records a null status rather than a number', () => {
    assert.equal(attemptRecord({now, trigger: 'timer', outcome: 'error', status: undefined}).status, null);
    assert.equal(attemptRecord({now, trigger: 'timer', outcome: 'error', status: NaN}).status, null);
});

test('a missing retry-after records null rather than NaN', () => {
    assert.equal(attemptRecord({now, trigger: 'timer', outcome: 'error', retryAfter: NaN}).retryAfter, null);
    assert.equal(attemptRecord({now, trigger: 'timer', outcome: 'error'}).retryAfter, null);
});

test('the headers that explain a refusal are kept, and their names are lowercased', () => {
    const record = ok({
        headers: {
            'Anthropic-RateLimit-Requests-Remaining': '0',
            'anthropic-ratelimit-requests-reset': '2026-08-11T12:00:00Z',
            'Retry-After': '3600',
            'request-id': 'req_123',
        },
    });
    assert.deepEqual(record.headers, {
        'anthropic-ratelimit-requests-remaining': '0',
        'anthropic-ratelimit-requests-reset': '2026-08-11T12:00:00Z',
        'request-id': 'req_123',
        'retry-after': '3600',
    });
});

test('a header outside the allowlist is dropped', () => {
    assert.deepEqual(ok({headers: {'cf-ray': 'a2a654a54e0f00ca-CDG', 'x-frame-options': 'SAMEORIGIN'}}).headers, {});
    assert.deepEqual(ok({headers: undefined}).headers, {});
});

test('a record built from a response carrying credentials contains no part of them', () => {
    const token = 'sk-ant-oat01-EXAMPLETOKENVALUE';
    const record = ok({
        headers: {
            'Authorization': `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'set-cookie': `session=${token}`,
        },
    });
    const text = JSON.stringify(record);
    assert.equal(text.includes(token), false);
    assert.equal(text.includes('Bearer'), false);
    assert.equal(text.includes('sk-ant'), false);
    assert.equal(text.includes('authorization'), false);
});

test('outcomeFor reads the outcome off a fetch result', () => {
    assert.equal(outcomeFor({error: null, rateLimited: false, status: 200}), 'ok');
    assert.equal(outcomeFor({error: 'Rate limited', rateLimited: true, status: 429}), 'rate-limited');
    assert.equal(outcomeFor({error: 'Token expired', rateLimited: false, status: 401}), 'unauthorized');
    assert.equal(outcomeFor({error: 'Token expired', rateLimited: false, status: null, expired: true}), 'token-expired');
    assert.equal(outcomeFor({error: 'Cannot reach api.anthropic.com', rateLimited: false, status: null}), 'error');
    assert.equal(outcomeFor({error: 'Usage request failed (HTTP 503)', rateLimited: false, status: 503}), 'error');
});

test('appending writes one line of JSON per record', () => {
    const text = appendRecord(appendRecord('', ok()), ok({trigger: 'manual'}));
    assert.equal(text.split('\n').filter(Boolean).length, 2);
    assert.equal(text.endsWith('\n'), true);
    assert.deepEqual(parseLog(text).map(record => record.trigger), ['timer', 'manual']);
});

test('a log one record under the cap is left untouched', () => {
    const text = Array.from({length: MAX_RECORDS - 1}, (_, index) => JSON.stringify(ok({status: index}))).join('\n') + '\n';
    const appended = appendRecord(text, ok({status: 999}));
    assert.equal(appended.startsWith(text), true);
    assert.equal(parseLog(appended).length, MAX_RECORDS);
});

test('appending at the cap drops the oldest record and keeps the newest', () => {
    const text = Array.from({length: MAX_RECORDS}, (_, index) => JSON.stringify(ok({status: index}))).join('\n') + '\n';
    const records = parseLog(appendRecord(text, ok({status: 999})));
    assert.equal(records.length, MAX_RECORDS);
    assert.equal(records[0].status, 1);
    assert.equal(records.at(-1).status, 999);
});

test('appending drops a trailing partial line rather than gluing onto it', () => {
    const whole = JSON.stringify(ok({status: 200}));
    const records = parseLog(appendRecord(`${whole}\n{"ts":"2026-08-11T11:5`, ok({status: 429})));
    assert.deepEqual(records.map(record => record.status), [200, 429]);
});

test('parseLog skips a corrupt line and keeps the rest', () => {
    const text = `${JSON.stringify(ok({status: 200}))}\nnot json\n${JSON.stringify(ok({status: 429}))}\n`;
    assert.deepEqual(parseLog(text).map(record => record.status), [200, 429]);
});

test('parseLog skips a line that parses but is not a record', () => {
    assert.deepEqual(parseLog('null\n[]\n"text"\n42\n{}\n'), []);
});

test('parseLog returns an empty array for an empty or missing log', () => {
    assert.deepEqual(parseLog(''), []);
    assert.deepEqual(parseLog(null), []);
    assert.deepEqual(parseLog(undefined), []);
});
