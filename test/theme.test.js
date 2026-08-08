import assert from 'node:assert/strict';
import {test} from 'node:test';

import {brandColor, relativeLuminance, schemeForForeground} from '../lib/theme.js';

const WHITE = {red: 255, green: 255, blue: 255};
const BLACK = {red: 0, green: 0, blue: 0};

test('relativeLuminance spans the full range for white and black', () => {
    assert.equal(relativeLuminance(WHITE), 1);
    assert.equal(relativeLuminance(BLACK), 0);
});

test('relativeLuminance applies the low-end linear segment', () => {
    assert.ok(relativeLuminance({red: 8, green: 8, blue: 8}) < 0.003);
});

test('schemeForForeground reads a light label as a dark panel', () => {
    assert.equal(schemeForForeground(WHITE), 'dark');
    assert.equal(schemeForForeground({red: 253, green: 253, blue: 253}), 'dark');
});

test('schemeForForeground reads a dark label as a light panel', () => {
    assert.equal(schemeForForeground(BLACK), 'light');
    assert.equal(schemeForForeground({red: 33, green: 33, blue: 37}), 'light');
});

test('schemeForForeground puts a mid grey on the light side of the split', () => {
    assert.equal(schemeForForeground({red: 128, green: 128, blue: 128}), 'light');
});

test('brandColor answers a hex colour per scheme', () => {
    assert.equal(brandColor('dark'), '#d97757');
    assert.equal(brandColor('light'), '#c6613f');
});
