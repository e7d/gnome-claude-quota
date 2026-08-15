import {readdirSync, readFileSync} from 'node:fs';

const EXEMPT = ['lib/usage.js'];

export function census(lcov, modules, exempt) {
    const covered = new Set(lcov.split('\n')
        .filter(line => line.startsWith('SF:'))
        .map(line => line.slice(3).replace(/^.*?(?=lib\/)/, '')));
    return modules.filter(module => !covered.has(module) && !exempt.includes(module));
}

function main() {
    const modules = readdirSync('lib')
        .filter(name => name.endsWith('.js'))
        .map(name => `lib/${name}`);
    const missing = census(readFileSync('coverage/lcov.info', 'utf8'), modules, EXEMPT);
    if (missing.length === 0)
        return;
    console.error(`no test imports: ${missing.join(', ')}`);
    console.error('every lib module must be reachable from the suite, or named exempt here');
    process.exit(1);
}

if (process.argv[1]?.endsWith('coverage-census.js'))
    main();
