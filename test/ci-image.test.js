import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const SCRIPT = new URL('../.github/ci-image.sh', import.meta.url).pathname;

function run(command, env = {}) {
    return spawnSync('bash', [SCRIPT, command], {env: {PATH: process.env.PATH, ...env}, encoding: 'utf8'});
}

test('a tag handed down by the image job is used as it is', () => {
    const result = run('resolve', {GIVEN: 'git.example/o/r-ci:0123456789abcdef'});
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'IMAGE=git.example/o/r-ci:0123456789abcdef\n');
});

test('with no tag handed down, the tag is the digest of the Dockerfile', () => {
    const digest = createHash('sha256').update(readFileSync('.github/ci.Dockerfile')).digest('hex');
    const result = run('resolve', {REGISTRY: 'git.example', GITHUB_REPOSITORY: 'o/r'});
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `IMAGE=git.example/o/r-ci:${digest.slice(0, 16)}\n`);
});

test('with no registry there is nothing to publish and nothing is attempted', () => {
    const result = run('publish', {IMAGE: 'r-ci:abc'});
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no registry to share an image through/);
});

test('an unknown command is refused with its usage', () => {
    const result = run('nonsense');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: ci-image\.sh resolve\|publish\|use/);
});

test('no command is refused the same way', () => {
    assert.equal(spawnSync('bash', [SCRIPT], {encoding: 'utf8'}).status, 2);
});

function withFakeDocker(output, body) {
    const dir = mkdtempSync(join(tmpdir(), 'ci-image-'));
    try {
        writeFileSync(join(dir, 'docker'), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, {mode: 0o755});
        return body(`${dir}:${process.env.PATH}`);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
}

const TAGGED = {IMAGE: 'r-ci:abc', REGISTRY: ''};

test('use refuses an image that holds no gnome-shell', () => {
    const result = withFakeDocker('', path => run('use', {...TAGGED, PATH: path}));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /r-ci:abc holds no gnome-shell/);
});

test('use accepts an image holding gnome-shell, and says which version', () => {
    const result = withFakeDocker('gnome-shell 1:51.1-1', path => run('use', {...TAGGED, PATH: path}));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /r-ci:abc holds gnome-shell 1:51\.1-1/);
});
