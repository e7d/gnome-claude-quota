import {test} from 'node:test';
import assert from 'node:assert/strict';

import {N_, _, format, n_, p_, resetTranslator, setTranslator} from '../lib/i18n.js';

const FRENCH = {
    gettext: msgid => ({'Weekly': 'Hebdomadaire'})[msgid] ?? msgid,
    ngettext: (msgid, plural, count) => (count > 1 ? `${plural}!` : `${msgid}!`),
    pgettext: (context, msgid) => `${context}/${msgid}`,
};

test('every lookup is the identity until a translator is installed', () => {
    assert.equal(_('Weekly'), 'Weekly');
    assert.equal(p_('panel initial', 'W'), 'W');
    assert.equal(N_('Weekly'), 'Weekly');
});

test('the identity default picks the English plural rule', () => {
    assert.equal(n_('{m}m left', '{m}m left', 1), '{m}m left');
    assert.equal(n_('one', 'many', 2), 'many');
    assert.equal(n_('one', 'many', 0), 'many');
});

test('an installed translator receives every lookup', () => {
    setTranslator(FRENCH);
    assert.equal(_('Weekly'), 'Hebdomadaire');
    assert.equal(p_('panel initial', 'W'), 'panel initial/W');
    assert.equal(n_('one', 'many', 2), 'many!');
    resetTranslator();
    assert.equal(_('Weekly'), 'Weekly');
});

test('N_ never translates, so a constant keeps its msgid', () => {
    setTranslator(FRENCH);
    assert.equal(N_('Weekly'), 'Weekly');
    resetTranslator();
});

test('format substitutes named placeholders', () => {
    assert.equal(format('{h} h {m}', {h: 4, m: '08'}), '4 h 08');
});

test('format leaves a placeholder it was given no value for', () => {
    assert.equal(format('{a} and {b}', {a: 1}), '1 and {b}');
});

test('format accepts a pattern with no placeholders at all', () => {
    assert.equal(format('Rate limited'), 'Rate limited');
});
