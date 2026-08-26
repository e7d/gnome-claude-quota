import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {scanImage, severityInks, tickFindings, toHex} from './lib/contrast.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'preview');
const STYLESHEET = join(ROOT, 'stylesheet.css');
const SEVERITY_INKS = severityInks(readFileSync(STYLESHEET, 'utf8')).map(toHex);

function readImage(path) {
    const size = execFileSync('magick', ['identify', '-format', '%w %h\n', path], {encoding: 'utf8'});
    const [width, height] = size.split('\n')[0].split(' ').map(Number);
    if (!(width > 0) || !(height > 0))
        throw new Error(`${path}: could not measure the image`);
    const pixels = execFileSync('magick', [path, '-depth', '8', 'RGBA:-'], {maxBuffer: width * height * 4 + 4096});
    if (pixels.length !== width * height * 4)
        throw new Error(`${path}: expected ${width * height * 4} bytes of RGBA, read ${pixels.length}`);
    return {width, height, pixels};
}

// A notify- tile frames the shell's own banner and message list, whose colours are
// GNOME's rather than ours. Scoring them would report findings that the standing rule
// forbids acting on: change what is ours, leave what is GNOME's.
function scorable(name) {
    return name.endsWith('.png') && name !== 'overview.png' && !name.startsWith('notify-');
}

function targets(args) {
    if (args.length)
        return args.map(path => resolve(path));
    return readdirSync(SHOTS)
        .filter(scorable)
        .toSorted()
        .map(name => join(SHOTS, name));
}

const TRANSIENT_PANEL_PILL_SURFACES = ['#474747', '#bdbdbf', '#2b2b2b', '#d5d5d7'];

const CI_PANEL_PILL_SURFACES = ['#5e5e61', '#46464a'];

// Both halves are required. Darkening a severity colour until it clears 4.5:1 on a pill the
// pointer paints for a moment turns amber into brown and destroys the meaning the colour
// exists to carry — a trade no other ink can claim, so no other ink is waived on it.
function accepted(finding) {
    return SEVERITY_INKS.some(ink => near(finding.ink, ink)) &&
        [...TRANSIENT_PANEL_PILL_SURFACES, ...CI_PANEL_PILL_SURFACES]
            .some(surface => near(finding.background, surface));
}

function near(color, hex) {
    const want = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return [color.red, color.green, color.blue]
        .every((channel, index) => Math.abs(channel - want[index]) <= 12);
}

function describe(finding) {
    return `${finding.ratio.toFixed(2)}:1 under ${finding.threshold.ratio}:1 (${finding.threshold.label})`
        + `  ${toHex(finding.ink)} on ${toHex(finding.background)}`
        + `  at ${finding.x},${finding.y} in ${finding.windows} window(s)`;
}

function report(path) {
    const {findings} = scanImage(readImage(path));
    const under = findings.filter(finding => finding.ratio < finding.threshold.ratio);
    const failed = under.filter(finding => !accepted(finding))
        .toSorted((one, other) => one.ratio - other.ratio);
    const waived = under.filter(accepted);
    console.log(`${basename(path)}: ${findings.length} pair(s) measured, ${failed.length} under threshold`
        + (waived.length ? `, ${waived.length} accepted` : ''));
    for (const finding of failed)
        console.log(`  ${describe(finding)}`);
    // A waiver nobody can read is a threshold quietly lowered, so each one says what it let
    // through — the whole point of accepting a pair rather than dropping the measurement.
    for (const finding of waived)
        console.log(`  accepted: ${describe(finding)}`);
    return failed.length;
}

function reportTick() {
    const findings = tickFindings(readFileSync(STYLESHEET, 'utf8'));
    const failed = findings.filter(finding => finding.ratio < finding.threshold.ratio);
    console.log(`pace tick: ${findings.length} pair(s) measured, ${failed.length} under threshold`);
    for (const finding of findings) {
        console.log(`  ${finding.label}: ${finding.ratio.toFixed(2)}:1`
            + ` (${finding.threshold.ratio}:1 ${finding.threshold.label})`
            + `  ${toHex(finding.ink)} on ${toHex(finding.background)}`);
    }
    return failed.length;
}

function main(args) {
    const files = targets(args);
    if (!files.length)
        throw new Error(`no screenshots in ${SHOTS}; run npm run preview first`);
    const failed = files.reduce((total, path) => total + report(path), 0) + reportTick();
    console.log(`${files.length} file(s), ${failed} finding(s) under threshold`);
    return failed ? 1 : 0;
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (error) {
    console.error(`a11y: ${error.message}`);
    process.exitCode = 2;
}
