import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

function entries(source) {
    return source.split(/\n\n+/).map(block => {
        const read = field => [...block.matchAll(new RegExp(`^${field}(?:\\[\\d\\])? "(.*)"$`, 'gm'))]
            .map(match => match[1]);
        return {
            id: read('msgid')[0],
            context: read('msgctxt')[0],
            plural: read('msgid_plural')[0],
            translations: read('msgstr'),
        };
    }).filter(entry => entry.id !== undefined && entry.id !== '');
}

function pluralCount(header) {
    return Number(header.match(/nplurals=(\d+)/)[1]);
}

function key(entry) {
    return entry.context === undefined ? entry.id : `${entry.context}${entry.id}`;
}

function placeholders(text) {
    return [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).toSorted();
}

const pot = readFileSync(new URL('../po/claude-quota.pot', import.meta.url), 'utf8');
const po = readFileSync(new URL('../po/fr.po', import.meta.url), 'utf8');

test('the template carries every msgid the code marks', () => {
    assert.ok(entries(pot).length >= 26, `template holds only ${entries(pot).length} msgids`);
});

test('every msgid in the template is translated in French', () => {
    const translated = new Map(entries(po).map(entry => [key(entry), entry]));
    const missing = entries(pot)
        .filter(entry => !translated.get(key(entry))?.translations.every(text => text !== ''))
        .map(key);
    assert.deepEqual(missing, []);
});

test('every French plural entry carries the number of forms its header declares', () => {
    const forms = pluralCount(po);
    const wrong = entries(po)
        .filter(entry => entry.plural !== undefined)
        .filter(entry => entry.translations.length !== forms)
        .map(key);
    assert.deepEqual(wrong, []);
});

test('French declares the rule that counts zero as singular', () => {
    assert.match(po, /"Plural-Forms: nplurals=2; plural=\(n > 1\);\\n"/);
});

// A placeholder dropped or renamed in translation renders the literal {name} to a
// user, and msgfmt --check does not read this syntax the way it reads printf.
test('no translation loses or invents a placeholder', () => {
    const wrong = entries(po)
        .filter(entry => entry.translations.some(text => text !== ''))
        .filter(entry => entry.translations.some(text =>
            JSON.stringify(placeholders(text)) !== JSON.stringify(placeholders(entry.id))))
        .map(key);
    assert.deepEqual(wrong, []);
});
