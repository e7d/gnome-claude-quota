import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {catalogTranslator, parseCatalog, pluralRule} from '../lib/catalog.js';

const MAGIC = 0x950412de;

function moBytes(pairs, {bigEndian = false} = {}) {
    const encoder = new TextEncoder();
    const strings = pairs.flat().map(text => encoder.encode(text));
    const tablesAt = 28;
    let dataAt = tablesAt + strings.length * 8;
    const bytes = new Uint8Array(dataAt + strings.reduce((sum, text) => sum + text.length + 1, 0));
    const view = new DataView(bytes.buffer);
    const word = (offset, value) => view.setUint32(offset, value, !bigEndian);
    [MAGIC, 0, pairs.length, tablesAt, tablesAt + pairs.length * 8, 0, 0]
        .forEach((value, index) => word(index * 4, value));
    const slots = [...pairs.keys()].flatMap(index => [index * 2, index * 2 + 1]);
    const ordered = [...slots.filter(slot => slot % 2 === 0), ...slots.filter(slot => slot % 2 === 1)];
    ordered.forEach((slot, position) => {
        word(tablesAt + position * 8, strings[slot].length);
        word(tablesAt + position * 8 + 4, dataAt);
        bytes.set(strings[slot], dataAt);
        dataAt += strings[slot].length + 1;
    });
    return bytes;
}

const FRENCH_HEADER = 'Content-Type: text/plain; charset=UTF-8\nPlural-Forms: nplurals=2; plural=(n > 1);\n';

function unescape(text) {
    return JSON.parse(`"${text}"`);
}

function poEntries(source) {
    return source.split(/\n\n+/).filter(block => !/^#, .*fuzzy/m.test(block)).map(block => {
        const read = field => [...block.matchAll(new RegExp(`^${field}(?:\\[\\d\\])? "(.*)"$`, 'gm'))]
            .map(match => unescape(match[1]));
        return {id: read('msgid')[0], context: read('msgctxt')[0], plural: read('msgid_plural')[0],
            translations: read('msgstr')};
    }).filter(entry => entry.id && entry.translations.every(Boolean));
}

test('the committed French catalog answers every translated entry of fr.po', () => {
    const translator = catalogTranslator(parseCatalog(readFileSync(
        new URL('../locale/fr/LC_MESSAGES/claude-quota.mo', import.meta.url))));
    const entries = poEntries(readFileSync(new URL('../po/fr.po', import.meta.url), 'utf8'));
    assert.ok(entries.length > 40, `only ${entries.length} entries read from fr.po`);
    entries.forEach(entry => {
        if (entry.plural !== undefined) {
            assert.equal(translator.ngettext(entry.id, entry.plural, 1), entry.translations[0]);
            assert.equal(translator.ngettext(entry.id, entry.plural, 2), entry.translations[1]);
        } else if (entry.context !== undefined) {
            assert.equal(translator.pgettext(entry.context, entry.id), entry.translations[0]);
        } else {
            assert.equal(translator.gettext(entry.id), entry.translations[0]);
        }
    });
});

test('a message the catalog lacks comes back untranslated', () => {
    const translator = catalogTranslator(parseCatalog(moBytes([['', FRENCH_HEADER]])));
    assert.equal(translator.gettext('Weekly'), 'Weekly');
    assert.equal(translator.pgettext('panel initial', 'W'), 'W');
    assert.equal(translator.ngettext('one', 'many', 1), 'one');
    assert.equal(translator.ngettext('one', 'many', 0), 'many');
});

test('an empty translation falls back to the msgid', () => {
    const translator = catalogTranslator(parseCatalog(moBytes([['', FRENCH_HEADER], ['Weekly', '']])));
    assert.equal(translator.gettext('Weekly'), 'Weekly');
});

test('plural forms follow the header rule, French counting zero as singular', () => {
    const translator = catalogTranslator(parseCatalog(moBytes([
        ['', FRENCH_HEADER], ['{m}m left\0{m}m left', '{m} min restante\0{m} min restantes']])));
    assert.equal(translator.ngettext('{m}m left', '{m}m left', 0), '{m} min restante');
    assert.equal(translator.ngettext('{m}m left', '{m}m left', 1), '{m} min restante');
    assert.equal(translator.ngettext('{m}m left', '{m}m left', 2), '{m} min restantes');
});

test('a catalog without a Plural-Forms header uses the English rule', () => {
    const translator = catalogTranslator(parseCatalog(moBytes([['one\0many', 'un\0plusieurs']])));
    assert.equal(translator.ngettext('one', 'many', 0), 'plusieurs');
    assert.equal(translator.ngettext('one', 'many', 1), 'un');
});

test('a big-endian catalog reads the same as a little-endian one', () => {
    const pairs = [['', FRENCH_HEADER], ['Weekly', 'Hebdomadaire'], ['panel initial\u0004W', 'H']];
    [false, true].forEach(bigEndian => {
        const translator = catalogTranslator(parseCatalog(moBytes(pairs, {bigEndian})));
        assert.equal(translator.gettext('Weekly'), 'Hebdomadaire');
        assert.equal(translator.pgettext('panel initial', 'W'), 'H');
    });
});

test('bytes that are not a catalog are refused', () => {
    assert.throws(() => parseCatalog(new Uint8Array(28)), /not a gettext catalog/);
});

test('plural rules evaluate C operators with C precedence', () => {
    const polish = '(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2)';
    [[1, 0], [2, 1], [4, 1], [5, 2], [12, 2], [22, 1], [0, 2]]
        .forEach(([n, form]) => assert.equal(pluralRule(polish)(n), form, `polish ${n}`));
    [
        ['n != 1', 1, 0], ['n != 1', 3, 1], ['n > 1', 1, 0], ['n < 2', 1, 1],
        ['!n', 0, 1], ['!n', 2, 0], ['n / 2', 5, 2], ['n * 2 + 1 - 3', 4, 6],
        ['n == 0 || n == 7', 7, 1], ['n == 0 || n == 7', 6, 0], ['0 && n', 3, 0],
    ].forEach(([expression, n, form]) => assert.equal(pluralRule(expression)(n), form, `${expression} at ${n}`));
});

test('a malformed plural rule is refused rather than guessed', () => {
    ['', '(n', 'n ==', 'n = 1', 'n 1', 'n ? 1', 'x'].forEach(expression =>
        assert.throws(() => pluralRule(expression), /plural expression/, expression));
});
