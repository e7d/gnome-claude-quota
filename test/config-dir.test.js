import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    cacheName, choiceLabel, configDir, configFiles, credentialsFile, defaultDir, directoryChoices,
    displayPath, isCandidateName, settingFor,
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

test('a label names the account when the directory says which one it is', () => {
    assert.equal(choiceLabel({path: '/home/ada/.claude', email: 'ada@example.com'}, HOME), '~/.claude · ada@example.com');
    assert.equal(choiceLabel({path: '/home/ada/.claude', email: null}, HOME), '~/.claude');
});

test('the default directory is always offered, even with no login in it', () => {
    const choices = directoryChoices({found: [], current: defaultDir(HOME), home: HOME});
    assert.deepEqual(choices, [{path: '/home/ada/.claude', email: null}]);
});

test('found directories are listed in path order, carrying their account', () => {
    const choices = directoryChoices({
        found: [
            {path: '/home/ada/.claude-perso', email: 'ada@perso.example'},
            {path: '/home/ada/.claude', email: 'ada@work.example'},
        ],
        current: defaultDir(HOME),
        home: HOME,
    });
    assert.deepEqual(choices.map(choice => choice.email), ['ada@work.example', 'ada@perso.example']);
});

test('a folder picked by hand is listed even though the scan never finds it', () => {
    const choices = directoryChoices({found: [], current: '/srv/claude', home: HOME});
    assert.deepEqual(choices.map(choice => choice.path), ['/home/ada/.claude', '/srv/claude']);
});

test('a found directory that is also the current one is listed once', () => {
    const choices = directoryChoices({
        found: [{path: '/home/ada/.claude-perso', email: 'ada@perso.example'}],
        current: '/home/ada/.claude-perso',
        home: HOME,
    });
    assert.equal(choices.length, 2);
});
