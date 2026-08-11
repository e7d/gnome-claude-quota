import assert from 'node:assert/strict';
import {test} from 'node:test';

import {MAX_RECORDS, appendRecord, attemptRecord, outcomeFor, parseLog} from '../lib/attempts.js';

const now = new Date('2026-08-11T11:55:12.482Z');

function ok(overrides = {}) {
    return attemptRecord({now, trigger: 'timer', outcome: 'ok', status: 200, retryAfter: null, headers: {}, ...overrides});
}

test('a record carries exactly the six documented fields', () => {
    assert.deepEqual(Object.keys(ok()), ['ts', 'trigger', 'outcome', 'status', 'retryAfter', 'rateLimitHeaders']);
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

test('only anthropic-ratelimit headers are kept, and their names are lowercased', () => {
    const record = ok({
        headers: {
            'Anthropic-RateLimit-Requests-Remaining': '0',
            'anthropic-ratelimit-requests-reset': '2026-08-11T12:00:00Z',
            'content-type': 'application/json',
            'request-id': 'req_123',
        },
    });
    assert.deepEqual(record.rateLimitHeaders, {
        'anthropic-ratelimit-requests-remaining': '0',
        'anthropic-ratelimit-requests-reset': '2026-08-11T12:00:00Z',
    });
});

test('a response with no rate-limit headers records an empty object', () => {
    assert.deepEqual(ok({headers: {'content-type': 'application/json'}}).rateLimitHeaders, {});
    assert.deepEqual(ok({headers: undefined}).rateLimitHeaders, {});
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
