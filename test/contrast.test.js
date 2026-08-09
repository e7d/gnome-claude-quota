import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    blendFraction, chroma, clusterColors, colorDistance, contrastRatio, isBlend, isTextLike,
    LARGE_TEXT, measureMark, NORMAL_TEXT, scanImage, textThreshold, toHex,
} from '../tools/contrast.js';

const WHITE = {red: 255, green: 255, blue: 255};
const BLACK = {red: 0, green: 0, blue: 0};
const GREY = {red: 128, green: 128, blue: 128};

function canvas(width, height, fill) {
    const pixels = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index++)
        pixels.set([fill.red, fill.green, fill.blue, 255], index * 4);
    return {width, height, pixels};
}

function paint(image, color, box) {
    for (let dy = 0; dy < box.height; dy++)
        for (let dx = 0; dx < box.width; dx++) {
            const index = (box.y + dy) * image.width + box.x + dx;
            image.pixels.set([color.red, color.green, color.blue, color.alpha ?? 255], index * 4);
        }
    return image;
}

function strokes(image, color, {y, height}) {
    for (let x = 4; x + 2 < image.width; x += 8)
        paint(image, color, {x, y, width: 2, height});
    return image;
}

function failing(findings) {
    return findings.filter(finding => finding.ratio < finding.threshold.ratio);
}

test('contrastRatio spans the WCAG range', () => {
    assert.equal(contrastRatio(WHITE, BLACK), 21);
    assert.equal(contrastRatio(BLACK, WHITE), 21);
    assert.equal(contrastRatio(WHITE, WHITE), 1);
});

test('contrastRatio puts mid grey on white below the normal-text threshold', () => {
    assert.ok(contrastRatio(GREY, WHITE) < NORMAL_TEXT.ratio);
    assert.ok(contrastRatio(GREY, WHITE) > LARGE_TEXT.ratio);
});

test('colorDistance and chroma read a colour apart from its neighbours', () => {
    assert.equal(colorDistance(BLACK, {red: 3, green: 4, blue: 0}), 5);
    assert.equal(chroma(GREY), 0);
    assert.equal(chroma({red: 217, green: 119, blue: 87}), 130);
});

test('toHex pads and rounds each channel', () => {
    assert.equal(toHex({red: 0, green: 8, blue: 255}), '#0008ff');
    assert.equal(toHex({red: 216.6, green: 119.2, blue: 87}), '#d97757');
});

test('clusterColors folds near shades into the heaviest and keeps distant ones', () => {
    const clusters = clusterColors([
        [{red: 54, green: 54, blue: 58}, 100],
        [{red: 56, green: 55, blue: 59}, 20],
        [{red: 253, green: 253, blue: 253}, 40],
    ]);
    assert.equal(clusters.length, 2);
    assert.equal(clusters[0].count, 120);
    assert.equal(clusters[1].count, 40);
    assert.ok(colorDistance(clusters[0].color, {red: 54, green: 54, blue: 58}) < 1);
});

test('clusterColors keeps colours further apart than the tolerance', () => {
    const clusters = clusterColors([[BLACK, 10], [{red: 20, green: 0, blue: 0}, 5]], 10);
    assert.equal(clusters.length, 2);
});

test('blendFraction locates a colour along the background-to-ink axis', () => {
    assert.equal(blendFraction({red: 128, green: 0, blue: 0}, BLACK, {red: 256, green: 0, blue: 0}), 0.5);
    assert.equal(blendFraction(WHITE, GREY, GREY), null);
});

test('isBlend accepts an anti-aliased midpoint and rejects a different hue', () => {
    assert.ok(isBlend(GREY, BLACK, WHITE));
    assert.ok(!isBlend({red: 0, green: 128, blue: 0}, BLACK, WHITE));
    assert.ok(!isBlend(WHITE, BLACK, WHITE));
    assert.ok(!isBlend(BLACK, BLACK, WHITE));
});

test('measureMark reports stroke thickness and tallest run', () => {
    const rows = [
        [false, true, true, false],
        [false, true, true, false],
        [false, true, true, false],
    ];
    assert.deepEqual(measureMark(rows), {thickness: 2, height: 3});
    assert.deepEqual(measureMark([[false, false]]), {thickness: 0, height: 0});
});

test('isTextLike rejects a mark too short or too thick to be a glyph', () => {
    assert.ok(isTextLike({thickness: 2, height: 9}));
    assert.ok(!isTextLike({thickness: 2, height: 2}));
    assert.ok(!isTextLike({thickness: 9, height: 9}));
    assert.ok(!isTextLike({thickness: 0, height: 9}));
});

test('textThreshold switches to the large-text ratio above 18px', () => {
    assert.equal(textThreshold(12), NORMAL_TEXT);
    assert.equal(textThreshold(18), LARGE_TEXT);
    assert.equal(NORMAL_TEXT.ratio, 4.5);
    assert.equal(LARGE_TEXT.ratio, 3);
});

test('scanImage pairs ink with the surface behind it and reports the ratio', () => {
    const {findings, panels} = scanImage(strokes(canvas(64, 64, WHITE), GREY, {y: 20, height: 8}));
    assert.equal(panels.length, 1);
    assert.equal(toHex(panels[0]), '#ffffff');
    const grey = findings.find(finding => toHex(finding.ink) === '#808080');
    assert.ok(grey, 'expected the grey strokes to be found as ink');
    assert.equal(grey.threshold, NORMAL_TEXT);
    assert.ok(Math.abs(grey.ratio - contrastRatio(GREY, WHITE)) < 0.01);
});

test('scanImage reports mid grey text on white as under the normal-text threshold', () => {
    const {findings} = scanImage(strokes(canvas(64, 64, WHITE), GREY, {y: 20, height: 8}));
    assert.equal(failing(findings).length, 1);
    assert.equal(failing(findings)[0].threshold.ratio, 4.5);
});

test('scanImage clears the same colour once the glyphs are large text', () => {
    const {findings} = scanImage(strokes(canvas(64, 64, WHITE), GREY, {y: 20, height: 22}));
    const grey = findings.find(finding => toHex(finding.ink) === '#808080');
    assert.equal(grey.threshold, LARGE_TEXT);
    assert.equal(failing(findings).length, 0);
});

test('scanImage clears black text on white', () => {
    const {findings} = scanImage(strokes(canvas(64, 64, WHITE), BLACK, {y: 20, height: 8}));
    assert.ok(findings.length > 0);
    assert.equal(failing(findings).length, 0);
});

test('scanImage ignores the transparent padding under the capture', () => {
    const padded = strokes(canvas(64, 96, WHITE), GREY, {y: 20, height: 8});
    paint(padded, {...WHITE, alpha: 0}, {x: 0, y: 64, width: 64, height: 32});
    const {findings} = scanImage(padded);
    assert.equal(failing(findings).length, 1);
    assert.equal(toHex(failing(findings)[0].ink), '#808080');
});

test('scanImage treats a solid block as a region rather than ink', () => {
    const block = paint(canvas(64, 64, WHITE), GREY, {x: 20, y: 20, width: 24, height: 24});
    assert.deepEqual(scanImage(block).findings, []);
});

test('scanImage leaves an image with nothing on it alone', () => {
    assert.deepEqual(scanImage(canvas(64, 64, WHITE)).findings, []);
});
