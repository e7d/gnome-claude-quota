const MAGIC = 0x950412de;
const CONTEXT_SEPARATOR = '\u0004';
const DEFAULT_PLURAL = 'n != 1';

const BINARY = [
    {'||': (a, b) => Number(Boolean(a || b))},
    {'&&': (a, b) => Number(Boolean(a && b))},
    {'==': (a, b) => Number(a === b), '!=': (a, b) => Number(a !== b)},
    {
        '<': (a, b) => Number(a < b), '>': (a, b) => Number(a > b),
        '<=': (a, b) => Number(a <= b), '>=': (a, b) => Number(a >= b),
    },
    {'+': (a, b) => a + b, '-': (a, b) => a - b},
    {'*': (a, b) => a * b, '/': (a, b) => Math.trunc(a / b), '%': (a, b) => a % b},
];

function cursorOver(tokens) {
    let at = 0;
    return {
        peek: () => tokens[at],
        next: () => tokens[at++],
        expect(token) {
            if (tokens[at++] !== token)
                throw new Error(`expected ${token} in plural expression`);
        },
    };
}

function operand(cursor) {
    const token = cursor.next();
    if (token === '!') {
        const negated = operand(cursor);
        return n => Number(!negated(n));
    }
    if (token === '(') {
        const inner = ternary(cursor);
        cursor.expect(')');
        return inner;
    }
    if (token === 'n')
        return n => n;
    if (/^\d+$/.test(token ?? ''))
        return () => Number(token);
    throw new Error(`unexpected ${token ?? 'end'} in plural expression`);
}

function binary(cursor, level) {
    if (level === BINARY.length)
        return operand(cursor);
    let left = binary(cursor, level + 1);
    while (Object.hasOwn(BINARY[level], cursor.peek() ?? '')) {
        const apply = BINARY[level][cursor.next()];
        const [lhs, rhs] = [left, binary(cursor, level + 1)];
        left = n => apply(lhs(n), rhs(n));
    }
    return left;
}

function ternary(cursor) {
    const condition = binary(cursor, 0);
    if (cursor.peek() !== '?')
        return condition;
    cursor.next();
    const whenTrue = ternary(cursor);
    cursor.expect(':');
    const whenFalse = ternary(cursor);
    return n => (condition(n) ? whenTrue(n) : whenFalse(n));
}

export function pluralRule(expression) {
    const cursor = cursorOver(expression.match(/\d+|n|[<>=!]=|&&|\|\||\S/g) ?? []);
    const rule = ternary(cursor);
    if (cursor.peek() !== undefined)
        throw new Error(`unexpected ${cursor.peek()} in plural expression`);
    return rule;
}

function pluralExpression(header) {
    return header.match(/^Plural-Forms:.*\bplural=([^;\n]+)/m)?.[1] ?? DEFAULT_PLURAL;
}

function wordReader(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = view.getUint32(0, true) === MAGIC;
    if (!little && view.getUint32(0, false) !== MAGIC)
        throw new Error('not a gettext catalog');
    return offset => view.getUint32(offset, little);
}

function stringTable(bytes, word, table) {
    const decoder = new TextDecoder();
    return [...Array(word(8)).keys()].map(index => {
        const length = word(table + index * 8);
        const offset = word(table + index * 8 + 4);
        return decoder.decode(bytes.subarray(offset, offset + length));
    });
}

export function parseCatalog(bytes) {
    const word = wordReader(bytes);
    const translations = stringTable(bytes, word, word(16));
    const messages = new Map(stringTable(bytes, word, word(12)).map((original, index) =>
        [original.split('\0')[0], translations[index].split('\0')]));
    return {messages, plural: pluralRule(pluralExpression(messages.get('')?.[0] ?? ''))};
}

export function catalogTranslator({messages, plural}) {
    return {
        gettext: msgid => messages.get(msgid)?.[0] || msgid,
        ngettext: (msgid, msgidPlural, count) =>
            messages.get(msgid)?.[plural(count)] || (count === 1 ? msgid : msgidPlural),
        pgettext: (context, msgid) => messages.get(`${context}${CONTEXT_SEPARATOR}${msgid}`)?.[0] || msgid,
    };
}
