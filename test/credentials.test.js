import assert from 'node:assert/strict';
import {test} from 'node:test';

import {EXPIRY_SKEW_SECONDS, credentialsRenewed, parseCredentials, tokenExpired} from '../lib/credentials.js';

const now = new Date('2026-08-13T09:12:39.000Z');

function file(oauth) {
    return JSON.stringify({claudeAiOauth: oauth});
}

test('a well-formed file yields the token and its expiry instant', () => {
    const parsed = parseCredentials(file({accessToken: 'token-value', expiresAt: 1786637171791}));
    assert.equal(parsed.token, 'token-value');
    assert.equal(parsed.expiresAt.toISOString(), '2026-08-13T16:06:11.791Z');
});

test('a file with no usable token yields null rather than a partial record', () => {
    assert.equal(parseCredentials(file({expiresAt: 1786637171791})), null);
    assert.equal(parseCredentials(file({accessToken: ''})), null);
    assert.equal(parseCredentials(file({accessToken: 42})), null);
    assert.equal(parseCredentials('{}'), null);
    assert.equal(parseCredentials('not json'), null);
    assert.equal(parseCredentials(''), null);
});

test('a token with no stated expiry parses, and is never called expired', () => {
    const parsed = parseCredentials(file({accessToken: 'token-value'}));
    assert.equal(parsed.expiresAt, null);
    assert.equal(tokenExpired(parsed.expiresAt, now), false);
});

test('a token past its expiry is expired', () => {
    assert.equal(tokenExpired(new Date('2026-08-13T09:00:00Z'), now), true);
});

test('a token still valid beyond the skew is not expired', () => {
    assert.equal(tokenExpired(new Date('2026-08-13T16:06:11Z'), now), false);
});

test('a token expiring inside the skew is treated as already expired', () => {
    const edge = new Date(now.getTime() + (EXPIRY_SKEW_SECONDS - 1) * 1000);
    assert.equal(tokenExpired(edge, now), true);
    assert.equal(tokenExpired(new Date(now.getTime() + (EXPIRY_SKEW_SECONDS + 1) * 1000), now), false);
});

test('an unparseable expiry is never called expired', () => {
    assert.equal(tokenExpired(new Date('nonsense'), now), false);
    assert.equal(tokenExpired(null, now), false);
    assert.equal(tokenExpired(undefined, now), false);
});

test('a later expiry means the token was renewed', () => {
    const seen = new Date('2026-08-13T09:00:00Z');
    assert.equal(credentialsRenewed(seen, new Date('2026-08-13T16:06:11Z')), true);
});

test('the same or an older expiry is not a renewal', () => {
    const seen = new Date('2026-08-13T16:06:11Z');
    assert.equal(credentialsRenewed(seen, seen), false);
    assert.equal(credentialsRenewed(seen, new Date('2026-08-13T09:00:00Z')), false);
});

test('a first sighting of a dated token is a renewal', () => {
    assert.equal(credentialsRenewed(null, new Date('2026-08-13T16:06:11Z')), true);
});

test('a write that leaves no readable expiry is not a renewal', () => {
    assert.equal(credentialsRenewed(new Date('2026-08-13T09:00:00Z'), null), false);
    assert.equal(credentialsRenewed(null, null), false);
});
