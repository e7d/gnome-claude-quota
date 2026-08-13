let translator = null;

export function setTranslator({gettext, ngettext, pgettext}) {
    translator = {gettext, ngettext, pgettext};
}

export function resetTranslator() {
    translator = null;
}

export function _(msgid) {
    return translator ? translator.gettext(msgid) : msgid;
}

export function n_(msgid, plural, count) {
    if (translator)
        return translator.ngettext(msgid, plural, count);
    return count === 1 ? msgid : plural;
}

export function p_(context, msgid) {
    return translator ? translator.pgettext(context, msgid) : msgid;
}

export function N_(msgid) {
    return msgid;
}

export function format(pattern, values = {}) {
    return pattern.replace(/\{(\w+)\}/g, (placeholder, name) =>
        Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}
