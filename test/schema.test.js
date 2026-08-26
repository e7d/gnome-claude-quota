import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const SOURCE = new URL('../schemas/org.gnome.shell.extensions.claude-quota.gschema.xml', import.meta.url);
const COMMITTED = new URL('../schemas/gschemas.compiled', import.meta.url);
const NAME = 'org.gnome.shell.extensions.claude-quota.gschema.xml';

// The binary being absent is not evidence about the artifact, so it fails by its own
// name rather than as a stale schema.
function compile(xml) {
    const dir = mkdtempSync(join(tmpdir(), 'claude-quota-schema-'));
    try {
        writeFileSync(join(dir, NAME), xml);
        execFileSync('glib-compile-schemas', [dir]);
        return readFileSync(join(dir, 'gschemas.compiled'));
    } catch (error) {
        assert.notEqual(error.code, 'ENOENT', 'glib-compile-schemas is not on PATH');
        throw error;
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
}

const xml = readFileSync(SOURCE, 'utf8');

// The checkout is what a user installs, so the compiled file ships with it and the shell
// reads that rather than the XML — an unrecompiled edit changes nothing but the review.
test('the committed gschemas.compiled matches the schema it was built from', () => {
    assert.deepEqual(compile(xml), readFileSync(COMMITTED));
});

test('the comparison can tell a stale artifact from a current one', () => {
    const changed = xml.replace('<default>75</default>', '<default>76</default>');
    assert.notEqual(changed, xml, 'the control edited nothing');
    assert.notDeepEqual(compile(changed), readFileSync(COMMITTED));
});
