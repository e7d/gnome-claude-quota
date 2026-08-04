import {WINDOW_LENGTH_MS, windowProgress} from './format.js';

const ALWAYS_VISIBLE = new Set(['session', 'weekly_all']);
const KNOWN_SEVERITIES = new Set(['warning', 'critical']);
const NAMES = {session: 'Session', weekly_all: 'Weekly'};
const SHORTS = {session: 'S', weekly_all: 'W'};
const RESERVED_SHORTS = new Set(Object.values(SHORTS));

function quotaName(limit) {
    return NAMES[limit.kind] ?? limit.scope?.model?.display_name ?? limit.kind;
}

function shortLabel(kind, name) {
    if (SHORTS[kind])
        return SHORTS[kind];
    const initial = name.slice(0, 1).toUpperCase();
    return RESERVED_SHORTS.has(initial) ? initial + name.slice(1, 2).toLowerCase() : initial;
}

export function quotas(payload, now) {
    return (payload?.limits ?? [])
        .filter(limit => ALWAYS_VISIBLE.has(limit.kind) || limit.percent > 0)
        .map(limit => {
            const name = quotaName(limit);
            const resetsAt = limit.resets_at ? new Date(limit.resets_at) : null;
            const windowMs = WINDOW_LENGTH_MS[limit.group] ?? WINDOW_LENGTH_MS.weekly;
            return {
                short: shortLabel(limit.kind, name),
                name,
                percent: limit.percent,
                severity: KNOWN_SEVERITIES.has(limit.severity) ? limit.severity : 'normal',
                resetsAt,
                windowProgress: windowProgress(resetsAt, now, windowMs),
            };
        });
}
