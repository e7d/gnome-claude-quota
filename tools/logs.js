import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {parseLog} from '../lib/attempts.js';
import {OUTCOMES, formatDetail, formatRow, refusalRuns, selectRecords, summarize} from './lib/log-view.js';

const ATTEMPTS = join(homedir(), '.cache', 'claude-quota', 'attempts.jsonl');

function usage() {
    console.log(`Usage: tools/logs.js [options]

Prints the extension's exchange log: one line per request it made or declined to
make, against api.anthropic.com and status.claude.com.

Options:
  --since=<ISO>        Keep records at or after this instant (default: today)
  --until=<ISO>        Keep records at or before this instant
  --all                Every record in the log, whatever its date
  --outcome=<name>     One of ${OUTCOMES.join(', ')}
  --endpoint=<name>    usage or status
  --tail=<n>           Only the last n matching records
  --detail             Also print response headers and error bodies
  --runs               Collapse consecutive equal outcomes into runs
  --path=<file>        Log to read (default ${ATTEMPTS})
  -h, --help           Show this message`);
}

function today() {
    return new Date().toISOString().slice(0, 10);
}

function options(args) {
    const chosen = {path: ATTEMPTS, since: today(), detail: false, runs: false, help: false};
    for (const arg of args) {
        const value = arg.slice(arg.indexOf('=') + 1);
        if (arg.startsWith('--since='))
            chosen.since = value;
        else if (arg.startsWith('--until='))
            chosen.until = value;
        else if (arg === '--all')
            chosen.since = '';
        else if (arg.startsWith('--outcome='))
            chosen.outcome = value;
        else if (arg.startsWith('--endpoint='))
            chosen.endpoint = value;
        else if (arg.startsWith('--tail='))
            chosen.tail = Number.parseInt(value, 10);
        else if (arg.startsWith('--path='))
            chosen.path = value;
        else if (arg === '--detail')
            chosen.detail = true;
        else if (arg === '--runs')
            chosen.runs = true;
        else if (arg === '-h' || arg === '--help')
            chosen.help = true;
        else
            throw new Error(`unknown option ${arg}`);
    }
    return chosen;
}

function read(path) {
    try {
        return parseLog(readFileSync(path, 'utf8'));
    } catch {
        throw new Error(`cannot read ${path} — the extension writes it on its first attempt`);
    }
}

function printRuns(records) {
    for (const run of refusalRuns(records))
        console.log(`${run.from} → ${run.to}  ${String(run.count).padStart(4)} × ${run.outcome}`);
}

function printRows(records, detail) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const record of records) {
        console.log(formatRow(record, zone));
        if (detail)
            formatDetail(record).forEach(line => console.log(line));
    }
}

function printSummary(records) {
    const {total, byOutcome} = summarize(records);
    const parts = Object.entries(byOutcome).map(([outcome, count]) => `${count} ${outcome}`);
    console.log(`\n${total} record(s): ${parts.join(', ') || 'none'}`);
}

function main(args) {
    const chosen = options(args);
    if (chosen.help) {
        usage();
        return 0;
    }
    const records = selectRecords(read(chosen.path), chosen);
    if (chosen.runs)
        printRuns(records);
    else
        printRows(records, chosen.detail);
    printSummary(records);
    return 0;
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (error) {
    console.error(`logs: ${error.message}`);
    process.exitCode = 2;
}
