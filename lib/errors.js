import {_, format} from './i18n.js';

// The message stays English on purpose: it is what reaches attempts.jsonl, and a
// diagnostic log whose language follows the host is worse than one with no text.
export function describe(msgid, values = {}) {
    return {msgid, values, message: format(msgid, values)};
}

export function errorText(desc) {
    return desc === null ? '' : format(_(desc.msgid), desc.values);
}
