import {N_} from './i18n.js';

export const SCOPES = [
    {id: 'session', name: N_('Session (5h)'), barKey: 'session-in-bar', menuKey: 'session-in-menu'},
    {id: 'weekly', name: N_('Weekly'), barKey: 'weekly-in-bar', menuKey: 'weekly-in-menu'},
    {id: 'scoped', name: N_('Model-specific'), barKey: 'scoped-in-bar', menuKey: 'scoped-in-menu'},
];

export const SCOPE_IDS = SCOPES.map(scope => scope.id);

export const ACCOUNT_KEY = 'show-account';
export const PLAN_KEY = 'show-plan';
export const LANGUAGE_KEY = 'language';
export const LEGACY_CONFIG_DIR_KEY = 'claude-config-dir';
export const ACCOUNT_DIRS_KEY = 'account-dirs';
export const SHOWN_DIRS_KEY = 'shown-account-dirs';

export const THRESHOLDS = [
    {level: 'warning', percent: 75, percentKey: 'warning-percent', notifyKey: 'warning-notify'},
    {level: 'critical', percent: 90, percentKey: 'critical-percent', notifyKey: 'critical-notify'},
];

const KINDS = {session: 'session', weekly_all: 'weekly'};

export function scopeForKind(kind) {
    return KINDS[kind] ?? 'scoped';
}

function levelFrom(get, level) {
    return Object.freeze({percent: get.int(level.percentKey), notify: get.boolean(level.notifyKey)});
}

function visibilityFrom(get) {
    return Object.freeze(Object.fromEntries(SCOPES.map(scope =>
        [scope.id, Object.freeze({bar: get.boolean(scope.barKey), menu: get.boolean(scope.menuKey)})])));
}

export function readSettings(get) {
    return Object.freeze(Object.assign(
        Object.fromEntries(THRESHOLDS.map(level => [level.level, levelFrom(get, level)])),
        {visible: visibilityFrom(get), account: get.boolean(ACCOUNT_KEY), plan: get.boolean(PLAN_KEY)}));
}

export const KEYS = THRESHOLDS.flatMap(level => [level.percentKey, level.notifyKey])
    .concat(SCOPES.flatMap(scope => [scope.barKey, scope.menuKey]));

// Clearing the legacy key is what makes this run once: left set, every enable() would
// overwrite whatever the user has listed since. The default directory stays listed,
// hidden, because the single-directory choice always offered it.
export function migrateConfigDir(store) {
    const legacy = store.string(LEGACY_CONFIG_DIR_KEY);
    if (legacy === '')
        return false;
    store.setStrv(ACCOUNT_DIRS_KEY, [legacy, '']);
    store.setStrv(SHOWN_DIRS_KEY, [legacy]);
    store.reset(LEGACY_CONFIG_DIR_KEY);
    return true;
}
