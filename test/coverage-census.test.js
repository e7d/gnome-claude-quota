import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {census, perFileFloors} from '../tools/coverage-census.js';

const LCOV = ['SF:lib/model.js', 'end_of_record', 'SF:lib/policy.js', 'end_of_record'].join('\n');
const FLOORS = {lines: 100, branches: 95, functions: 100};

function record(file, {brf, brh, lf = 10, lh = 10, fnf = 1, fnh = 1}) {
    return [
        `SF:${file}`, `FNF:${fnf}`, `FNH:${fnh}`,
        `BRF:${brf}`, `BRH:${brh}`, `LF:${lf}`, `LH:${lh}`, 'end_of_record',
    ].join('\n');
}

test('census is silent when every module appears in the report', () => {
    assert.deepEqual(census(LCOV, ['lib/model.js', 'lib/policy.js'], []), []);
});

test('census names a module the report never mentions', () => {
    assert.deepEqual(census(LCOV, ['lib/model.js', 'lib/orphan.js'], []), ['lib/orphan.js']);
});

test('census forgives a module named as exempt', () => {
    assert.deepEqual(census(LCOV, ['lib/model.js', 'lib/usage.js'], ['lib/usage.js']), []);
});

test('census tolerates absolute paths in the report', () => {
    const absolute = 'SF:/home/x/claude-quota/lib/model.js\nend_of_record';
    assert.deepEqual(census(absolute, ['lib/model.js'], []), []);
});

test('perFileFloors reports a file below the branch floor', () => {
    const lcov = record('lib/model.js', {brf: 100, brh: 94});
    const failures = perFileFloors(lcov, [], FLOORS);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].file, 'lib/model.js');
    assert.match(failures[0].issues[0], /branches 94\.00% < 95%/);
});

test('perFileFloors does not report a file exactly at the branch floor', () => {
    const lcov = record('lib/model.js', {brf: 100, brh: 95});
    assert.deepEqual(perFileFloors(lcov, [], FLOORS), []);
});

test('perFileFloors skips a file named as exempt', () => {
    const lcov = record('lib/usage.js', {brf: 100, brh: 50});
    assert.deepEqual(perFileFloors(lcov, ['lib/usage.js'], FLOORS), []);
});

test('perFileFloors does not divide by zero or report a file with no branches', () => {
    const lcov = record('lib/panel.js', {brf: 0, brh: 0});
    assert.deepEqual(perFileFloors(lcov, [], FLOORS), []);
});
