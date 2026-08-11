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
