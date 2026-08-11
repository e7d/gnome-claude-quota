import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const LIB = fileURLToPath(new URL('../tools/lib/assert.sh', import.meta.url));

function run(script) {
    try {
        const stdout = execFileSync('bash', ['-c', `set -euo pipefail\n. "${LIB}"\n${script}`], {encoding: 'utf8'});
        return {status: 0, stdout};
    } catch (error) {
        return {status: error.status, stdout: error.stdout ?? ''};
    }
}

test('a passing assertion is counted and reported', () => {
    const {status, stdout} = run('assert_eq label one one\nassert_summary');
    assert.equal(status, 0);
    assert.match(stdout, /^ok label$/m);
    assert.match(stdout, /1 passed, 0 failed/);
});

test('a failing assertion reports both values and fails the summary', () => {
    const {status, stdout} = run('assert_eq label one two\nassert_summary');
    assert.equal(status, 1);
    assert.match(stdout, /FAIL label: expected 'one', got 'two'/);
    assert.match(stdout, /0 passed, 1 failed/);
});

test('an assertion never returns non-zero, so set -e cannot abort the run', () => {
    const {status, stdout} = run('assert_eq first one two\nassert_eq second three three\nassert_summary');
    assert.equal(status, 1);
    assert.match(stdout, /^ok second$/m);
});

test('assert_not_empty rejects the empty string', () => {
    const {status, stdout} = run("assert_not_empty label ''\nassert_summary");
    assert.equal(status, 1);
    assert.match(stdout, /FAIL label: expected a value, got ''/);
});

test('prove accepts an assertion that fails under its break', () => {
    const script = `
        BROKEN=0
        check() { [ "$BROKEN" -eq 0 ] && assert_eq check ok ok || assert_eq check ok broken; }
        prove check 'BROKEN=1' 'BROKEN=0' check
        assert_summary`;
    const {status, stdout} = run(script);
    assert.equal(status, 0);
    assert.match(stdout, /^prove check$/m);
});

test('prove leaves the tally untouched', () => {
    const script = `
        BROKEN=0
        check() { [ "$BROKEN" -eq 0 ] && assert_eq check ok ok || assert_eq check ok broken; }
        prove check 'BROKEN=1' 'BROKEN=0' check
        assert_summary`;
    const {stdout} = run(script);
    assert.match(stdout, /0 passed, 0 failed/);
});

test('prove aborts on an assertion that cannot fail', () => {
    const script = `
        check() { assert_eq check ok ok; }
        prove check 'true' 'true' check
        echo unreachable`;
    const {status, stdout} = run(script);
    assert.equal(status, 1);
    assert.doesNotMatch(stdout, /unreachable/);
});

test('prove aborts when the restore does not take', () => {
    const script = `
        BROKEN=0
        check() { [ "$BROKEN" -eq 0 ] && assert_eq check ok ok || assert_eq check ok broken; }
        prove check 'BROKEN=1' 'true' check
        echo unreachable`;
    const {status, stdout} = run(script);
    assert.equal(status, 1);
    assert.doesNotMatch(stdout, /unreachable/);
});
