import assert from 'node:assert/strict';
import {test} from 'node:test';

import {deserialize, serialize} from '../lib/cache.js';

const fetchedAt = new Date('2026-08-04T12:05:26Z');
const limits = [
    {kind: 'session', group: 'session', percent: 4, severity: 'normal', resets_at: '2026-08-04T14:59:59Z', scope: null},
    {kind: 'weekly_all', group: 'weekly', percent: 44, severity: 'normal', resets_at: '2026-08-08T07:59:59Z', scope: null},
];

test('a round trip preserves the limits and the timestamp', () => {
    const restored = deserialize(serialize(limits, fetchedAt));
    assert.deepEqual(restored.limits, limits);
    assert.equal(restored.fetchedAt.toISOString(), fetchedAt.toISOString());
});

test('deserialize rejects an empty payload', () => {
    assert.equal(deserialize(''), null);
    assert.equal(deserialize(null), null);
    assert.equal(deserialize(undefined), null);
});

test('deserialize rejects malformed JSON', () => {
    assert.equal(deserialize('{not valid json'), null);
});

test('deserialize rejects a version it does not know', () => {
    assert.equal(deserialize(JSON.stringify({version: 3, fetchedAt: fetchedAt.toISOString(), limits})), null);
    assert.equal(deserialize(JSON.stringify({fetchedAt: fetchedAt.toISOString(), limits})), null);
});

test('a round trip preserves the alert bookkeeping', () => {
    const fired = {'session|warning': {window: '2026-08-04T14:59:59.000Z'}};
    assert.deepEqual(deserialize(serialize(limits, fetchedAt, fired)).fired, fired);
});

test('a version 1 file is read as legacy with no alerts fired', () => {
    const legacy = JSON.stringify({version: 1, fetchedAt: fetchedAt.toISOString(), limits});
    const restored = deserialize(legacy);
    assert.deepEqual(restored.limits, limits);
    assert.deepEqual(restored.fired, {});
});

test('a fired entry that is not an object carrying a window is dropped', () => {
    const hostile = JSON.stringify({
        version: 2,
        fetchedAt: fetchedAt.toISOString(),
        limits,
        fired: {
            'session|warning': null,
            'session|critical': {window: 42},
            'weekly_all|warning': 'nope',
            'weekly_all|critical': {window: '2026-08-04T14:59:59.000Z'},
        },
    });
    assert.deepEqual(Object.keys(deserialize(hostile).fired), ['weekly_all|critical']);
});

test('deserialize rejects limits that are missing or not an array', () => {
    assert.equal(deserialize(JSON.stringify({version: 1, fetchedAt: fetchedAt.toISOString()})), null);
    assert.equal(deserialize(JSON.stringify({version: 1, fetchedAt: fetchedAt.toISOString(), limits: {}})), null);
});

test('deserialize rejects an unparseable timestamp', () => {
    assert.equal(deserialize(JSON.stringify({version: 1, fetchedAt: 'whenever', limits})), null);
});

test('deserialize never throws on hostile input', () => {
    for (const input of ['', '[]', 'null', '0', '"text"', '{"version":1}', '{"version":1,"limits":[],"fetchedAt":{}}'])
        assert.doesNotThrow(() => deserialize(input));
});

test('serialize writes only the limits, never the rest of the payload', () => {
    const text = serialize(limits, fetchedAt);
    assert.equal(text.includes('spend'), false);
    assert.equal(text.includes('extra_usage'), false);
    assert.deepEqual(Object.keys(JSON.parse(text)).toSorted(), ['fetchedAt', 'fired', 'limits', 'version']);
});
