import assert from 'node:assert/strict';
import {test} from 'node:test';

import {DEFAULT_WINDOW_MINUTES, hourlyRows, verdict} from '../tools/attribution.js';

function attempt(ts, overrides = {}) {
    return {ts, trigger: 'timer', outcome: 'ok', status: 200, retryAfter: null, rateLimitHeaders: {}, ...overrides};
}

function limited(ts, headers = {}) {
    return attempt(ts, {outcome: 'rate-limited', status: 429, retryAfter: 119, rateLimitHeaders: headers});
}

function at(hour, minute = 0) {
    return `2026-08-11T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

function ms(hour, minute = 0) {
    return Date.parse(at(hour, minute));
}

test('the default correlation window is ten minutes either side', () => {
    assert.equal(DEFAULT_WINDOW_MINUTES, 10);
});

test('an empty log verdicts as no data rather than as no problem', () => {
    const answer = verdict({attempts: [], sessionStarts: [ms(9)]});
    assert.equal(answer.label, 'no-data');
    assert.match(answer.text, /no data yet/);
});

test('attempts with no 429 refuse to attribute rather than clearing the extension', () => {
    const answer = verdict({attempts: [attempt(at(9)), attempt(at(10))], sessionStarts: [ms(9)]});
    assert.equal(answer.label, 'no-429');
    assert.match(answer.text, /cannot attribute/);
    assert.equal(answer.text.includes('all clear'), false);
});

test('rate-limit headers on a 429 answer the question directly', () => {
    const headers = {
        'anthropic-ratelimit-requests-remaining': '0',
        'anthropic-ratelimit-requests-reset': '2026-08-11T12:00:00Z',
    };
    const answer = verdict({attempts: [attempt(at(9)), limited(at(10), headers)], sessionStarts: []});
    assert.equal(answer.label, 'rate-limit-headers');
    assert.deepEqual(answer.headers, headers);
});

test('429s clustered around session starts are attributed to Claude Code', () => {
    const answer = verdict({
        attempts: [limited(at(9, 3)), limited(at(11, 58)), limited(at(14, 5)), attempt(at(15))],
        sessionStarts: [ms(9), ms(12), ms(14)],
    });
    assert.equal(answer.label, 'sessions');
    assert.match(answer.text, /Claude Code/);
    assert.equal(answer.correlated, 3);
    assert.equal(answer.fraction, 1);
});

test('429s in every polling hour with no session nearby point at our own cadence', () => {
    const answer = verdict({
        attempts: [limited(at(9)), limited(at(10)), limited(at(11)), limited(at(12))],
        sessionStarts: [ms(3)],
    });
    assert.equal(answer.label, 'own-cadence');
    assert.match(answer.text, /own cadence/);
    assert.equal(answer.correlated, 0);
});

test('429s neither clustered nor spread are left unattributed', () => {
    const answer = verdict({
        attempts: [attempt(at(9)), attempt(at(10)), attempt(at(11)), limited(at(12)), attempt(at(13)), attempt(at(14))],
        sessionStarts: [ms(3)],
    });
    assert.equal(answer.label, 'unattributed');
    assert.match(answer.text, /another device/);
});

test('the window and the cluster fraction are reported alongside the label', () => {
    const answer = verdict({
        attempts: [limited(at(9, 3)), limited(at(10, 40))],
        sessionStarts: [ms(9)],
        windowMinutes: 5,
    });
    assert.equal(answer.windowMinutes, 5);
    assert.equal(answer.rateLimited, 2);
    assert.equal(answer.correlated, 1);
    assert.equal(answer.fraction, 0.5);
});

test('a narrower window excludes a 429 the default window would have caught', () => {
    const attempts = [limited(at(9, 8))];
    assert.equal(verdict({attempts, sessionStarts: [ms(9)]}).correlated, 1);
    assert.equal(verdict({attempts, sessionStarts: [ms(9)], windowMinutes: 5}).correlated, 0);
});

test('the correlation window reaches either side of a session start', () => {
    assert.equal(verdict({attempts: [limited(at(8, 55))], sessionStarts: [ms(9)]}).correlated, 1);
    assert.equal(verdict({attempts: [limited(at(9, 5))], sessionStarts: [ms(9)]}).correlated, 1);
});

test('hourly rows count attempts, 429s and session starts per hour', () => {
    const rows = hourlyRows(
        [attempt(at(9, 1)), limited(at(9, 31)), attempt(at(11, 2))],
        [ms(9, 5), ms(9, 50), ms(10)]);
    assert.deepEqual(rows, [
        {hour: '2026-08-11T09', attempts: 2, rateLimited: 1, sessions: 2},
        {hour: '2026-08-11T10', attempts: 0, rateLimited: 0, sessions: 1},
        {hour: '2026-08-11T11', attempts: 1, rateLimited: 0, sessions: 0},
    ]);
});

test('hourly rows are empty when neither source has anything', () => {
    assert.deepEqual(hourlyRows([], []), []);
});

test('a record with an unparseable timestamp is left out rather than bucketed as epoch', () => {
    const rows = hourlyRows([attempt('whenever'), attempt(at(9))], []);
    assert.deepEqual(rows.map(row => row.hour), ['2026-08-11T09']);
    assert.equal(verdict({attempts: [limited('whenever')], sessionStarts: []}).rateLimited, 0);
});
