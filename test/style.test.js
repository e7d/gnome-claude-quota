import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {barClass, quotaClass, severityClass} from '../lib/style.js';

test('severityClass leaves a normal quota on the base class alone', () => {
    assert.equal(severityClass('cq-percent', 'normal', 'dark'), 'cq-percent');
});

test('severityClass appends a scheme-qualified class for a warning', () => {
    assert.equal(severityClass('cq-percent', 'warning', 'light'), 'cq-percent cq-warning-light');
});

test('severityClass appends a scheme-qualified class for a critical', () => {
    assert.equal(severityClass('cq-percent', 'critical', 'dark'), 'cq-percent cq-critical-dark');
});

test('quotaClass reads the severity off the quota', () => {
    assert.equal(quotaClass('cq-panel-quota', {severity: 'critical'}, 'light'),
        'cq-panel-quota cq-critical-light');
});

test('barClass names the bar for its scheme', () => {
    assert.equal(barClass('dark'), 'cq-bar cq-bar-dark');
});
