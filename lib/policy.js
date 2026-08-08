export const POLL_SECONDS = 300;
export const OPEN_REFRESH_SECONDS = 60;

// U+26A0 defaults to text presentation, so without the VS16 selector it renders
// monochrome at half the width of the other four and the line jitters.
const SERVICE_ISSUES = {
    degraded_performance: {emoji: '🐢', text: 'Degraded performance'},
    partial_outage: {emoji: '⚠️', text: 'Partial outage'},
    major_outage: {emoji: '🔴', text: 'Major outage'},
    under_maintenance: {emoji: '🚧', text: 'Under maintenance'},
};

// Reached when our own call failed but the status page disagrees, is unreachable,
// or answers something this map has never seen: the weakest claim still true.
export const SERVICE_ERROR = {emoji: '❗', text: 'Service error'};

export function serviceIssue(componentStatus) {
    if (componentStatus === null || componentStatus === undefined)
        return null;
    return SERVICE_ISSUES[componentStatus] ?? SERVICE_ERROR;
}

export function nextPollSeconds(retryAfterSeconds) {
    if (!retryAfterSeconds)
        return POLL_SECONDS;
    return Math.max(POLL_SECONDS, Math.ceil(retryAfterSeconds) + 5);
}

export function blockedUntil(retryAfterSeconds, now) {
    if (!retryAfterSeconds)
        return null;
    return new Date(now.getTime() + (Math.ceil(retryAfterSeconds) + 5) * 1000);
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
