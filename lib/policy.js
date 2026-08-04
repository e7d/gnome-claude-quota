export const POLL_SECONDS = 300;
export const OPEN_REFRESH_SECONDS = 60;

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
