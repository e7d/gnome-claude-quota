const SUMMARY = /^(✅|❌) (\d+) passed, (\d+) failed$/;
const ABORT = /^❌ (control|FAIL)\b/;
const SUCCESS = 'success';
const MAX_ABORTS = 5;

function lastMatch(lines, pattern) {
    return lines.toReversed().map(line => pattern.exec(line)).find(match => match !== null) ?? null;
}

export function parseShard(text) {
    const lines = text.split('\n').map(line => line.trim());
    const aborts = lines.filter(line => ABORT.test(line)).slice(0, MAX_ABORTS);
    const summary = lastMatch(lines, SUMMARY);
    if (summary === null)
        return {status: 'no-summary', passed: 0, failed: 0, aborts};
    const [passed, failed] = [Number(summary[2]), Number(summary[3])];
    return {status: failed === 0 ? 'ok' : 'failed', passed, failed, aborts};
}

function sum(rows, key) {
    return rows.reduce((total, row) => total + row[key], 0);
}

export function summarizeShards(shards) {
    const rows = shards.map(({name, text}) => ({name, ...parseShard(text)}))
        .toSorted((a, b) => a.name.localeCompare(b.name));
    return {rows, passed: sum(rows, 'passed'), failed: sum(rows, 'failed')};
}

export function problemsOf({rows}, needs) {
    const jobs = Object.entries(needs).filter(([, need]) => need.result !== SUCCESS)
        .map(([name, need]) => `job ${name}: ${need.result}`);
    const missing = rows.length === 0 ? ['no e2e report was found'] : [];
    const shards = rows.filter(row => row.status !== 'ok').map(row => `e2e shard ${row.name}: ${row.status}`);
    return [...jobs, ...missing, ...shards];
}

function shardTable({rows, passed, failed}) {
    const lines = rows.map(row => `| ${row.name} | ${row.status} | ${row.passed} | ${row.failed} |`);
    return [
        '| shard | status | passed | failed |',
        '| --- | --- | ---: | ---: |',
        ...lines,
        `| **total** | | ${passed} | ${failed} |`,
    ];
}

function jobTable(needs) {
    const lines = Object.entries(needs).toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, need]) => `| ${name} | ${need.result} |`);
    return ['| job | result |', '| --- | --- |', ...lines];
}

function abortLines({rows}) {
    return rows.flatMap(row => row.aborts.map(line => `- ${row.name}: ${line}`));
}

export function buildReport({shards, needs}) {
    const summary = summarizeShards(shards);
    const problems = problemsOf(summary, needs);
    const aborts = abortLines(summary);
    const sections = [
        '## e2e', '', ...shardTable(summary), '',
        '## jobs', '', ...jobTable(needs),
        ...(aborts.length === 0 ? [] : ['', '## aborts', '', ...aborts]),
        ...(problems.length === 0 ? [] : ['', '## problems', '', ...problems.map(problem => `- ${problem}`)]),
    ];
    return {ok: problems.length === 0, markdown: `${sections.join('\n')}\n`};
}
