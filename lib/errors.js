import {N_, _, format} from './i18n.js';

export const NO_LOGIN = N_('No active Claude login, run Claude Code to sign in.');
export const NOT_FOUND = N_('Folder {path} not found.');
export const NOT_CLAUDE = N_('{path} is not a Claude Code directory.');
export const NO_TOKEN = N_('No Claude token in {path}');

const STATE_ERRORS = {'missing': NOT_FOUND, 'not-claude': NOT_CLAUDE};
const NO_ACCOUNT = new Set([NO_LOGIN, NOT_FOUND, NOT_CLAUDE, NO_TOKEN]);

// The message stays English on purpose: it is what reaches attempts.jsonl, and a
// diagnostic log whose language follows the host is worse than one with no text.
export function describe(msgid, values = {}) {
    return {msgid, values, message: format(msgid, values)};
}

export function loginError(state) {
    return STATE_ERRORS[state] ?? NO_LOGIN;
}

// Each of these leaves nothing to show for the account, so all of them keep the panel to
// its icon and the popup free of the account and plan rows.
export function signedOut(desc) {
    return NO_ACCOUNT.has(desc?.msgid);
}

export function errorText(desc) {
    return desc === null ? '' : format(_(desc.msgid), desc.values);
}
