import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    accountDirs, accountRows, cacheName, configDir, configFiles, credentialsFile, defaultDir,
    addableDirs, dirState, displayPath, isCandidateName, isUsable, markerPaths, movedDir, sameSettings, settingFor, settingsFor, shownDirs, steppedDir,
} from '../lib/config-dir.js';

const HOME = '/home/ada';

test('an empty setting means the directory Claude Code uses by default', () => {
    assert.equal(configDir('', HOME), '/home/ada/.claude');
});

test('a set directory is used as given, without a trailing slash', () => {
    assert.equal(configDir('/home/ada/.claude-perso/', HOME), '/home/ada/.claude-perso');
    assert.equal(configDir('/', HOME), '/');
});

test('the default directory is stored as an empty setting, so reset and selection agree', () => {
    assert.equal(settingFor('/home/ada/.claude', HOME), '');
    assert.equal(settingFor('/home/ada/.claude/', HOME), '');
    assert.equal(settingFor('/home/ada/.claude-perso', HOME), '/home/ada/.claude-perso');
});

test('the credentials live inside the directory', () => {
    assert.equal(credentialsFile('/home/ada/.claude-perso'), '/home/ada/.claude-perso/.credentials.json');
});

test('the default directory falls back to the config file Claude Code keeps in home', () => {
    assert.deepEqual(configFiles(defaultDir(HOME), HOME),
        ['/home/ada/.claude/.claude.json', '/home/ada/.claude.json']);
});

test('another directory never reads the home config, which belongs to the default login', () => {
    assert.deepEqual(configFiles('/home/ada/.claude-perso', HOME), ['/home/ada/.claude-perso/.claude.json']);
});

test('the default directory keeps the cache file earlier releases wrote', () => {
    assert.equal(cacheName({dir: defaultDir(HOME), home: HOME, digest: () => 'unused'}), 'usage.json');
});

function digest(path) {
    return path === '/home/ada/.claude-perso' ? '0123456789abcdef0123' : 'ffffffffffffffffffff';
}

test('another directory gets a cache of its own, named after a digest of its path', () => {
    assert.equal(cacheName({dir: '/home/ada/.claude-perso', home: HOME, digest}), 'usage-0123456789abcdef.json');
});

test('only .claude entries other than the config file are candidates', () => {
    assert.equal(isCandidateName('.claude'), true);
    assert.equal(isCandidateName('.claude-perso'), true);
    assert.equal(isCandidateName('.claude.json'), false);
    assert.equal(isCandidateName('.config'), false);
    assert.equal(isCandidateName('claude'), false);
});

test('paths under home are shown with a tilde, others as they are', () => {
    assert.equal(displayPath('/home/ada/.claude', HOME), '~/.claude');
    assert.equal(displayPath('/home/ada', HOME), '~');
    assert.equal(displayPath('/home/adam/.claude', HOME), '/home/adam/.claude');
    assert.equal(displayPath('/srv/claude', HOME), '/srv/claude');
});

test('the account setting names directories in its own order, the empty string standing for the default', () => {
    assert.deepEqual(accountDirs(['/home/ada/.claude-perso/', ''], HOME), ['/home/ada/.claude-perso', '/home/ada/.claude']);
});

test('a directory listed twice is listed once, where it first appears', () => {
    assert.deepEqual(accountDirs(['/srv/b', '/srv/a', '/srv/b/'], HOME), ['/srv/b', '/srv/a']);
});

test('an empty account list stays empty', () => {
    assert.deepEqual(accountDirs([], HOME), []);
});

test('the top bar takes the shown accounts in the account list order, whatever order they were shown in', () => {
    assert.deepEqual(shownDirs({accounts: ['/a', '/b', '/c'], shown: ['/c', '/a']}), ['/a', '/c']);
});

test('a shown directory missing from the account list is not shown', () => {
    assert.deepEqual(shownDirs({accounts: ['/a', '/b'], shown: ['/b', '/x']}), ['/b']);
});

test('nothing shown means no account in the top bar', () => {
    assert.deepEqual(shownDirs({accounts: ['/a', '/b'], shown: []}), []);
});

test('directories are stored as settings, in their order and once each', () => {
    assert.deepEqual(settingsFor(['/srv/b', '/home/ada/.claude', '/srv/b'], HOME), ['/srv/b', '']);
});

test('a directory dropped onto a later one takes its place, the rest closing up', () => {
    assert.deepEqual(movedDir(['/a', '/b', '/c'], {dir: '/a', onto: '/c'}), ['/b', '/c', '/a']);
});

test('a directory dropped onto an earlier one goes before it', () => {
    assert.deepEqual(movedDir(['/a', '/b', '/c'], {dir: '/c', onto: '/a'}), ['/c', '/a', '/b']);
});

test('a drop onto itself, or naming a directory not shown, changes nothing', () => {
    assert.deepEqual(movedDir(['/a', '/b'], {dir: '/a', onto: '/a'}), ['/a', '/b']);
    assert.deepEqual(movedDir(['/a', '/b'], {dir: '/x', onto: '/a'}), ['/a', '/b']);
    assert.deepEqual(movedDir(['/a', '/b'], {dir: '/a', onto: '/x'}), ['/a', '/b']);
});

test('a step moves a directory one place, and a step past either end changes nothing', () => {
    assert.deepEqual(steppedDir(['/a', '/b', '/c'], {dir: '/b', step: -1}), ['/b', '/a', '/c']);
    assert.deepEqual(steppedDir(['/a', '/b', '/c'], {dir: '/b', step: 1}), ['/a', '/c', '/b']);
    assert.deepEqual(steppedDir(['/a', '/b'], {dir: '/a', step: -1}), ['/a', '/b']);
    assert.deepEqual(steppedDir(['/a', '/b'], {dir: '/b', step: 1}), ['/a', '/b']);
});

test('the add menu offers found directories not listed yet, in path order', () => {
    const found = ['/home/ada/.claude-z', '/home/ada/.claude', '/home/ada/.claude-b'];
    assert.deepEqual(addableDirs({found, accounts: ['/home/ada/.claude'], home: HOME}),
        ['/home/ada/.claude-b', '/home/ada/.claude-z']);
});

test('the add menu offers the default directory once removed, even with no login in it', () => {
    assert.deepEqual(addableDirs({found: [], accounts: ['/srv/a'], home: HOME}), ['/home/ada/.claude']);
});

test('rows follow the account list and say which are shown, first and last', () => {
    assert.deepEqual(accountRows({accounts: ['/a', '/b', '/c'], shown: ['/c', '/a']}), [
        {path: '/a', shown: true, first: true, last: false},
        {path: '/b', shown: false, first: false, last: false},
        {path: '/c', shown: true, first: false, last: true},
    ]);
});

test('rows can all be hidden, and an empty list has no rows', () => {
    assert.deepEqual(accountRows({accounts: ['/a'], shown: []}), [{path: '/a', shown: false, first: true, last: true}]);
    assert.deepEqual(accountRows({accounts: [], shown: []}), []);
});

test('a Claude Code directory is recognised by any file Claude Code leaves in it', () => {
    assert.deepEqual(markerPaths('/srv/claude', HOME), [
        '/srv/claude/.claude.json', '/srv/claude/.credentials.json', '/srv/claude/settings.json', '/srv/claude/projects',
    ]);
});

test('the default directory is also recognised by the config Claude Code keeps in home', () => {
    assert.ok(markerPaths(defaultDir(HOME), HOME).includes('/home/ada/.claude.json'));
});

function state(overrides) {
    return dirState({exists: true, marked: true, signedIn: false, broken: false, isDefault: false, ...overrides});
}

test('a credentials file holding no readable token is broken, the default directory included', () => {
    assert.equal(state({broken: true}), 'broken');
    assert.equal(state({broken: true, isDefault: true}), 'broken');
});

test('a directory holding a login is signed in', () => {
    assert.equal(state({signedIn: true}), 'signed-in');
});

test('a Claude Code directory with no login is signed out', () => {
    assert.equal(state({}), 'signed-out');
});

test('a folder Claude Code never used is not a Claude Code directory', () => {
    assert.equal(state({marked: false}), 'not-claude');
});

test('a folder that is gone is missing', () => {
    assert.equal(state({exists: false, marked: false}), 'missing');
});

test('the default directory is signed out, never invalid, even missing or empty', () => {
    assert.equal(state({isDefault: true, exists: false, marked: false}), 'signed-out');
    assert.equal(state({isDefault: true, marked: false}), 'signed-out');
});

test('only signed-in and signed-out directories can be used', () => {
    assert.deepEqual(['signed-in', 'signed-out', 'not-claude', 'missing', 'broken'].map(isUsable), [true, true, false, false, false]);
});

test('a list holding only the default directory is not the empty list', () => {
    assert.equal(sameSettings([''], []), false);
    assert.equal(sameSettings([], ['']), false);
});

test('lists are the same only with the same settings in the same order', () => {
    assert.equal(sameSettings(['', '/srv/a'], ['', '/srv/a']), true);
    assert.equal(sameSettings(['/srv/a', ''], ['', '/srv/a']), false);
});
