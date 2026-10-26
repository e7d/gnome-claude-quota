import assert from 'node:assert/strict';
import {test} from 'node:test';

import {availableWidth, fittingCount, peersWidth} from '../lib/panel.js';

const LADDER = [0, 60, 130, 200];

function measureFrom(widths) {
    return visible => widths[visible];
}

test('availableWidth halves what the centre box leaves', () => {
    assert.equal(availableWidth({panelWidth: 1000, centerWidth: 200}), 400);
});

test('availableWidth subtracts the other right-box items', () => {
    assert.equal(availableWidth({panelWidth: 1000, centerWidth: 200, othersWidth: 150}), 250);
});

test('availableWidth shifts the split by the work-area offset', () => {
    assert.equal(
        availableWidth({panelWidth: 1000, centerWidth: 200, centerOffset: 40}),
        420);
});

test('availableWidth never reports negative space', () => {
    assert.equal(availableWidth({panelWidth: 300, centerWidth: 900}), 0);
    assert.equal(availableWidth({panelWidth: 1000, centerWidth: 200, othersWidth: 900}), 0);
});

test('fittingCount keeps every cell when they all fit', () => {
    assert.equal(fittingCount(3, 200, measureFrom(LADDER)), 3);
    assert.equal(fittingCount(3, 1000, measureFrom(LADDER)), 3);
});

test('fittingCount drops cells one at a time until the layout fits', () => {
    assert.equal(fittingCount(3, 199, measureFrom(LADDER)), 2);
    assert.equal(fittingCount(3, 129, measureFrom(LADDER)), 1);
});

test('fittingCount falls back to no cells at all', () => {
    assert.equal(fittingCount(3, 59, measureFrom(LADDER)), 0);
    assert.equal(fittingCount(3, 0, measureFrom(LADDER)), 0);
});

test('fittingCount treats an exact fit as fitting', () => {
    assert.equal(fittingCount(3, 200, measureFrom(LADDER)), 3);
    assert.equal(fittingCount(3, 130, measureFrom(LADDER)), 2);
    assert.equal(fittingCount(3, 60, measureFrom(LADDER)), 1);
});

test('fittingCount measures only as far as the first fit', () => {
    const asked = [];
    fittingCount(3, 129, visible => {
        asked.push(visible);
        return LADDER[visible];
    });
    assert.deepEqual(asked, [3, 2, 1]);
});

test('fittingCount reports nothing to show for an empty panel', () => {
    assert.equal(fittingCount(0, 500, () => 0), 0);
});

const STRIPS = [{width: 150, iconWidth: 30}, {width: 120, iconWidth: 30}, {width: 100, iconWidth: 30}];

test('one strip alone counts every other right-box item and nothing of its own', () => {
    assert.equal(peersWidth({rightWidth: 400, strips: [{width: 150, iconWidth: 30}], index: 0}), 250);
});

test('the leftmost strip only leaves room for the icons right of it', () => {
    assert.equal(peersWidth({rightWidth: 600, strips: STRIPS, index: 0}), 600 - 370 + 60);
});

test('a strip further right counts the strips left of it at their full width', () => {
    assert.equal(peersWidth({rightWidth: 600, strips: STRIPS, index: 1}), 600 - 370 + 150 + 30);
    assert.equal(peersWidth({rightWidth: 600, strips: STRIPS, index: 2}), 600 - 370 + 270);
});

test('a strip on the left is measured the same whatever the strips right of it show', () => {
    const wide = [STRIPS[0], {width: 300, iconWidth: 30}];
    const narrow = [STRIPS[0], {width: 30, iconWidth: 30}];
    assert.equal(peersWidth({rightWidth: 600 + 300, strips: wide, index: 0}),
        peersWidth({rightWidth: 600 + 30, strips: narrow, index: 0}));
});
