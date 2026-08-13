export const OUTCOMES = ['ok', 'rate-limited', 'unauthorized', 'token-expired', 'error'];

export function selectRecords(records, {since, until, outcome, endpoint, tail} = {}) {
    const kept = records.filter(record => record.ts >= (since ?? '')
        && (until === undefined || record.ts <= until)
        && (outcome === undefined || record.outcome === outcome)
        && (endpoint === undefined || (record.endpoint ?? 'usage') === endpoint));
    return tail === undefined ? kept : kept.slice(-tail);
}

export function summarize(records) {
    const byOutcome = {};
    for (const record of records)
        byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
    return {total: records.length, byOutcome};
}

export function refusalRuns(records) {
    const runs = [];
    for (const record of records) {
        const last = runs.at(-1);
        if (last?.outcome === record.outcome)
            last.count += 1;
        else
            runs.push({outcome: record.outcome, from: record.ts, count: 1});
        runs.at(-1).to = record.ts;
    }
    return runs;
}

function localTime(ts, timeZone) {
    return new Date(ts).toLocaleTimeString('en-GB', {timeZone, hour12: false});
}

function column(value, width) {
    return String(value ?? '-').padEnd(width);
}

function present(value) {
    return value !== null && value !== undefined;
}

export function formatRow(record, timeZone) {
    return [
        localTime(record.ts, timeZone),
        column(record.endpoint ?? 'usage', 6),
        column(record.trigger, 12),
        column(record.outcome, 13),
        column(record.status, 4),
        column(present(record.retryAfter) ? `ra=${record.retryAfter}` : null, 9),
        column(present(record.durationMs) ? `${record.durationMs}ms` : null, 7),
        tokenNote(record),
    ].join(' ').trimEnd();
}

function tokenNote(record) {
    if (record.tokenExpired === true)
        return 'token=expired';
    if (record.tokenExpiresAt === null || record.tokenExpiresAt === undefined)
        return '';
    return `token=valid until ${record.tokenExpiresAt}`;
}

export function formatDetail(record) {
    const headers = Object.entries(record.headers ?? {}).map(([name, value]) => `      ${name}: ${value}`);
    const body = record.body ? [`      body: ${record.body}`] : [];
    return [...headers, ...body];
}
