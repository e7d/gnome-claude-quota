import {N_} from './i18n.js';

export const SCOPES = [
    {id: 'session', name: N_('Session (5h)'), barKey: 'session-in-bar', menuKey: 'session-in-menu'},
    {id: 'weekly', name: N_('Weekly'), barKey: 'weekly-in-bar', menuKey: 'weekly-in-menu'},
    {id: 'scoped', name: N_('Model-specific'), barKey: 'scoped-in-bar', menuKey: 'scoped-in-menu'},
];

export const SCOPE_IDS = SCOPES.map(scope => scope.id);

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
        {visible: visibilityFrom(get)}));
}

export const KEYS = THRESHOLDS.flatMap(level => [level.percentKey, level.notifyKey])
    .concat(SCOPES.flatMap(scope => [scope.barKey, scope.menuKey]));
