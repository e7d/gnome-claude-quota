import assert from 'node:assert/strict';
import {test} from 'node:test';

import {buildReport, parseShard, problemsOf, summarizeShards} from '../tools/lib/ci-report.js';

const GOOD = '✅ ok dark-normal rows filled\n✅ 700 passed, 0 failed\n';
const BAD = '❌ FAIL dark-normal rows filled: expected true\n❌ 699 passed, 1 failed\n';
const CRASHED = 'prove rows filled\n❌ control status row highlights: failed before the break was applied\n';
const GREEN = {lint: {result: 'success'}, test: {result: 'success'}};

test('a shard that ends on a passing summary is ok and counted', () => {
    assert.deepEqual(parseShard(GOOD), {status: 'ok', passed: 700, failed: 0, aborts: []});
});

test('a shard that ends on a failing summary is failed, with what failed named', () => {
    const shard = parseShard(BAD);
    assert.equal(shard.status, 'failed');
    assert.equal(shard.failed, 1);
    assert.deepEqual(shard.aborts, ['❌ FAIL dark-normal rows filled: expected true']);
});

test('a shard that never printed a summary is not a pass, and says which control aborted', () => {
    const shard = parseShard(CRASHED);
    assert.equal(shard.status, 'no-summary');
    assert.equal(shard.passed, 0);
    assert.deepEqual(shard.aborts, ['❌ control status row highlights: failed before the break was applied']);
});

test('an empty log is a shard with no summary', () => {
    assert.equal(parseShard('').status, 'no-summary');
});

test('the last summary line wins over an earlier one', () => {
    assert.equal(parseShard('✅ 1 passed, 0 failed\n❌ 5 passed, 2 failed\n').failed, 2);
});

test('windows line endings do not hide the summary', () => {
    assert.equal(parseShard('✅ 3 passed, 0 failed\r\n').status, 'ok');
});

test('only the first few aborts are kept', () => {
    const log = Array.from({length: 9}, (_, n) => `❌ FAIL case ${n}`).join('\n');
    assert.equal(parseShard(log).aborts.length, 5);
});

test('shards are totalled and listed in name order', () => {
    const summary = summarizeShards([
        {name: 'state-light', text: GOOD},
        {name: 'behaviour', text: '✅ 60 passed, 0 failed'},
    ]);
    assert.deepEqual(summary.rows.map(row => row.name), ['behaviour', 'state-light']);
    assert.equal(summary.passed, 760);
    assert.equal(summary.failed, 0);
});

test('no problems when every job succeeded and every shard is ok', () => {
    assert.deepEqual(problemsOf(summarizeShards([{name: 'a', text: GOOD}]), GREEN), []);
});

test('a job that did not succeed is a problem, skipped included', () => {
    const needs = {...GREEN, a11y: {result: 'skipped'}, coverage: {result: 'failure'}};
    assert.deepEqual(problemsOf(summarizeShards([{name: 'a', text: GOOD}]), needs),
        ['job a11y: skipped', 'job coverage: failure']);
});

test('no report at all is a problem rather than an empty pass', () => {
    assert.deepEqual(problemsOf(summarizeShards([]), GREEN), ['no e2e report was found']);
});

test('a crashed shard is a problem even when every job reported success', () => {
    assert.deepEqual(problemsOf(summarizeShards([{name: 'b', text: CRASHED}]), GREEN),
        ['e2e shard b: no-summary']);
});

test('a clean run renders its totals and is ok', () => {
    const report = buildReport({shards: [{name: 'a', text: GOOD}], needs: GREEN});
    assert.equal(report.ok, true);
    assert.match(report.markdown, /\| \*\*total\*\* \| \| 700 \| 0 \|/);
    assert.doesNotMatch(report.markdown, /## problems/);
});

test('a broken run renders what broke and is not ok', () => {
    const report = buildReport({
        shards: [{name: 'a', text: GOOD}, {name: 'b', text: CRASHED}],
        needs: {...GREEN, e2e: {result: 'failure'}},
    });
    assert.equal(report.ok, false);
    assert.match(report.markdown, /## aborts/);
    assert.match(report.markdown, /- b: ❌ control status row highlights/);
    assert.match(report.markdown, /- job e2e: failure/);
    assert.match(report.markdown, /- e2e shard b: no-summary/);
});

test('the negative control: a report fed nothing but failures is never ok', () => {
    assert.equal(buildReport({shards: [], needs: {}}).ok, false);
});
