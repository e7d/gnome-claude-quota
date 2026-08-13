export const DEFAULT_WINDOW_MINUTES = 10;
export const CLUSTER_FRACTION = 0.5;
export const SPREAD_FRACTION = 0.5;

const HOUR_MS = 3600000;

function instants(attempts) {
    return attempts
        .map(record => ({record, at: Date.parse(record.ts)}))
        .filter(({at}) => Number.isFinite(at));
}

function hourKey(at) {
    return new Date(at).toISOString().slice(0, 13);
}

export function hourlyRows(attempts, sessionStarts) {
    const stamped = instants(attempts);
    const marks = [...stamped.map(({at}) => at), ...sessionStarts];
    if (!marks.length)
        return [];
    const first = Math.floor(Math.min(...marks) / HOUR_MS) * HOUR_MS;
    const last = Math.floor(Math.max(...marks) / HOUR_MS) * HOUR_MS;
    const rows = [];
    for (let at = first; at <= last; at += HOUR_MS) {
        const hour = hourKey(at);
        rows.push({
            hour,
            attempts: stamped.filter(entry => hourKey(entry.at) === hour).length,
            rateLimited: stamped.filter(entry => hourKey(entry.at) === hour
                && entry.record.outcome === 'rate-limited').length,
            sessions: sessionStarts.filter(start => hourKey(start) === hour).length,
        });
    }
    return rows;
}

function nearAnyStart(at, sessionStarts, windowMs) {
    return sessionStarts.some(start => Math.abs(at - start) <= windowMs);
}

const RATE_LIMIT_PREFIXES = ['anthropic-ratelimit-', 'ratelimit-', 'x-ratelimit-'];

// The log keeps every header worth keeping, of which the allowance-bearing ones are
// a subset — counting a request-id as one would report a budget nobody stated.
// Records written before the field was renamed carry the old name.
function rateLimitOnly(headers) {
    return Object.fromEntries(Object.entries(headers)
        .filter(([name]) => RATE_LIMIT_PREFIXES.some(prefix => name.startsWith(prefix))));
}

function headersFrom(limitedAttempts) {
    return limitedAttempts
        .map(({record}) => rateLimitOnly(record.headers ?? record.rateLimitHeaders ?? {}))
        .findLast(headers => Object.keys(headers).length > 0) ?? {};
}

function spreadShare(stamped, limitedAttempts) {
    const hoursWithAttempts = new Set(stamped.map(({at}) => hourKey(at))).size;
    const hoursWith429 = new Set(limitedAttempts.map(({at}) => hourKey(at))).size;
    return {hoursWithAttempts, hoursWith429, share: hoursWithAttempts ? hoursWith429 / hoursWithAttempts : 0};
}

function label({stamped, limitedAttempts, headers, fraction, spread}) {
    if (!stamped.length)
        return 'no-data';
    if (!limitedAttempts.length)
        return 'no-429';
    if (Object.keys(headers).length)
        return 'rate-limit-headers';
    if (fraction >= CLUSTER_FRACTION)
        return 'sessions';
    return spread.share >= SPREAD_FRACTION ? 'own-cadence' : 'unattributed';
}

const TEXTS = {
    'no-data': 'no data yet — the log starts empty; re-run after a poll cycle',
    'no-429': 'no 429 observed in this window; cannot attribute',
    'rate-limit-headers': 'the endpoint reported its own allowance; read the headers below',
    'sessions': 'correlated with Claude Code sessions — local mitigation will not help',
    'own-cadence': 'consistent with our own cadence — raise POLL_SECONDS',
    'unattributed': 'unattributed; likely another device on the account',
};

export function verdict({attempts, sessionStarts, windowMinutes = DEFAULT_WINDOW_MINUTES}) {
    const stamped = instants(attempts);
    const limitedAttempts = stamped.filter(({record}) => record.outcome === 'rate-limited');
    const correlated = limitedAttempts
        .filter(({at}) => nearAnyStart(at, sessionStarts, windowMinutes * 60000)).length;
    const fraction = limitedAttempts.length ? correlated / limitedAttempts.length : 0;
    const headers = headersFrom(limitedAttempts);
    const spread = spreadShare(stamped, limitedAttempts);
    const name = label({stamped, limitedAttempts, headers, fraction, spread});
    return {
        label: name,
        text: TEXTS[name],
        attempts: stamped.length,
        rateLimited: limitedAttempts.length,
        sessions: sessionStarts.length,
        windowMinutes,
        correlated,
        fraction,
        headers,
        ...spread,
    };
}
