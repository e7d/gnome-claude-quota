import assert from 'node:assert/strict';
import {test} from 'node:test';

import {isOwnPrefsWindow} from '../lib/prefs-window.js';

const NAME = 'Claude Quota';

test('the preferences app window titled after the extension is ours', () => {
    assert.equal(isOwnPrefsWindow({appId: 'org.gnome.Shell.Extensions', title: NAME}, NAME), true);
});

test('another extension\'s preferences window is not ours', () => {
    assert.equal(isOwnPrefsWindow({appId: 'org.gnome.Shell.Extensions', title: 'Dash to Dock'}, NAME), false);
});

test('a window of another app carrying the same title is not ours', () => {
    assert.equal(isOwnPrefsWindow({appId: 'org.gnome.Nautilus', title: NAME}, NAME), false);
});

test('a window with no application id is not ours', () => {
    assert.equal(isOwnPrefsWindow({appId: null, title: NAME}, NAME), false);
});
