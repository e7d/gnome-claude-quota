import {readFileSync, readdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {parseLog} from '../lib/attempts.js';
import {CLUSTER_FRACTION, DEFAULT_WINDOW_MINUTES, SPREAD_FRACTION, hourlyRows, verdict} from './lib/attribution.js';

const ATTEMPTS = join(homedir(), '.cache', 'claude-quota', 'attempts.jsonl');
const TRANSCRIPTS = join(homedir(), '.claude', 'projects');

function usage() {
    console.log(`Usage: tools/quota-attribution.js [options]

Joins this extension's attempts log against Claude Code session starts and
attributes the 429s it finds. Reads transcript metadata only, never contents.

Options:
  --window=<minutes>   Correlation window either side of a session start (default ${DEFAULT_WINDOW_MINUTES})
  --attempts=<path>    Attempts log to read (default ${ATTEMPTS})
  --sessions=<dir>     Transcript tree to stat (default ${TRANSCRIPTS})
  -h, --help           Show this message`);
}

function options(args) {
    const chosen = {windowMinutes: DEFAULT_WINDOW_MINUTES, attempts: ATTEMPTS, sessions: TRANSCRIPTS, help: false};
    for (const arg of args) {
        const value = arg.slice(arg.indexOf('=') + 1);
        if (arg.startsWith('--window='))
            chosen.windowMinutes = Number.parseFloat(value);
        else if (arg.startsWith('--attempts='))
            chosen.attempts = value;
        else if (arg.startsWith('--sessions='))
            chosen.sessions = value;
        else if (arg === '-h' || arg === '--help')
            chosen.help = true;
        else
            throw new Error(`unknown option ${arg}`);
    }
    if (!(chosen.windowMinutes > 0))
        throw new Error('--window needs a positive number of minutes');
    return chosen;
}

function readAttempts(path) {
    try {
        return parseLog(readFileSync(path, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}

function transcripts(dir) {
    let entries;
    try {
        entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    return entries.flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory())
            return transcripts(path);
        return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : [];
    });
}

// A birth time of 0 means the filesystem does not carry one, and mtime answers a
// different question — so the column is renamed rather than quietly substituted.
function sessionStarts(dir) {
    const stats = transcripts(dir).map(path => statSync(path));
    const born = stats.map(stat => stat.birthtimeMs).filter(at => at > 0);
    if (born.length === stats.length)
        return {starts: born, column: 'sessions'};
    return {starts: stats.map(stat => stat.mtimeMs), column: 'last activity'};
}

function percent(fraction) {
    return `${Math.round(fraction * 100)}%`;
}

function printTable(rows, column) {
    console.log(`${'hour'.padEnd(16)}${'attempts'.padStart(10)}${'429'.padStart(6)}${column.padStart(15)}`);
    for (const row of rows) {
        console.log(row.hour.padEnd(16)
            + String(row.attempts).padStart(10)
            + String(row.rateLimited).padStart(6)
            + String(row.sessions).padStart(15));
    }
}

function printVerdict(answer) {
    console.log(`\nverdict: ${answer.text}`);
    console.log(`  ${answer.attempts} attempt(s) logged, ${answer.rateLimited} rate-limited,`
        + ` ${answer.sessions} session start(s) in range`);
    console.log(`  ${answer.correlated} of ${answer.rateLimited} 429(s) (${percent(answer.fraction)})`
        + ` within ±${answer.windowMinutes} min of a session start; cluster threshold ${percent(CLUSTER_FRACTION)}`);
    console.log(`  429s in ${answer.hoursWith429} of ${answer.hoursWithAttempts} hour(s) carrying attempts;`
        + ` spread threshold ${percent(SPREAD_FRACTION)}`);
    for (const [name, value] of Object.entries(answer.headers))
        console.log(`  ${name}: ${value}`);
}

function inRange(starts, attempts) {
    const stamps = attempts.map(record => Date.parse(record.ts)).filter(Number.isFinite);
    if (!stamps.length)
        return starts;
    const from = Math.min(...stamps);
    return starts.filter(at => at >= from);
}

function main(args) {
    const chosen = options(args);
    if (chosen.help) {
        usage();
        return 0;
    }
    const attempts = readAttempts(chosen.attempts);
    const {starts, column} = sessionStarts(chosen.sessions);
    const clipped = inRange(starts, attempts);
    printTable(hourlyRows(attempts, clipped), column);
    printVerdict(verdict({attempts, sessionStarts: clipped, windowMinutes: chosen.windowMinutes}));
    if (clipped.length !== starts.length)
        console.log(`  ${starts.length - clipped.length} session start(s) predate the log and were excluded`);
    return 0;
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (error) {
    console.error(`quota-attribution: ${error.message}`);
    process.exitCode = 2;
}
