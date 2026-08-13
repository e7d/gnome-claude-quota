export const MAX_RECORDS = 2000;
export const MAX_BODY_CHARS = 1000;

// Deny-by-default: a response may carry a Set-Cookie or an echoed credential, and
// an allowlist cannot leak the one header nobody thought of.
const LOGGED_HEADERS = new Set(['content-type', 'request-id', 'retry-after', 'x-should-retry']);
const LOGGED_PREFIXES = ['anthropic-ratelimit-', 'ratelimit-', 'x-ratelimit-'];

function logged(name) {
    return LOGGED_HEADERS.has(name) || LOGGED_PREFIXES.some(prefix => name.startsWith(prefix));
}

function finiteOrNull(value) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : null;
}

function loggedHeaders(headers) {
    return Object.fromEntries(Object.entries(headers ?? {})
        .map(([name, value]) => [name.toLowerCase(), String(value)])
        .filter(([name]) => logged(name))
        .toSorted(([one], [other]) => one.localeCompare(other)));
}

// The quota payload of a successful call is already kept in the cache file, so
// logging it again would only push the failures that matter out of the window.
function loggedBody(body, outcome) {
    if (outcome === 'ok' || typeof body !== 'string' || body === '')
        return null;
    return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…` : body;
}

function isoOrNull(date) {
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function attemptRecord({
    now, trigger, endpoint, outcome, status, retryAfter, headers, body, durationMs, tokenExpiresAt, tokenExpired,
}) {
    return {
        ts: now.toISOString(),
        trigger,
        endpoint: endpoint ?? null,
        outcome,
        status: finiteOrNull(status),
        retryAfter: finiteOrNull(retryAfter),
        durationMs: finiteOrNull(durationMs),
        tokenExpiresAt: isoOrNull(tokenExpiresAt),
        tokenExpired: tokenExpired ?? null,
        headers: loggedHeaders(headers),
        body: loggedBody(body, outcome),
    };
}

export function outcomeFor({error, rateLimited, status, expired}) {
    if (error === null)
        return 'ok';
    if (rateLimited)
        return 'rate-limited';
    if (expired)
        return 'token-expired';
    return status === 401 ? 'unauthorized' : 'error';
}

// A log not ending in a newline was interrupted mid-write, so its last line is a
// fragment: appending to it would glue two records into one unparseable third.
function wholeLines(text) {
    if (!text)
        return [];
    const lines = text.split('\n');
    lines.pop();
    return lines;
}

export function appendRecord(text, record) {
    const lines = [...wholeLines(text), JSON.stringify(record)];
    return `${lines.slice(-MAX_RECORDS).join('\n')}\n`;
}

export function parseLog(text) {
    return (text ? text.split('\n') : [])
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(record => record !== null && typeof record === 'object' && !Array.isArray(record)
            && typeof record.ts === 'string');
}
