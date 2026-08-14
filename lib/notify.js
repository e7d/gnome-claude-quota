import {captionLine, percentLine} from './format.js';
import {_, format} from './i18n.js';

export const HYSTERESIS = 2;
export const NOTIFY_DEFAULTS = {warning: 75, critical: 90};
export const REFRESH_SECONDS = 60;

const LEVELS = ['warning', 'critical'];
const REFRESH_MS = REFRESH_SECONDS * 1000;
const BOUNDARY_MARGIN_MS = 250;

// Aligned to the wall clock rather than to whenever the first alert happened to post: the
// body counts whole minutes, so a tick landing mid-minute renders a figure already up to a
// minute stale, and the panel clock ticking over while the tray still reads the old value is
// exactly the mismatch this refresh exists to remove. The margin keeps a timer that fires a
// hair early from recomputing the minute it just left.
export function refreshDelayMs(now) {
    return REFRESH_MS - (now.getTime() % REFRESH_MS) + BOUNDARY_MARGIN_MS;
}

export function thresholdsFrom({warning, critical}) {
    return [
        {level: 'warning', percent: warning.percent, enabled: warning.notify},
        {level: 'critical', percent: critical.percent, enabled: critical.notify},
    ];
}

function windowOf(quota) {
    return quota.resetsAt === null ? '' : quota.resetsAt.toISOString();
}

function armed(quota, threshold) {
    return threshold.enabled && !quota.expired && Number.isFinite(quota.percent);
}

function stale(quota, threshold, entry) {
    if (entry === undefined)
        return false;
    if (!armed(quota, threshold))
        return true;
    return entry.window !== windowOf(quota) ||
        quota.percent <= threshold.percent - HYSTERESIS;
}

function fires(quota, threshold, entry) {
    return entry === undefined && armed(quota, threshold) &&
        quota.percent >= threshold.percent;
}

// captionLine's dash is a placeholder holding a table column open; as the whole body
// of a notification it says nothing, so a quota with no reset time gets no body.
function alertText(quota, {now, locale, percentLocale}) {
    const caption = captionLine(quota, now, locale);
    return {
        title: format(_('{name} at {percent}'), {
            name: quota.name,
            percent: percentLine(quota, percentLocale),
        }),
        body: caption === '-' ? '' : caption,
    };
}

// Thresholds outermost so warning is always evaluated before critical, which
// Task 4's supersede rule relies on.
function pairs(quotas, thresholds) {
    return thresholds.flatMap(threshold => quotas.map(quota => ({quota, threshold})));
}

function copyFired(fired) {
    return Object.fromEntries(Object.entries(fired).map(([key, entry]) => [key, {...entry}]));
}

// A model-scoped limit leaves the payload entirely when its window resets to 0 %, so
// the pairs below can no longer reach its entry and its banner would sit in the tray
// reading a percentage that expired days ago. An empty list is a payload that has not
// arrived yet, not one holding no quotas, so it prunes nothing.
function pruneOrphans(quotas, fired) {
    if (quotas.length === 0)
        return [];
    const known = new Set(quotas.map(quota => quota.key));
    const orphans = Object.keys(fired).filter(key => !known.has(key.slice(0, key.lastIndexOf('|'))));
    orphans.forEach(key => delete fired[key]);
    return orphans;
}

const CRITICAL_SUFFIX = '|critical';

function criticalQuotas(fired) {
    return new Set(Object.keys(fired)
        .filter(key => key.endsWith(CRITICAL_SUFFIX))
        .map(key => key.slice(0, -CRITICAL_SUFFIX.length)));
}

function supersede({post, withdraw, fired}) {
    const live = criticalQuotas(fired);
    const shadowed = post
        .filter(alert => live.has(alert.quotaKey))
        .map(alert => `${alert.quotaKey}|warning`);
    return {
        fired,
        post: post.filter(alert => alert.level !== 'warning' || !live.has(alert.quotaKey)),
        withdraw: [...new Set([...withdraw, ...shadowed])],
    };
}

// A notification's body counts down and its title carries a percentage, so both are
// wrong the minute after they are written — and a poll that moves a quota rewrites
// neither. This re-derives the text of everything still on record, which is what makes
// the tray agree with the popup rather than with the moment it fired.
export function alertRefresh({quotas, fired, now, locale, percentLocale}) {
    return quotas.flatMap(quota => LEVELS
        .filter(level => Object.hasOwn(fired, `${quota.key}|${level}`))
        .map(level => Object.assign({key: `${quota.key}|${level}`},
            alertText(quota, {now, locale, percentLocale}))));
}

export function alertPlan({quotas, fired, thresholds, now, locale, percentLocale}) {
    const next = copyFired(fired);
    const withdraw = pruneOrphans(quotas, next);
    const post = [];
    pairs(quotas, thresholds).forEach(({quota, threshold}) => {
        const key = `${quota.key}|${threshold.level}`;
        if (stale(quota, threshold, next[key])) {
            delete next[key];
            withdraw.push(key);
        }
        if (!fires(quota, threshold, next[key]))
            return;
        next[key] = {window: windowOf(quota)};
        post.push({key, quotaKey: quota.key, level: threshold.level,
            ...alertText(quota, {now, locale, percentLocale})});
    });
    return supersede({post, withdraw, fired: next});
}
