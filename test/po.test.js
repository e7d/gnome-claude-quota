import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {test} from 'node:test';

function entries(source) {
    return source.split(/\n\n+/).map(block => {
        const read = field => [...block.matchAll(new RegExp(`^${field}(?:\\[\\d\\])? "(.*)"((?:\\n".*")*)$`, 'gm'))]
            .map(([, head, rest]) => head + rest.split('\n').map(line => line.slice(1, -1)).join(''));
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

// gettext's own context separator, spelled rather than pasted: as a literal control
// character it is invisible in an editor and in a diff, and a key built without it
// silently fails to match every contextual entry.
const CONTEXT_SEPARATOR = '\u0004';

function key(entry) {
    return entry.context === undefined
        ? entry.id
        : `${entry.context}${CONTEXT_SEPARATOR}${entry.id}`;
}

function placeholders(text) {
    return [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).toSorted();
}

const pot = readFileSync(new URL('../po/claude-quota.pot', import.meta.url), 'utf8');
const po = readFileSync(new URL('../po/fr.po', import.meta.url), 'utf8');

// A floor of "at least N" cannot tell a catalog that lost a dozen strings from one that
// never had them, so the template is compared against the call sites themselves — and the
// file list is discovered rather than copied from tools/i18n.sh, which is the one list that
// cannot report its own omission.
function shippedSources(dir = new URL('../', import.meta.url)) {
    return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        if (entry.isDirectory())
            return SKIPPED.has(entry.name) ? [] : shippedSources(new URL(`${entry.name}/`, dir));
        return entry.name.endsWith('.js') ? [readFileSync(new URL(entry.name, dir), 'utf8')] : [];
    });
}

const SKIPPED = new Set(['node_modules', 'test', 'tools', 'coverage', 'preview', 'docs', '.git']);
const STRING = String.raw`'((?:[^'\\]|\\.)*)'`;
const CALLS = [
    {pattern: new RegExp(String.raw`\b(?:_|N_|describe|fail)\(\s*${STRING}`, 'g'), entry: match => ({id: match[1]})},
    {pattern: new RegExp(String.raw`\bn_\(\s*${STRING}`, 'g'), entry: match => ({id: match[1]})},
    {pattern: new RegExp(String.raw`\bp_\(\s*${STRING}\s*,\s*${STRING}`, 'g'),
        entry: match => ({context: match[1], id: match[2]})},
];

function markedIn(source) {
    return CALLS.flatMap(({pattern, entry}) =>
        [...source.matchAll(pattern)].map(match => key(entry(match))));
}

test('a msgstr msgmerge wrapped onto continuation lines reads as its full text', () => {
    const [entry] = entries('msgid "a"\nmsgstr ""\n"Une ligne "\n"puis une autre."\n');
    assert.deepEqual(entry.translations, ['Une ligne puis une autre.']);
});

test('the template carries every msgid the code marks', () => {
    const marked = new Set(shippedSources().flatMap(markedIn));
    assert.ok(marked.size >= 26, `only ${marked.size} call sites found — the scanner reads nothing`);
    const held = new Set(entries(pot).map(key));
    assert.deepEqual([...marked].filter(msgid => !held.has(msgid)), []);
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
