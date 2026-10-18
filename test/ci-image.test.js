import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const SCRIPT = new URL('../.github/ci-image.sh', import.meta.url).pathname;

function run(command, env = {}) {
    return spawnSync('bash', [SCRIPT, command], {env: {PATH: process.env.PATH, ...env}, encoding: 'utf8'});
}

test('a tag handed down by the image job is used as it is', () => {
    const result = run('resolve', {GIVEN: 'git.example/o/r-ci:0123456789abcdef-gnome-1_51.1-1'});
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'IMAGE=git.example/o/r-ci:0123456789abcdef-gnome-1_51.1-1\nGNOME=1:51.1-1\n');
});

test('the epoch separator is restored from the tag, and absent when there is none', () => {
    assert.equal(run('resolve', {GIVEN: 'r-ci:abc-gnome-51.1-1'}).stdout, 'IMAGE=r-ci:abc-gnome-51.1-1\nGNOME=51.1-1\n');
    assert.equal(run('resolve', {GIVEN: 'r-ci:abc-gnome-2_52.0-3'}).stdout.split('\n')[1], 'GNOME=2:52.0-3');
});

test('with no registry there is nothing to publish and nothing is attempted', () => {
    const result = run('publish', {IMAGE: 'r-ci:abc-gnome-1_51.1-1', GNOME: '1:51.1-1'});
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

const TAGGED = {IMAGE: 'r-ci:abc-gnome-1_51.1-1', GNOME: '1:51.1-1', REGISTRY: ''};

test('use refuses an image that holds another gnome-shell, whatever its tag says', () => {
    const result = withFakeDocker('gnome-shell 1:50.4-1', path => run('use', {...TAGGED, PATH: path}));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /holds gnome-shell 1:50\.4-1, not 1:51\.1-1/);
});

test('use accepts an image that holds the version the tag names', () => {
    const result = withFakeDocker('gnome-shell 1:51.1-1', path => run('use', {...TAGGED, PATH: path}));
    assert.equal(result.status, 0);
});
