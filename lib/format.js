const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const WINDOW_LENGTH_MS = {
    session: 5 * HOUR,
    weekly: 7 * DAY,
};

// Intl resolves its default from LANG alone, so a desktop running LANG=en_US with
// LC_TIME=fr_FR formats every clock reading in the wrong convention.
export function timeLocale(env) {
    const posix = env.LC_ALL || env.LC_TIME || env.LANG || '';
    const tag = posix.split('.')[0].split('@')[0].replace('_', '-');
    if (tag === '' || tag === 'C' || tag === 'POSIX')
        return undefined;
    return tag;
}

export function relativeDuration(target, now) {
    const remaining = target - now;
    if (remaining <= 0)
        return 'now';
    if (remaining >= DAY)
        return `${Math.floor(remaining / DAY)}d ${Math.floor((remaining % DAY) / HOUR)}h`;
    if (remaining >= HOUR) {
        const minutes = Math.floor((remaining % HOUR) / MINUTE);
        return `${Math.floor(remaining / HOUR)}h ${String(minutes).padStart(2, '0')}m`;
    }
    return `${Math.max(1, Math.floor(remaining / MINUTE))}m`;
}

export function absoluteTime(target, now, locale = undefined) {
    const sameDay = target.getFullYear() === now.getFullYear() &&
        target.getMonth() === now.getMonth() &&
        target.getDate() === now.getDate();
    const options = {hour: 'numeric', minute: '2-digit'};
    if (!sameDay)
        options.weekday = 'short';
    return new Intl.DateTimeFormat(locale, options).format(target);
}

export function percentLine(quota) {
    if (quota.expired || !Number.isFinite(quota.percent))
        return '-';
    return `${quota.percent}%`;
}

export function captionLine(quota, now, locale = undefined) {
    if (quota.expired || !quota.resetsAt)
        return '-';
    return `${relativeDuration(quota.resetsAt, now)} left · ${absoluteTime(quota.resetsAt, now, locale)}`;
}

export function refreshLine(fetchedAt, now, locale = undefined) {
    if (fetchedAt === null)
        return 'Last refresh: -';
    return `Last refresh: ${absoluteTime(fetchedAt, now, locale)}`;
}

export function windowProgress(resetsAt, now, windowMs) {
    if (!resetsAt)
        return null;
    const elapsed = 1 - (resetsAt - now) / windowMs;
    return Math.min(1, Math.max(0, elapsed));
}

