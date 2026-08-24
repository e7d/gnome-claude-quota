import {N_, _} from './i18n.js';

export const POLL_SECONDS = 300;
export const OPEN_REFRESH_SECONDS = 60;
export const STATUS_POLL_SECONDS = 60;
// Five requests per five minutes is the whole allowance, and it is shared with
// Claude Code, which fetches on its own schedule. Two minutes between our own
// leaves room for the other tenant whatever a popup or a button asks for.
export const MIN_REQUEST_SECONDS = 120;
export const RATE_LIMIT_FLOOR_SECONDS = 60;
export const RATE_LIMIT_CAP_SECONDS = 900;

// U+26A0 defaults to text presentation, so without the VS16 selector it renders
// monochrome at half the width of the other four and the line jitters.
const SERVICE_ISSUES = {
    degraded_performance: {emoji: '🐢', text: N_('Degraded performance')},
    partial_outage: {emoji: '⚠️', text: N_('Partial outage')},
    major_outage: {emoji: '🔴', text: N_('Major outage')},
    under_maintenance: {emoji: '🚧', text: N_('Under maintenance')},
};

export const SERVICE_ERROR = {emoji: '🚨', text: N_('Service error')};

export function serviceIssue(componentStatus) {
    if (componentStatus === null || componentStatus === undefined)
        return null;
    const issue = SERVICE_ISSUES[componentStatus] ?? SERVICE_ERROR;
    return {emoji: issue.emoji, text: _(issue.text)};
}

export function nextPollSeconds(retryAfterSeconds) {
    if (!retryAfterSeconds)
        return POLL_SECONDS;
    return Math.max(POLL_SECONDS, Math.ceil(retryAfterSeconds) + 5);
}

// The endpoint answers 429 with retry-after: 0 and no rate-limit headers. Reading
// that as "no hint, no block" armed nothing, so every popup open and every timer
// tick sent another request the server refused, indefinitely.
export function rateLimitBlock(retryAfterSeconds, now, consecutive) {
    const seconds = retryAfterSeconds > 0
        ? Math.ceil(retryAfterSeconds) + 5
        : Math.min(RATE_LIMIT_FLOOR_SECONDS * 2 ** consecutive, RATE_LIMIT_CAP_SECONDS);
    return {seconds, until: new Date(now.getTime() + seconds * 1000)};
}

export const RATE_LIMIT = 'rate-limit';
export const UNAUTHORIZED = 'unauthorized';

// Both refusals have to stop us sending — four consecutive 401s earn the same
// hour-long block a request burst does — but only one of them is a throttle the
// user can wait out, so only one may claim the throttle line.
export function blockReason({rateLimited, expired, status}) {
    if (rateLimited)
        return RATE_LIMIT;
    if (!expired && status === 401)
        return UNAUTHORIZED;
    return null;
}

export function throttledUntil(block) {
    return block?.reason === RATE_LIMIT ? block.until : null;
}

// A manual click means "now", whatever the request costs; every other trigger has an
// age below which fetching only spends an allowance shared with Claude Code.
export function maxAgeFor(trigger) {
    if (trigger === 'manual')
        return 0;
    return trigger === 'popup-stale' ? OPEN_REFRESH_SECONDS : POLL_SECONDS;
}

export function pollDelay(fetchedAt, now, maxAgeSeconds) {
    if (!(fetchedAt instanceof Date) || Number.isNaN(fetchedAt.getTime()))
        return 0;
    const age = (now - fetchedAt) / 1000;
    return age >= maxAgeSeconds ? 0 : Math.ceil(maxAgeSeconds - age);
}

export function minIntervalWait(lastRequestAt, now, minSeconds = MIN_REQUEST_SECONDS) {
    if (!(lastRequestAt instanceof Date) || Number.isNaN(lastRequestAt.getTime()))
        return 0;
    const elapsed = (now - lastRequestAt) / 1000;
    return elapsed >= minSeconds ? 0 : Math.ceil(minSeconds - elapsed);
}

export function isBlocked(until, now) {
    return until instanceof Date && until > now;
}

export function shouldFetchOnOpen(fetchedAt, now, until) {
    if (isBlocked(until, now))
        return false;
    if (fetchedAt === null)
        return true;
    return (now - fetchedAt) / 1000 > OPEN_REFRESH_SECONDS;
}

export function markExpired(quotas, now) {
    return quotas.map(quota => ({
        ...quota,
        expired: quota.resetsAt !== null && quota.resetsAt <= now,
    }));
}

export function severityFor(percent, {warning, critical}) {
    if (!Number.isFinite(percent))
        return 'normal';
    if (percent >= critical)
        return 'critical';
    return percent >= warning ? 'warning' : 'normal';
}

export function markSeverity(quotas, thresholds) {
    return quotas.map(quota => ({
        ...quota,
        severity: quota.expired ? 'normal' : severityFor(quota.percent, thresholds),
    }));
}
