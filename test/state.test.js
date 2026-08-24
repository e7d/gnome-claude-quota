import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {adoptShared, applyResult} from '../lib/state.js';

const NOW = new Date('2026-08-14T12:00:00Z');

function state(overrides = {}) {
    return {
        limits: [],
        quotas: [],
        error: null,
        service: null,
        block: null,
        fetchedAt: null,
        seenExpiry: null,
        rateLimitStreak: 0,
        ...overrides,
    };
}

function ok(overrides = {}) {
    return {
        error: null,
        payload: {limits: [{type: 'five_hour', utilization: 40}]},
        expiresAt: null,
        desc: null,
        retryAfter: null,
        rateLimited: false,
        serverError: false,
        expired: false,
        ...overrides,
    };
}

test('applyResult on success clears the error, the block and the streak', () => {
    const {state: next, effects} = applyResult({
        state: state({error: 'boom', block: {until: NOW, reason: 'rate-limit'}, rateLimitStreak: 3}),
        result: ok(),
        now: NOW,
    });
    assert.equal(next.error, null);
    assert.equal(next.block, null);
    assert.equal(next.rateLimitStreak, 0);
    assert.deepEqual(next.fetchedAt, NOW);
    assert.equal(effects.save, true);
    assert.equal(effects.syncAlerts, true);
});

test('applyResult on success falls back to no limits when the payload carries none', () => {
    const {state: next} = applyResult({state: state(), result: ok({payload: {}}), now: NOW});
    assert.deepEqual(next.limits, []);
});

test('applyResult on success keeps the previous expiry when the result carries none', () => {
    const seen = new Date('2026-08-14T18:00:00Z');
    const {state: next} = applyResult({state: state({seenExpiry: seen}), result: ok(), now: NOW});
    assert.deepEqual(next.seenExpiry, seen);
});

test('applyResult on success adopts a new expiry when the result carries one', () => {
    const fresh = new Date('2026-08-15T00:00:00Z');
    const {state: next} = applyResult({
        state: state({seenExpiry: NOW}), result: ok({expiresAt: fresh}), now: NOW});
    assert.deepEqual(next.seenExpiry, fresh);
});

test('applyResult on a rate limit sets a block, advances the streak and shows no error', () => {
    const {state: next, effects} = applyResult({
        state: state(),
        result: ok({error: 'rate limited', payload: null, rateLimited: true, retryAfter: 60,
            desc: 'slow down'}),
        now: NOW,
    });
    assert.notEqual(next.block, null);
    assert.equal(next.rateLimitStreak, 1);
    assert.equal(next.error, null);
    assert.ok(effects.schedule > 0);
    assert.equal(effects.save, false);
});

test('applyResult on a repeated rate limit backs off further than the first', () => {
    const once = applyResult({
        state: state(),
        result: ok({error: 'rate limited', payload: null, rateLimited: true, retryAfter: null}),
        now: NOW,
    });
    const twice = applyResult({
        state: state({rateLimitStreak: 3}),
        result: ok({error: 'rate limited', payload: null, rateLimited: true, retryAfter: null}),
        now: NOW,
    });
    assert.ok(twice.effects.schedule > once.effects.schedule);
});

test('applyResult on an unauthorized refusal blocks and keeps the description as the error', () => {
    const {state: next, effects} = applyResult({
        state: state(),
        result: ok({error: 'nope', payload: null, status: 401, desc: 'Reauthenticate'}),
        now: NOW,
    });
    assert.notEqual(next.block, null);
    assert.equal(next.rateLimitStreak, 1);
    assert.equal(next.error, 'Reauthenticate');
    assert.ok(effects.schedule > 0);
    assert.equal(effects.save, false);
});

test('applyResult on a plain failure keeps the description and clears any block', () => {
    const {state: next} = applyResult({
        state: state({block: {until: NOW, reason: 'rate-limit'}}),
        result: ok({error: 'nope', payload: null, desc: 'Network unreachable'}),
        now: NOW,
    });
    assert.equal(next.block, null);
    assert.equal(next.error, 'Network unreachable');
    assert.equal(next.service, null);
});

test('applyResult invents no service status from a server error', () => {
    const {state: next} = applyResult({
        state: state(),
        result: ok({error: 'nope', payload: null, desc: 'Server error', serverError: true}),
        now: NOW,
    });
    assert.equal(next.service, null);
});

const DEGRADED = {status: 'partial_outage', until: null};

test('applyResult keeps a known service issue through a successful poll', () => {
    const {state: next} = applyResult({
        state: state({service: DEGRADED}),
        result: ok(),
        now: NOW,
    });
    assert.deepEqual(next.service, DEGRADED);
});

test('applyResult keeps a known service issue through a plain failure', () => {
    const {state: next} = applyResult({
        state: state({service: DEGRADED}),
        result: ok({error: 'nope', payload: null, desc: 'Network unreachable'}),
        now: NOW,
    });
    assert.deepEqual(next.service, DEGRADED);
});

test('applyResult keeps a known service issue through a rate-limit block', () => {
    const {state: next} = applyResult({
        state: state({service: DEGRADED}),
        result: ok({error: 'nope', payload: null, desc: 'Rate limited', rateLimited: true, retryAfter: 300}),
        now: NOW,
    });
    assert.deepEqual(next.service, DEGRADED);
});

test('applyResult prefers a known service issue over the unknown placeholder', () => {
    const {state: next} = applyResult({
        state: state({service: DEGRADED}),
        result: ok({error: 'nope', payload: null, desc: 'Server error', serverError: true}),
        now: NOW,
    });
    assert.deepEqual(next.service, DEGRADED);
});

test('adoptShared keeps a known service issue', () => {
    const fresher = new Date('2026-08-14T12:05:00Z');
    const {state: next} = adoptShared({
        state: state({fetchedAt: NOW, service: DEGRADED}),
        shared: {limits: [], fetchedAt: fresher},
        now: NOW,
    });
    assert.deepEqual(next.service, DEGRADED);
});

test('adoptShared declines a payload that is not fresher than ours', () => {
    const result = adoptShared({
        state: state({fetchedAt: NOW}),
        shared: {limits: [], fetchedAt: new Date('2026-08-14T11:00:00Z')},
        now: NOW,
    });
    assert.equal(result, null);
});

test('adoptShared takes a fresher payload and asks for a save and an alert sync', () => {
    const fresher = new Date('2026-08-14T12:05:00Z');
    const {state: next, effects} = adoptShared({
        state: state({fetchedAt: NOW, error: 'boom'}),
        shared: {limits: [{type: 'five_hour', utilization: 10}], fetchedAt: fresher},
        now: NOW,
    });
    assert.deepEqual(next.fetchedAt, fresher);
    assert.equal(next.error, null);
    assert.equal(next.service, null);
    assert.equal(effects.save, true);
    assert.equal(effects.syncAlerts, true);
});
