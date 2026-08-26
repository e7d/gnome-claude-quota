import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, existsSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const LIB = fileURLToPath(new URL('../tools/lib/devkit.sh', import.meta.url));

function run(script, runtime) {
    const env = {...process.env, CLAUDE_QUOTA_RUNTIME: runtime};
    try {
        const stdout = execFileSync('bash', ['-c', `set -euo pipefail\n. "${LIB}"\n${script}`],
            {encoding: 'utf8', env});
        return {status: 0, stdout};
    } catch (error) {
        return {status: error.status, stdout: error.stdout ?? ''};
    }
}

function runtimeRoot() {
    return mkdtempSync(join(tmpdir(), 'claude-quota-test-'));
}

test('use_session puts every path under the named session', () => {
    const root = runtimeRoot();
    const {stdout} = run('use_session shots\necho "$RUN"\necho "$BUS_FILE"\necho "$STATE_FILE"', root);
    const [runDir, bus, state] = stdout.trim().split('\n');
    assert.equal(runDir, join(root, 'shots'));
    assert.equal(bus, join(root, 'shots', 'bus'));
    assert.equal(state, join(root, 'shots', 'state'));
});

test('a session with no pid file is not live', () => {
    const root = runtimeRoot();
    const {status} = run('use_session ghost\nsession_live', root);
    assert.equal(status, 1);
});

test('a session whose pid is alive is live', () => {
    const root = runtimeRoot();
    const {status} = run('use_session mine\nmkdir -p "$RUN"\necho $$ > "$PID_FILE"\nsession_live', root);
    assert.equal(status, 0);
});

test('reap_session removes a directory whose process is gone', () => {
    const root = runtimeRoot();
    mkdirSync(join(root, 'stale'));
    writeFileSync(join(root, 'stale', 'pid'), '2\n');
    run('use_session stale\nreap_session', root);
    assert.equal(existsSync(join(root, 'stale')), false);
});

test('reap_session leaves a live session alone', () => {
    const root = runtimeRoot();
    const {status} = run('use_session mine\nmkdir -p "$RUN"\necho $$ > "$PID_FILE"\nreap_session\n[ -d "$RUN" ]', root);
    assert.equal(status, 0);
});

test('attach_session refuses a session that is not running', () => {
    const root = runtimeRoot();
    const {status} = run('use_session ghost\nattach_session', root);
    assert.equal(status, 1);
});

test('attach_session exports the recorded bus address', () => {
    const root = runtimeRoot();
    const script = `use_session mine
        mkdir -p "$RUN"
        echo $$ > "$PID_FILE"
        echo 'unix:path=/run/fake-bus' > "$BUS_FILE"
        attach_session
        echo "$DBUS_SESSION_BUS_ADDRESS"`;
    const {status, stdout} = run(script, root);
    assert.equal(status, 0);
    assert.match(stdout, /unix:path=\/run\/fake-bus/);
});

test('state_get returns empty for a key never written', () => {
    const root = runtimeRoot();
    const {stdout} = run('use_session mine\nmkdir -p "$RUN"\necho "[$(state_get theme)]"', root);
    assert.match(stdout, /\[\]/);
});

test('state_set then state_get round-trips a value', () => {
    const root = runtimeRoot();
    const {stdout} = run('use_session mine\nmkdir -p "$RUN"\nstate_set theme dark\nstate_get theme', root);
    assert.equal(stdout.trim(), 'dark');
});

test('state_set replaces a previous value rather than appending', () => {
    const root = runtimeRoot();
    const script = `use_session mine
        mkdir -p "$RUN"
        state_set theme dark
        state_set theme light
        state_get theme
        wc -l < "$STATE_FILE"`;
    const {stdout} = run(script, root);
    const [value, lines] = stdout.trim().split('\n');
    assert.equal(value, 'light');
    assert.equal(lines.trim(), '1');
});

test('state_set keeps the other keys', () => {
    const root = runtimeRoot();
    const script = `use_session mine
        mkdir -p "$RUN"
        state_set theme dark
        state_set data normal
        state_set theme light
        echo "$(state_get theme)/$(state_get data)"`;
    const {stdout} = run(script, root);
    assert.equal(stdout.trim(), 'light/normal');
});

test('tile_name joins the recorded theme and data', () => {
    const root = runtimeRoot();
    const script = `use_session mine
        mkdir -p "$RUN"
        state_set theme dark
        state_set data error
        tile_name`;
    const {stdout} = run(script, root);
    assert.equal(stdout.trim(), 'dark-error');
});

test('tile_name calls an unforced theme default', () => {
    const root = runtimeRoot();
    const script = `use_session mine
        mkdir -p "$RUN"
        state_set data live
        tile_name`;
    const {stdout} = run(script, root);
    assert.equal(stdout.trim(), 'default-live');
});

test('normalize_locale appends the default codeset only when none was given', () => {
    const root = runtimeRoot();
    const {stdout} = run([
        'echo "$(normalize_locale fr_FR)"',
        'echo "$(normalize_locale fr_FR.UTF-8)"',
        'echo "$(normalize_locale fr_FR.ISO-8859-1)"',
        'echo "$(normalize_locale C)"',
        'echo "$(normalize_locale POSIX)"',
    ].join('\n'), root);
    assert.deepEqual(stdout.trim().split('\n'),
        ['fr_FR.UTF-8', 'fr_FR.UTF-8', 'fr_FR.ISO-8859-1', 'C', 'POSIX']);
});

test('locale_tag drops the codeset', () => {
    const root = runtimeRoot();
    const {stdout} = run([
        'echo "$(locale_tag fr_FR.UTF-8)"',
        'echo "$(locale_tag C)"',
        'echo "$(locale_tag pt_BR.UTF-8)"',
    ].join('\n'), root);
    assert.deepEqual(stdout.trim().split('\n'), ['fr_FR', 'C', 'pt_BR']);
});

test('locale_subdir names both axes, and is empty when neither is set', () => {
    const root = runtimeRoot();
    const {stdout} = run([
        'echo "[$(DEVKIT_LANGUAGE=C DEVKIT_LOCALE=C locale_subdir)]"',
        'echo "$(DEVKIT_LANGUAGE=fr_FR.UTF-8 DEVKIT_LOCALE=C locale_subdir)"',
        'echo "$(DEVKIT_LANGUAGE=C DEVKIT_LOCALE=fr_FR.UTF-8 locale_subdir)"',
        'echo "$(DEVKIT_LANGUAGE=fr_FR.UTF-8 DEVKIT_LOCALE=fr_FR.UTF-8 locale_subdir)"',
    ].join('\n'), root);
    assert.deepEqual(stdout.trim().split('\n'), ['[]', 'fr_FR-C', 'C-fr_FR', 'fr_FR-fr_FR']);
});

// locale -a prints fr_FR.utf8, so an exact match would reject the very spelling the flag
// documents. The listing is stubbed rather than read from the host: keyed on the host's own
// generated locales this asserted nothing on a runner that carries only C, and it spent
// weeks skipped for that reason instead of being made independent of where it runs.
const LOCALE_STUB = "locale() { printf 'C\\nPOSIX\\nfr_FR.utf8\\n'; }\n";

test('locale_available compares case and dashes loosely', () => {
    const root = runtimeRoot();
    assert.equal(run(`${LOCALE_STUB}locale_available C`, root).status, 0);
    assert.equal(run(`${LOCALE_STUB}locale_available fr_FR.UTF-8`, root).status, 0);
    assert.equal(run(`${LOCALE_STUB}locale_available FR_fr.utf8`, root).status, 0);
});

test('locale_available refuses a locale the host does not generate', () => {
    const root = runtimeRoot();
    assert.equal(run(`${LOCALE_STUB}locale_available zz_ZZ.UTF-8`, root).status, 1);
    assert.equal(run(`${LOCALE_STUB}locale_available de_DE.utf8`, root).status, 1);
});

// A fixed name under a world-writable /tmp is a path another user can own first, and the
// lock and the sandbox home both live in it.
test('the runtime root falls back to a uid-scoped path, never a shared one', () => {
    const root = runtimeRoot();
    const {stdout} = run('unset XDG_RUNTIME_DIR\ndefault_runtime_root', root);
    assert.equal(stdout, `/tmp/claude-quota-${process.getuid()}`);
});

test('the runtime root prefers the session runtime directory when there is one', () => {
    const root = runtimeRoot();
    const {stdout} = run('XDG_RUNTIME_DIR=/run/user/4242 default_runtime_root', root);
    assert.equal(stdout, '/run/user/4242/claude-quota');
});

test('claim_session refuses a runtime root owned by somebody else', () => {
    const root = runtimeRoot();
    const {status, stdout} = run(
        'RUNTIME_ROOT=/tmp\nclaim_session e2e && echo "claimed"', root);
    assert.doesNotMatch(stdout, /claimed/);
    assert.equal(status, 1);
});

test('claim_session refuses a session another run already holds', () => {
    const root = runtimeRoot();
    const {status, stdout} = run(
        'claim_session e2e\necho first\n( claim_session e2e ) && echo "second got in"', root);
    assert.match(stdout, /first/);
    assert.doesNotMatch(stdout, /second got in/);
    assert.notEqual(status, 0);
});

test('claim_session keeps its lock outside the session directory', () => {
    const root = runtimeRoot();
    const {stdout} = run('use_session e2e\nclaim_session e2e\nreap_session\nls "$RUNTIME_ROOT"', root);
    assert.match(stdout, /e2e\.lock/);
});

test('a session freed by its holder can be claimed again', () => {
    const root = runtimeRoot();
    const {status} = run('( claim_session e2e )\nclaim_session e2e', root);
    assert.equal(status, 0);
});
