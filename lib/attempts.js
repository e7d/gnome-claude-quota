export const MAX_RECORDS = 2000;

const RATE_LIMIT_PREFIX = 'anthropic-ratelimit-';

function finiteOrNull(value) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : null;
}

function rateLimitHeaders(headers) {
    return Object.fromEntries(Object.entries(headers ?? {})
        .map(([name, value]) => [name.toLowerCase(), String(value)])
        .filter(([name]) => name.startsWith(RATE_LIMIT_PREFIX))
        .toSorted(([one], [other]) => one.localeCompare(other)));
}

export function attemptRecord({now, trigger, outcome, status, retryAfter, headers}) {
    return {
        ts: now.toISOString(),
        trigger,
        outcome,
        status: finiteOrNull(status),
        retryAfter: finiteOrNull(retryAfter),
        rateLimitHeaders: rateLimitHeaders(headers),
    };
}

export function outcomeFor({error, rateLimited, status}) {
    if (error === null)
        return 'ok';
    if (rateLimited)
        return 'rate-limited';
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
