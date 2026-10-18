import assert from 'node:assert/strict';
import {test} from 'node:test';

import {fresherThan, parseAccountEmail, parseAccountPlan, parseSharedUsage} from '../lib/shared-usage.js';

const ACCOUNT = '3e1c3aca-0000-4000-8000-000000000000';
const LIMITS = [
    {kind: 'session', group: 'session', percent: 23, severity: 'normal', resets_at: '2026-08-13T13:00:00Z', scope: null},
    {kind: 'weekly_all', group: 'weekly', percent: 66, severity: 'normal', resets_at: '2026-08-15T08:00:00Z', scope: null},
];

function file(overrides = {}) {
    return JSON.stringify({
        oauthAccount: {accountUuid: ACCOUNT},
        cachedUsageUtilization: {
            accountUuid: ACCOUNT,
            fetchedAtMs: 1786613226000,
            utilization: {limits: LIMITS},
            ...overrides,
        },
    });
}

test('a well-formed block yields its limits and the instant it was fetched', () => {
    const shared = parseSharedUsage(file());
    assert.equal(shared.fetchedAt.toISOString(), '2026-08-13T09:27:06.000Z');
    assert.deepEqual(shared.limits, LIMITS);
});

test('the limits are passed through untouched, since both sides carry one shape', () => {
    assert.equal(parseSharedUsage(file()).limits[0].kind, 'session');
    assert.equal(parseSharedUsage(file()).limits[0].percent, 23);
});

test('a block belonging to another account is refused', () => {
    const other = JSON.stringify({
        oauthAccount: {accountUuid: ACCOUNT},
        cachedUsageUtilization: {
            accountUuid: '00000000-0000-4000-8000-000000000000',
            fetchedAtMs: 1786613226000,
            utilization: {limits: LIMITS},
        },
    });
    assert.equal(parseSharedUsage(other), null);
});

test('a block with no account to check against is refused', () => {
    assert.equal(parseSharedUsage(JSON.stringify({
        cachedUsageUtilization: {fetchedAtMs: 1786613226000, utilization: {limits: LIMITS}},
    })), null);
    assert.equal(parseSharedUsage(file({accountUuid: ''})), null);
    assert.equal(parseSharedUsage(file({accountUuid: null})), null);
});

test('a block with no usable timestamp is refused, since freshness is the whole test', () => {
    assert.equal(parseSharedUsage(file({fetchedAtMs: null})), null);
    assert.equal(parseSharedUsage(file({fetchedAtMs: 'yesterday'})), null);
    assert.equal(parseSharedUsage(file({fetchedAtMs: undefined})), null);
});

test('a block with no limits is refused rather than rendered empty', () => {
    assert.equal(parseSharedUsage(file({utilization: {limits: []}})), null);
    assert.equal(parseSharedUsage(file({utilization: {limits: null}})), null);
    assert.equal(parseSharedUsage(file({utilization: {}})), null);
    assert.equal(parseSharedUsage(file({utilization: null})), null);
});

test('a file with no block at all is refused', () => {
    assert.equal(parseSharedUsage('{"oauthAccount":{"accountUuid":"x"}}'), null);
    assert.equal(parseSharedUsage('{}'), null);
    assert.equal(parseSharedUsage('not json'), null);
    assert.equal(parseSharedUsage(''), null);
});

test('a later block is fresher than what we hold', () => {
    const shared = {fetchedAt: new Date('2026-08-13T09:27:06Z'), limits: LIMITS};
    assert.equal(fresherThan(shared, new Date('2026-08-13T09:00:00Z')), true);
});

test('an older or equal block is not adopted, so the panel never goes backwards', () => {
    const shared = {fetchedAt: new Date('2026-08-13T09:27:06Z'), limits: LIMITS};
    assert.equal(fresherThan(shared, new Date('2026-08-13T09:27:06Z')), false);
    assert.equal(fresherThan(shared, new Date('2026-08-13T10:00:00Z')), false);
});

test('any block beats holding nothing', () => {
    const shared = {fetchedAt: new Date('2026-08-13T09:27:06Z'), limits: LIMITS};
    assert.equal(fresherThan(shared, null), true);
    assert.equal(fresherThan(shared, new Date('nonsense')), true);
});

test('an unreadable block is never fresher than anything', () => {
    assert.equal(fresherThan(null, null), false);
    assert.equal(fresherThan(null, new Date('2026-08-13T09:00:00Z')), false);
});

test('the plan is read from the logged-in account', () => {
    const text = JSON.stringify({oauthAccount: {
        organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x'}});
    assert.equal(parseAccountPlan(text), 'Max 5x');
});

test('the plan is found even when the usage block is foreign', () => {
    const text = JSON.stringify({
        oauthAccount: {accountUuid: ACCOUNT, organizationType: 'claude_pro'},
        cachedUsageUtilization: {accountUuid: 'someone-else'},
    });
    assert.equal(parseAccountPlan(text), 'Pro');
    assert.equal(parseSharedUsage(text), null);
});

test('a file with no plan yields none', () => {
    assert.equal(parseAccountPlan(JSON.stringify({oauthAccount: {}})), null);
    assert.equal(parseAccountPlan(JSON.stringify({oauthAccount: {organizationType: null}})), null);
    assert.equal(parseAccountPlan('{}'), null);
    assert.equal(parseAccountPlan('not json'), null);
});

test('the account email is read from the logged-in account', () => {
    const text = JSON.stringify({oauthAccount: {accountUuid: ACCOUNT, emailAddress: 'jane.doe@example.org'}});
    assert.equal(parseAccountEmail(text), 'jane.doe@example.org');
});

test('the account email is found even when the usage block is foreign', () => {
    const text = JSON.stringify({
        oauthAccount: {accountUuid: ACCOUNT, emailAddress: 'jane.doe@example.org'},
        cachedUsageUtilization: {accountUuid: 'someone-else'},
    });
    assert.equal(parseAccountEmail(text), 'jane.doe@example.org');
    assert.equal(parseSharedUsage(text), null);
});

test('surrounding whitespace is dropped from the account email', () => {
    const text = JSON.stringify({oauthAccount: {emailAddress: '  jane@example.org\n'}});
    assert.equal(parseAccountEmail(text), 'jane@example.org');
});

test('anything that is not a single address yields no email', () => {
    const cases = [
        {oauthAccount: {}},
        {oauthAccount: {emailAddress: null}},
        {oauthAccount: {emailAddress: 42}},
        {oauthAccount: {emailAddress: ''}},
        {oauthAccount: {emailAddress: 'no-at-sign'}},
        {oauthAccount: {emailAddress: 'two words@example.org'}},
        {oauthAccount: {emailAddress: 'a@b@example.org'}},
        {},
    ];
    cases.forEach(data => assert.equal(parseAccountEmail(JSON.stringify(data)), null, JSON.stringify(data)));
    assert.equal(parseAccountEmail('not json'), null);
});
