import {WINDOW_LENGTH_MS, windowProgress} from './format.js';
import {N_, _, p_} from './i18n.js';

const CLAUDE_CODE_COMPONENT = 'yyzkbfz2thpt';
const MAINTENANCE_UNDERWAY = new Set(['in_progress', 'verifying']);
const PACE_MARGIN = 0.1;
const ALWAYS_VISIBLE = new Set(['session', 'weekly_all']);
const KNOWN_SEVERITIES = new Set(['warning', 'critical']);
const NAMES = {session: N_('Session (5h)'), weekly_all: N_('Weekly')};
const SHORTS = {
    session: () => p_('panel initial', 'S'),
    weekly_all: () => p_('panel initial', 'W'),
};

function quotaName(limit) {
    if (NAMES[limit.kind])
        return _(NAMES[limit.kind]);
    return limit.scope?.model?.display_name || limit.kind;
}

function assignShort(kind, name, used) {
    if (SHORTS[kind]) {
        const short = SHORTS[kind]();
        used.add(short);
        return short;
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

function componentStatus(payload) {
    const components = Array.isArray(payload?.components) ? payload.components : [];
    const component = components.find(entry => entry?.id === CLAUDE_CODE_COMPONENT);
    return typeof component?.status === 'string' ? component.status : null;
}

function coversClaudeCode(window) {
    return Array.isArray(window?.components) &&
        window.components.some(component => component?.id === CLAUDE_CODE_COMPONENT);
}

// An incident carries no end estimate — of the last fifty the page published, not one
// had a scheduled_until — so a maintenance window is the only unavailability whose end
// we can name. An overrun window has an end in the past, which is worse than no end.
function maintenanceEnd(payload, now) {
    const windows = Array.isArray(payload?.scheduled_maintenances) ? payload.scheduled_maintenances : [];
    const ends = windows
        .filter(window => MAINTENANCE_UNDERWAY.has(window?.status) && coversClaudeCode(window))
        .map(window => new Date(window.scheduled_until))
        .filter(end => !Number.isNaN(end.getTime()) && end > now);
    return ends.length === 0 ? null : new Date(Math.max(...ends));
}

export function claudeCodeService(payload, now) {
    return {status: componentStatus(payload), until: maintenanceEnd(payload, now)};
}

function quotaKey(limit) {
    const model = limit.scope?.model;
    const modelId = model?.id ?? model?.display_name ?? '';
    return modelId === '' ? limit.kind : `${limit.kind}:${modelId}`;
}

export function quotas(payload, now) {
    const used = new Set();
    const limits = Array.isArray(payload?.limits) ? payload.limits : [];
    return limits
        .filter(limit => ALWAYS_VISIBLE.has(limit.kind) || limit.percent > 0)
        .map(limit => {
            const name = quotaName(limit);
            const resetsAt = limit.resets_at ? new Date(limit.resets_at) : null;
            const windowMs = WINDOW_LENGTH_MS[limit.group] ?? WINDOW_LENGTH_MS.weekly;
            const progress = windowProgress(resetsAt, now, windowMs);
            return {
                key: quotaKey(limit),
                short: assignShort(limit.kind, name, used),
                name,
                modelScoped: !NAMES[limit.kind],
                percent: limit.percent,
                severity: KNOWN_SEVERITIES.has(limit.severity) ? limit.severity : 'normal',
                resetsAt,
                windowProgress: progress,
                aheadOfPace: progress !== null && limit.percent / 100 - progress > PACE_MARGIN,
            };
        });
}
