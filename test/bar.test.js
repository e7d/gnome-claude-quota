import assert from 'node:assert/strict';
import {test} from 'node:test';

import {tickRects} from '../lib/bar.js';

const BAR = {width: 260, height: 12, barHeight: 6, tickWidth: 2, shadowWidth: 1, overhang: 2};

function at(ratio, overrides = {}) {
    return tickRects({...BAR, ...overrides, ratio});
}

test('tickRects centres the tick on the track and overhangs it both sides', () => {
    const {tick} = at(0.5);
    assert.deepEqual(tick, {x: 129, y: 1, width: 2, height: 10});
});

test('tickRects lands the tick inside the rounded ends', () => {
    assert.equal(at(0).tick.x, 2);
    assert.equal(at(1).tick.x, 256);
});

test('tickRects casts the shadow to the left of the tick', () => {
    const {shadow, tick} = at(0.5);
    assert.equal(shadow.x + shadow.width, tick.x);
    assert.equal(shadow.width, 1);
});

test('tickRects keeps the shadow on the bar, without the overhang', () => {
    const {shadow} = at(0.5);
    assert.equal(shadow.y, 3);
    assert.equal(shadow.height, 6);
});

test('tickRects clips the shadow at the left edge instead of drawing off-surface', () => {
    const {shadow} = at(0, {shadowWidth: 4});
    assert.deepEqual(shadow, {x: 0, y: 3, width: 2, height: 6});
});

test('tickRects casts no shadow when the tick sits on the left edge', () => {
    const edge = at(0, {width: 4, barHeight: 4, tickWidth: 4});
    assert.equal(edge.tick.x, 0);
    assert.equal(edge.shadow, null);
});

test('tickRects casts no shadow when the stylesheet declares none', () => {
    assert.equal(at(0.5, {shadowWidth: 0}).shadow, null);
});

test('tickRects draws the tick with no shadow settings at all', () => {
    const {shadow, tick} = tickRects({width: 260, height: 12, barHeight: 6, tickWidth: 2, ratio: 0.5});
    assert.equal(shadow, null);
    assert.deepEqual(tick, {x: 129, y: 3, width: 2, height: 6});
});

test('tickRects never draws the tick above the surface', () => {
    assert.equal(at(0.5, {height: 6}).tick.y, 0);
});
