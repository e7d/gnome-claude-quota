import assert from 'node:assert/strict';
import {test} from 'node:test';

import {WINDOW_LENGTH_MS, absoluteTime, captionLine, refreshLine, relativeDuration, windowProgress} from '../lib/format.js';

const now = new Date('2026-08-04T07:51:00Z');

test('captionLine pairs the remaining time with the reset time', () => {
    const quota = {resetsAt: new Date('2026-08-04T11:59:00Z')};
    assert.equal(captionLine(quota, now, 'en-US'), '4h 08m left · 11:59 AM');
});

test('relativeDuration renders days and hours past a day', () => {
    assert.equal(relativeDuration(new Date('2026-08-08T07:59:00Z'), now), '4d 0h');
});

test('relativeDuration zero-pads the minutes below a day', () => {
    assert.equal(relativeDuration(new Date('2026-08-04T11:59:00Z'), now), '4h 08m');
});

test('relativeDuration drops to minutes below an hour', () => {
    assert.equal(relativeDuration(new Date('2026-08-04T08:03:00Z'), now), '12m');
});

test('relativeDuration reports a minute while any time remains', () => {
    assert.equal(relativeDuration(new Date('2026-08-04T07:51:30Z'), now), '1m');
});

test('relativeDuration collapses to now at and past the reset', () => {
    assert.equal(relativeDuration(now, now), 'now');
    assert.equal(relativeDuration(new Date('2026-08-04T07:00:00Z'), now), 'now');
});

test('absoluteTime shows only the time when the reset is today', () => {
    assert.equal(absoluteTime(new Date('2026-08-04T11:59:00Z'), now, 'en-GB'), '11:59');
});

test('absoluteTime adds the weekday on another day', () => {
    const text = absoluteTime(new Date('2026-08-08T07:59:00Z'), now, 'en-GB');
    assert.match(text, /Sat/);
    assert.match(text, /07:59/);
});

test('absoluteTime has no leading zero on the hour in a 12-hour locale', () => {
    const text = absoluteTime(new Date('2026-08-04T14:00:00Z'), now, 'en-US');
    assert.equal(text, '2:00 PM');
});

test('refreshLine names the time of the last fetch', () => {
    assert.equal(refreshLine(new Date('2026-08-04T07:44:00Z'), now, 'en-GB'), 'Last refresh: 7:44');
});

test('refreshLine still reports before any fetch has landed', () => {
    assert.equal(refreshLine(null, now, 'en-GB'), 'Last refresh: -');
});

test('windowProgress measures elapsed time in the session window', () => {
    const value = windowProgress(new Date('2026-08-04T11:59:00Z'), now, WINDOW_LENGTH_MS.session);
    assert.equal(Math.round(value * 100), 17);
});

test('windowProgress measures elapsed time in the weekly window', () => {
    const value = windowProgress(new Date('2026-08-08T07:59:00Z'), now, WINDOW_LENGTH_MS.weekly);
    assert.equal(Math.round(value * 100), 43);
});

test('windowProgress clamps a reset already in the past', () => {
    assert.equal(windowProgress(new Date('2026-08-04T07:00:00Z'), now, WINDOW_LENGTH_MS.session), 1);
});

test('windowProgress is null without a reset time', () => {
    assert.equal(windowProgress(null, now, WINDOW_LENGTH_MS.weekly), null);
});


