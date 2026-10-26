import assert from 'node:assert/strict';
import {test} from 'node:test';

import {NOT_CLAUDE, NOT_FOUND, NO_LOGIN, NO_TOKEN, describe, errorText, loginError, signedOut} from '../lib/errors.js';
import {resetTranslator, setTranslator} from '../lib/i18n.js';

test('describe keeps an English message for the log', () => {
    const desc = describe('Usage request failed (HTTP {status})', {status: 503});
    assert.equal(desc.message, 'Usage request failed (HTTP 503)');
    assert.equal(desc.msgid, 'Usage request failed (HTTP {status})');
    assert.deepEqual(desc.values, {status: 503});
});

test('describe leaves the message English even under a translator', () => {
    setTranslator({gettext: () => 'traduit', ngettext: msgid => msgid, pgettext: (context, msgid) => msgid});
    assert.equal(describe('Cannot reach api.anthropic.com').message, 'Cannot reach api.anthropic.com');
    resetTranslator();
});

test('errorText translates and then interpolates', () => {
    setTranslator({
        gettext: msgid => ({'Usage request failed (HTTP {status})': 'Échec de la requête (HTTP {status})'})[msgid] ?? msgid,
        ngettext: msgid => msgid,
        pgettext: (context, msgid) => msgid,
    });
    assert.equal(errorText(describe('Usage request failed (HTTP {status})', {status: 503})),
        'Échec de la requête (HTTP 503)');
    resetTranslator();
});

test('errorText renders nothing for no error', () => {
    assert.equal(errorText(null), '');
});

test('each folder state without a login gets its own message', () => {
    assert.equal(loginError('missing'), NOT_FOUND);
    assert.equal(loginError('not-claude'), NOT_CLAUDE);
    assert.equal(loginError('signed-out'), NO_LOGIN);
});

test('signedOut recognises every error that leaves no account to show', () => {
    assert.equal(signedOut(describe(NO_LOGIN)), true);
    assert.equal(signedOut(describe(NOT_FOUND, {path: '/srv/a'})), true);
    assert.equal(signedOut(describe(NOT_CLAUDE, {path: '/srv/a'})), true);
    assert.equal(signedOut(describe(NO_TOKEN, {path: '/srv/a/.credentials.json'})), true);
    assert.equal(signedOut(describe('Cannot reach api.anthropic.com')), false);
    assert.equal(signedOut(null), false);
});
