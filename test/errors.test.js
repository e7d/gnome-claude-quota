import assert from 'node:assert/strict';
import {test} from 'node:test';

import {describe, errorText} from '../lib/errors.js';
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
