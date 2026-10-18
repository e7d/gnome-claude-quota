import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const GITHUB = read('../.github/workflows/ci.yml');
const FORGEJO = read('../.forgejo/workflows/ci.yml');

const FORK = /forgejo\/(upload|download)-artifact@[0-9a-f]{40} # v[\d.]+/g;
const OFFICIAL = /actions\/(upload|download)-artifact@[0-9a-f]{40} # v[\d.]+/g;
const LEADING_COMMENT = /^(?:#[^\n]*\n)+/;

const withoutNote = text => text.replace(LEADING_COMMENT, '');
const neutral = (text, pattern) => text.replace(pattern, (_, kind) => `ARTIFACT-${kind}`);
const forgejoShape = text => neutral(withoutNote(text), FORK);
const githubShape = text => neutral(text, OFFICIAL);

test('the two workflows differ only by their artifact actions', () => {
    assert.equal(forgejoShape(FORGEJO), githubShape(GITHUB));
});

test('the comparison can fail: one extra step on the Forgejo side is a difference', () => {
    const drifted = FORGEJO.replace('      - name: cleanup', '      - name: extra\n        run: true\n      - name: cleanup');
    assert.notEqual(drifted, FORGEJO);
    assert.notEqual(forgejoShape(drifted), githubShape(GITHUB));
});

test('the Forgejo workflow uses the Forgejo forks and no official artifact action', () => {
    assert.equal(FORGEJO.match(FORK).length, 3);
    assert.equal(FORGEJO.match(OFFICIAL), null);
});

test('the GitHub workflow uses the official artifact actions and no fork', () => {
    assert.equal(GITHUB.match(OFFICIAL).length, 3);
    assert.equal(GITHUB.match(FORK), null);
});

test('the Forgejo workflow says why it differs', () => {
    assert.match(FORGEJO, /^# Forgejo's runner sets its own GITHUB_SERVER_URL/);
});

test('neither workflow declares permissions, which Forgejo ignores and warns about', () => {
    [GITHUB, FORGEJO].forEach(text => assert.doesNotMatch(text, /^\s*permissions:/m));
});

test('every checkout leaves its credentials out of the container it is copied into', () => {
    [GITHUB, FORGEJO].forEach(text => {
        const checkouts = text.match(/uses: actions\/checkout@/g).length;
        assert.equal(text.match(/persist-credentials: false/g).length, checkouts);
    });
});

test('no job overrides the server URL the runner reports', () => {
    [GITHUB, FORGEJO].forEach(text => assert.doesNotMatch(text.replace(LEADING_COMMENT, ''), /GITHUB_SERVER_URL/));
});

test('every job but the image job waits for it', () => {
    [GITHUB, FORGEJO].forEach(text => {
        const section = text.slice(text.indexOf('\njobs:\n'));
        const jobs = [...section.matchAll(/^ {2}([a-z0-9-]+):\n/gm)].map(match => match[1]).filter(name => name !== 'image');
        const waiting = [...section.matchAll(/^ {4}needs: (.+)$/gm)].map(match => match[1]);
        assert.equal(waiting.length, jobs.length);
        waiting.forEach(needs => assert.match(needs, /\bimage\b/));
    });
});
