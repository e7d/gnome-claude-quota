import {N_, _, format} from './i18n.js';

export const NO_LOGIN = N_('No active Claude login, run Claude Code to sign in.');

// The message stays English on purpose: it is what reaches attempts.jsonl, and a
// diagnostic log whose language follows the host is worse than one with no text.
export function describe(msgid, values = {}) {
    return {msgid, values, message: format(msgid, values)};
}

export function signedOut(desc) {
    return desc?.msgid === NO_LOGIN;
}

export function errorText(desc) {
    return desc === null ? '' : format(_(desc.msgid), desc.values);
}
