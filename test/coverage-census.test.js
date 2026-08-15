import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {census} from '../tools/coverage-census.js';

const LCOV = ['SF:lib/model.js', 'end_of_record', 'SF:lib/policy.js', 'end_of_record'].join('\n');

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
