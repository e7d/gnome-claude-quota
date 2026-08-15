import {readdirSync, readFileSync} from 'node:fs';

const EXEMPT = ['lib/usage.js'];
const FLOORS = {lines: 100, branches: 95, functions: 100};

export function census(lcov, modules, exempt) {
    const covered = new Set(lcov.split('\n')
        .filter(line => line.startsWith('SF:'))
        .map(line => line.slice(3).replace(/^.*?(?=lib\/)/, '')));
    return modules.filter(module => !covered.has(module) && !exempt.includes(module));
}

function field(block, name) {
    return Number(block.match(new RegExp(`^${name}:(\\d+)$`, 'm'))?.[1] ?? 0);
}

function record(block) {
    const file = block.match(/^SF:(.*)$/m)[1].replace(/^.*?(?=lib\/)/, '');
    return {
        file,
        lf: field(block, 'LF'), lh: field(block, 'LH'),
        brf: field(block, 'BRF'), brh: field(block, 'BRH'),
        fnf: field(block, 'FNF'), fnh: field(block, 'FNH'),
    };
}

function rate(hit, found) {
    return found === 0 ? 100 : (hit / found) * 100;
}

function shortfalls({lf, lh, brf, brh, fnf, fnh}, floors) {
    const checks = [
        ['lines', rate(lh, lf), floors.lines],
        ['branches', rate(brh, brf), floors.branches],
        ['functions', rate(fnh, fnf), floors.functions],
    ];
    return checks
        .filter(([, actual, floor]) => actual < floor)
        .map(([label, actual, floor]) => `${label} ${actual.toFixed(2)}% < ${floor}%`);
}

export function perFileFloors(lcov, exempt, floors = FLOORS) {
    return lcov.split('end_of_record')
        .filter(block => block.includes('SF:'))
        .map(record)
        .filter(rec => !exempt.includes(rec.file))
        .map(rec => ({file: rec.file, issues: shortfalls(rec, floors)}))
        .filter(entry => entry.issues.length > 0);
}

function main() {
    const modules = readdirSync('lib')
        .filter(name => name.endsWith('.js'))
        .map(name => `lib/${name}`);
    const lcov = readFileSync('coverage/lcov.info', 'utf8');
    const missing = census(lcov, modules, EXEMPT);
    const shortfallsByFile = perFileFloors(lcov, EXEMPT, FLOORS);
    if (missing.length === 0 && shortfallsByFile.length === 0)
        return;
    if (missing.length > 0) {
        console.error(`no test imports: ${missing.join(', ')}`);
        console.error('every lib module must be reachable from the suite, or named exempt here');
    }
    for (const {file, issues} of shortfallsByFile)
        console.error(`${file}: below floor on ${issues.join(', ')}`);
    process.exit(1);
}

if (process.argv[1]?.endsWith('coverage-census.js'))
    main();
