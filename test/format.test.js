import assert from 'node:assert/strict';
import {test} from 'node:test';

import {WINDOW_LENGTH_MS, absoluteTime, captionLine, percentLine, rateLimitLine, rateLimitMessage, refreshLine, relativeDuration, timeLocale, windowProgress} from '../lib/format.js';

const now = new Date('2026-08-04T07:51:00Z');

test('captionLine pairs the remaining time with the reset time', () => {
    const quota = {resetsAt: new Date('2026-08-04T11:59:00Z')};
    assert.equal(captionLine(quota, now, 'en-US'), '4h 08m left · 11:59 AM');
});

test('captionLine falls back to a placeholder before a window has started', () => {
    assert.equal(captionLine({resetsAt: null}, now, 'en-US'), '-');
});

test('captionLine falls back to a placeholder once a window has expired', () => {
    const quota = {resetsAt: new Date('2026-08-04T06:00:00Z'), expired: true};
    assert.equal(captionLine(quota, now, 'en-US'), '-');
});

test('a reset a second short of the minute reads as that minute', () => {
    const quota = {resetsAt: new Date('2026-08-08T07:59:59.966Z')};
    assert.equal(captionLine(quota, now, 'en-US'), '4d 0h left · Sat 8:00 AM');
});

test('sibling windows stamped a second apart share one clock reading', () => {
    const early = {resetsAt: new Date('2026-08-08T07:59:59.966Z')};
    const late = {resetsAt: new Date('2026-08-08T08:00:00.966Z')};
    assert.equal(captionLine(early, now, 'en-US'), captionLine(late, now, 'en-US'));
});

test('a reset rounds to the nearer minute rather than always up', () => {
    const down = {resetsAt: new Date('2026-08-04T09:00:29Z')};
    const up = {resetsAt: new Date('2026-08-04T09:00:31Z')};
    assert.equal(captionLine(down, now, 'en-US'), '1h 09m left · 9:00 AM');
    assert.equal(captionLine(up, now, 'en-US'), '1h 09m left · 9:01 AM');
});

test('a reset rounding across midnight carries the new weekday', () => {
    const quota = {resetsAt: new Date('2026-08-04T23:59:45Z')};
    assert.equal(captionLine(quota, now, 'en-US'), '16h 08m left · Wed 12:00 AM');
});

test('timeLocale prefers the time category over the base language', () => {
    assert.equal(timeLocale({LANG: 'en_US.UTF-8', LC_TIME: 'fr_FR.UTF-8'}), 'fr-FR');
    assert.equal(timeLocale({LANG: 'en_US.UTF-8'}), 'en-US');
    assert.equal(timeLocale({LANG: 'en_US.UTF-8', LC_TIME: 'fr_FR.UTF-8', LC_ALL: 'de_DE.UTF-8'}), 'de-DE');
});

test('timeLocale drops modifiers and yields to the runtime default when unset', () => {
    assert.equal(timeLocale({LC_TIME: 'ca_ES.UTF-8@valencia'}), 'ca-ES');
    assert.equal(timeLocale({LC_TIME: 'C'}), undefined);
    assert.equal(timeLocale({LANG: null}), undefined);
    assert.equal(timeLocale({}), undefined);
});

test('a French time locale renders the 24-hour clock', () => {
    const quota = {resetsAt: new Date('2026-08-04T12:49:00Z')};
    const locale = timeLocale({LANG: 'en_US.UTF-8', LC_TIME: 'fr_FR.UTF-8'});
    assert.equal(captionLine(quota, now, locale), '4h 58m left · 12:49');
});

test('percentLine renders a share of the window', () => {
    assert.equal(percentLine({percent: 22}), '22%');
});

test('percentLine falls back to a placeholder when expired or unmeasured', () => {
    assert.equal(percentLine({percent: 22, expired: true}), '-');
    assert.equal(percentLine({percent: null}), '-');
    assert.equal(percentLine({}), '-');
});

test('every quota shape keeps the percent and caption rows filled', () => {
    const shapes = [
        {percent: 22, resetsAt: new Date('2026-08-04T11:59:00Z')},
        {percent: 0, resetsAt: null},
        {percent: 22, resetsAt: new Date('2026-08-04T06:00:00Z'), expired: true},
        {},
    ];
    for (const quota of shapes) {
        assert.notEqual(percentLine(quota), '');
        assert.notEqual(captionLine(quota, now, 'en-US'), '');
    }
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

test('rateLimitLine names the time polling resumes', () => {
    assert.equal(rateLimitLine(new Date('2026-08-04T08:36:31Z'), now, 'en-GB'), 'retry at 8:37');
});

test('rateLimitLine carries the weekday when the retry falls on another day', () => {
    assert.equal(rateLimitLine(new Date('2026-08-05T06:00:00Z'), now, 'en-GB'), 'retry Wed 06:00');
});

test('rateLimitLine says nothing when nothing is holding the poll back', () => {
    assert.equal(rateLimitLine(null, now, 'en-GB'), '');
});

test('rateLimitMessage names the hold and the time it lifts', () => {
    assert.equal(rateLimitMessage(new Date('2026-08-04T08:36:31Z'), now, 'en-GB'),
        '⏳ Rate limited · retry at 8:37');
});

test('rateLimitMessage carries the weekday when the hold outlasts the day', () => {
    assert.equal(rateLimitMessage(new Date('2026-08-05T06:00:00Z'), now, 'en-GB'),
        '⏳ Rate limited · retry Wed 06:00');
});

test('rateLimitMessage says nothing when no hold is in force', () => {
    assert.equal(rateLimitMessage(null, now, 'en-GB'), '');
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


