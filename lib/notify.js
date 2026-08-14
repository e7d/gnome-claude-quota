import {captionLine, percentLine} from './format.js';
import {_, format} from './i18n.js';

export const HYSTERESIS = 2;
export const NOTIFY_DEFAULTS = {warning: 75, critical: 90};

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

function alertText(quota, {now, locale, percentLocale}) {
    return {
        title: format(_('{name} at {percent}'), {
            name: quota.name,
            percent: percentLine(quota, percentLocale),
        }),
        body: captionLine(quota, now, locale),
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

function supersede({post, withdraw, fired}) {
    const critical = new Set(post.filter(alert => alert.level === 'critical')
        .map(alert => alert.quotaKey));
    const shadowed = [...critical].map(quotaKey => `${quotaKey}|warning`);
    return {
        fired,
        post: post.filter(alert =>
            alert.level !== 'warning' || !critical.has(alert.quotaKey)),
        withdraw: [...new Set([...withdraw, ...shadowed])],
    };
}

export function alertPlan({quotas, fired, thresholds, now, locale, percentLocale}) {
    const next = copyFired(fired);
    const withdraw = [];
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
        post.push({
            key,
            quotaKey: quota.key,
            level: threshold.level,
            ...alertText(quota, {now, locale, percentLocale}),
        });
    });
    return supersede({post, withdraw, fired: next});
}
