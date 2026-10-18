import assert from 'node:assert/strict';
import {test} from 'node:test';

import {planName} from '../lib/plan.js';

test('the plans Claude Code reports get their product names', () => {
    assert.equal(planName({type: 'claude_pro', tier: 'default_claude_ai'}), 'Pro');
    assert.equal(planName({type: 'claude_team', tier: null}), 'Team');
    assert.equal(planName({type: 'claude_enterprise', tier: null}), 'Enterprise');
    assert.equal(planName({type: 'claude_free', tier: null}), 'Free');
});

test('a max plan carries its multiple from the rate-limit tier', () => {
    assert.equal(planName({type: 'claude_max', tier: 'default_claude_max_5x'}), 'Max 5x');
    assert.equal(planName({type: 'claude_max', tier: 'default_claude_max_20x'}), 'Max 20x');
});

test('a max plan with no readable multiple is still Max', () => {
    assert.equal(planName({type: 'claude_max', tier: null}), 'Max');
    assert.equal(planName({type: 'claude_max', tier: 'default_claude_ai'}), 'Max');
    assert.equal(planName({type: 'claude_max', tier: 5}), 'Max');
});

test('the pro plan ignores a multiple it has no use for', () => {
    assert.equal(planName({type: 'claude_pro', tier: 'default_claude_max_5x'}), 'Pro');
});

test('a plan this table has not met is humanized rather than hidden', () => {
    assert.equal(planName({type: 'claude_max_plus', tier: null}), 'Max Plus');
    assert.equal(planName({type: 'claude_foo_bar', tier: null}), 'Foo Bar');
    assert.equal(planName({type: 'student', tier: null}), 'Student');
});

test('a name that is a prototype key is not mistaken for a known plan', () => {
    assert.equal(planName({type: 'claude_constructor', tier: null}), 'Constructor');
});

test('anything that is not a plan name yields none', () => {
    assert.equal(planName({type: undefined, tier: null}), null);
    assert.equal(planName({type: null, tier: null}), null);
    assert.equal(planName({type: 42, tier: null}), null);
    assert.equal(planName({type: '', tier: null}), null);
    assert.equal(planName({type: 'claude_', tier: null}), null);
    assert.equal(planName({type: '___', tier: null}), null);
});
