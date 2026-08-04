import {WINDOW_LENGTH_MS, windowProgress} from './format.js';

const ALWAYS_VISIBLE = new Set(['session', 'weekly_all']);
const KNOWN_SEVERITIES = new Set(['warning', 'critical']);
const NAMES = {session: 'Session', weekly_all: 'Weekly'};
const SHORTS = {session: 'S', weekly_all: 'W'};

function quotaName(limit) {
    return NAMES[limit.kind] ?? limit.scope?.model?.display_name ?? limit.kind;
}

function assignShort(kind, name, used) {
    if (SHORTS[kind]) {
        used.add(SHORTS[kind]);
        return SHORTS[kind];
    }
    let label = name.slice(0, 1).toUpperCase();
    let next = 1;
    while (used.has(label) && next < name.length) {
        label += name[next].toLowerCase();
        next += 1;
    }
    let suffix = 2;
    while (used.has(label)) {
        label = label + suffix;
        suffix += 1;
    }
    used.add(label);
    return label;
}

export function quotas(payload, now) {
    const used = new Set();
    return (payload?.limits ?? [])
        .filter(limit => ALWAYS_VISIBLE.has(limit.kind) || limit.percent > 0)
        .map(limit => {
            const name = quotaName(limit);
            const resetsAt = limit.resets_at ? new Date(limit.resets_at) : null;
            const windowMs = WINDOW_LENGTH_MS[limit.group] ?? WINDOW_LENGTH_MS.weekly;
            return {
                short: assignShort(limit.kind, name, used),
                name,
                percent: limit.percent,
                severity: KNOWN_SEVERITIES.has(limit.severity) ? limit.severity : 'normal',
                resetsAt,
                windowProgress: windowProgress(resetsAt, now, windowMs),
            };
        });
}
