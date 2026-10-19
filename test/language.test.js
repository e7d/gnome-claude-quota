import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {_, n_, resetTranslator} from '../lib/i18n.js';
import {AUTOMATIC, choiceAt, choiceIndex, installLanguage, languageChoices} from '../lib/language.js';

const FRENCH_MO = readFileSync(new URL('../locale/fr/LC_MESSAGES/claude-quota.mo', import.meta.url));

const catalogs = {tags: ['fr'], read: tag => (tag === 'fr' ? FRENCH_MO : assert.fail(`read ${tag}`))};

const SYSTEM = {
    gettext: msgid => `system:${msgid}`,
    ngettext: msgid => `system:${msgid}`,
    pgettext: (context, msgid) => `system:${msgid}`,
};

test('each language is named in itself, capitalised the way GNOME lists them', () => {
    assert.deepEqual(languageChoices(['fr']), [{tag: 'en', name: 'English'}, {tag: 'fr', name: 'Français'}]);
});

test('the choices sort by their own names, Latin scripts before CJK', () => {
    const names = languageChoices(['zh', 'ja', 'it', 'fr', 'es', 'de']).map(choice => choice.name);
    assert.deepEqual(names, ['Deutsch', 'English', 'Español', 'Français', 'Italiano', '中文', '日本語']);
});

test('English is listed once, whether or not a catalog ships for it', () => {
    assert.deepEqual(languageChoices(['en', 'fr']).map(choice => choice.tag), ['en', 'fr']);
    assert.deepEqual(languageChoices([]).map(choice => choice.tag), ['en']);
});

test('Automatic sits before the languages in the dropdown', () => {
    const choices = languageChoices(['fr']);
    assert.equal(choiceIndex(choices, AUTOMATIC), 0);
    assert.equal(choiceIndex(choices, 'en'), 1);
    assert.equal(choiceIndex(choices, 'fr'), 2);
    assert.equal(choiceAt(choices, 0), AUTOMATIC);
    assert.equal(choiceAt(choices, 2), 'fr');
});

test('a language no catalog ships any more shows as Automatic', () => {
    const choices = languageChoices(['fr']);
    assert.equal(choiceIndex(choices, 'de'), 0);
    assert.equal(choiceAt(choices, 7), AUTOMATIC);
});

test('Automatic hands every lookup to the system gettext', () => {
    installLanguage({language: AUTOMATIC, catalogs, system: SYSTEM});
    assert.equal(_('Weekly'), 'system:Weekly');
    resetTranslator();
});

test('a language without a shipped catalog behaves as Automatic', () => {
    installLanguage({language: 'de', catalogs, system: SYSTEM});
    assert.equal(_('Weekly'), 'system:Weekly');
    resetTranslator();
});

test('a forced language reads its own catalog, whatever the system says', () => {
    installLanguage({language: 'fr', catalogs, system: SYSTEM});
    assert.equal(_('Weekly'), 'Hebdomadaire');
    assert.equal(n_('{m}m left', '{m}m left', 2), '{m} min restantes');
    resetTranslator();
});

test('forcing English bypasses the system catalog entirely', () => {
    installLanguage({language: 'fr', catalogs, system: SYSTEM});
    installLanguage({language: 'en', catalogs, system: SYSTEM});
    assert.equal(_('Weekly'), 'Weekly');
    assert.equal(n_('one', 'many', 2), 'many');
});
