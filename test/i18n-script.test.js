import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const SCRIPT = new URL('../tools/i18n.sh', import.meta.url).pathname;
const NEEDED = ['bash', 'dirname', 'grep', 'mkdir', 'mktemp', 'msgfmt', 'msgmerge', 'rm', 'xgettext'];

function located(name) {
    return process.env.PATH.split(':').map(dir => join(dir, name)).find(path => existsSync(path));
}

function runWithout(missing, mode) {
    const bin = mkdtempSync(join(tmpdir(), 'i18n-path-'));
    try {
        NEEDED.filter(name => !missing.includes(name)).forEach(name => symlinkSync(located(name), join(bin, name)));
        return spawnSync(join(bin, 'bash'), [SCRIPT, mode], {env: {PATH: bin}, encoding: 'utf8'});
    } finally {
        rmSync(bin, {recursive: true, force: true});
    }
}

const gettext = ['msgfmt', 'msgmerge', 'xgettext'].every(name => located(name));

test('a missing diff is named, never reported as a stale catalog', {skip: !gettext && 'gettext not installed'}, () => {
    const run = runWithout(['diff', 'cmp'], '--check');
    assert.equal(run.status, 127);
    assert.match(run.stderr, /needs diff/);
    assert.doesNotMatch(run.stderr, /stale/);
});

test('regenerating refuses before writing anything when a tool is missing', () => {
    const run = runWithout(['xgettext'], '--all');
    assert.equal(run.status, 127);
    assert.match(run.stderr, /needs xgettext/);
});
