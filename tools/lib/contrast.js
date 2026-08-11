import {relativeLuminance} from '../../lib/theme.js';

const WINDOW = 16;
const STEP = 8;
const CLUSTER_TOLERANCE = 10;
const GROUP_TOLERANCE = 16;
const BLEND_TOLERANCE = 20;
const NEUTRAL_CHROMA = 24;
const MIN_OPAQUE_SHARE = 0.9;
const MIN_SURFACE_SHARE = 0.45;
const SURFACE_WINDOWS = 3;
const MIN_INK_PIXELS = 3;
const MAX_INK_SHARE = 0.4;
const MIN_MARK_HEIGHT = 3;
const MAX_STROKE = 4;
const REGION_DEPTH = 2;
const REGION_MARGIN = 3;
const LARGE_TEXT_HEIGHT = 18;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export const NORMAL_TEXT = {label: 'normal text', ratio: 4.5};
export const LARGE_TEXT = {label: 'large text', ratio: 3};
export const NON_TEXT = {label: 'non-text', ratio: 3};

const POPUP_SURFACE = {dark: '#36363a', light: '#fafafb'};

export function contrastRatio(one, other) {
    const [bright, dim] = [relativeLuminance(one), relativeLuminance(other)].toSorted((a, b) => b - a);
    return (bright + 0.05) / (dim + 0.05);
}

export function colorDistance(one, other) {
    return Math.hypot(one.red - other.red, one.green - other.green, one.blue - other.blue);
}

export function chroma(color) {
    return Math.max(color.red, color.green, color.blue) - Math.min(color.red, color.green, color.blue);
}

export function toHex(color) {
    const channel = value => Math.round(value).toString(16).padStart(2, '0');
    return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`;
}

function mix(from, to, fraction) {
    return {
        red: from.red + fraction * (to.red - from.red),
        green: from.green + fraction * (to.green - from.green),
        blue: from.blue + fraction * (to.blue - from.blue),
    };
}

export function blendFraction(color, from, to) {
    const axis = {red: to.red - from.red, green: to.green - from.green, blue: to.blue - from.blue};
    const span = axis.red ** 2 + axis.green ** 2 + axis.blue ** 2;
    if (span === 0)
        return null;
    const along = (color.red - from.red) * axis.red + (color.green - from.green) * axis.green
        + (color.blue - from.blue) * axis.blue;
    return along / span;
}

export function isBlend(color, from, to, tolerance = BLEND_TOLERANCE) {
    const fraction = blendFraction(color, from, to);
    if (fraction === null || fraction <= 0 || fraction >= 0.95)
        return false;
    return colorDistance(color, mix(from, to, fraction)) <= tolerance;
}

function nearestIndex(entries, color, tolerance) {
    let found = -1;
    let best = tolerance;
    entries.forEach((entry, index) => {
        const distance = colorDistance(entry.color, color);
        if (distance <= best) {
            found = index;
            best = distance;
        }
    });
    return found;
}

function absorbed(cluster, color, count) {
    const total = cluster.count + count;
    const channel = key => (cluster.color[key] * cluster.count + color[key] * count) / total;
    return {color: {red: channel('red'), green: channel('green'), blue: channel('blue')}, count: total};
}

export function clusterColors(counts, tolerance = CLUSTER_TOLERANCE) {
    const clusters = [];
    for (const [color, count] of [...counts].toSorted((a, b) => b[1] - a[1])) {
        const index = nearestIndex(clusters, color, tolerance);
        if (index < 0)
            clusters.push({color, count});
        else
            clusters[index] = absorbed(clusters[index], color, count);
    }
    return clusters.toSorted((a, b) => b.count - a.count);
}

function horizontalRuns(row) {
    const runs = [];
    let run = 0;
    for (const on of row) {
        if (on)
            run++;
        else if (run) {
            runs.push(run);
            run = 0;
        }
    }
    return run ? [...runs, run] : runs;
}

function tallestRun(rows) {
    let tallest = 0;
    for (let x = 0; x < (rows[0]?.length ?? 0); x++) {
        let run = 0;
        for (const row of rows) {
            run = row[x] ? run + 1 : 0;
            tallest = Math.max(tallest, run);
        }
    }
    return tallest;
}

export function measureMark(rows) {
    const runs = rows.flatMap(horizontalRuns).toSorted((a, b) => a - b);
    return {thickness: runs.length ? runs[runs.length >> 1] : 0, height: tallestRun(rows)};
}

export function isTextLike({thickness, height}) {
    return height >= MIN_MARK_HEIGHT && thickness > 0 && thickness <= MAX_STROKE;
}

export function textThreshold(glyphHeight) {
    return glyphHeight >= LARGE_TEXT_HEIGHT ? LARGE_TEXT : NORMAL_TEXT;
}

function colorAt(image, index) {
    return {red: image.pixels[index * 4], green: image.pixels[index * 4 + 1], blue: image.pixels[index * 4 + 2]};
}

// The shots are padded to a common height with fully transparent pixels, so alpha
// is a mask over the capture rather than a colour to measure.
function isOpaque(image, index) {
    return image.pixels[index * 4 + 3] > 250;
}

function windowColors(image, x, y) {
    const tally = new Map();
    let opaque = 0;
    for (let dy = 0; dy < WINDOW; dy++)
        for (let dx = 0; dx < WINDOW; dx++) {
            const index = (y + dy) * image.width + x + dx;
            if (!isOpaque(image, index))
                continue;
            opaque++;
            const {red, green, blue} = colorAt(image, index);
            const key = (red << 16) | (green << 8) | blue;
            tally.set(key, (tally.get(key) ?? 0) + 1);
        }
    return {opaque, counts: [...tally].map(([key, count]) =>
        [{red: key >> 16, green: (key >> 8) & 255, blue: key & 255}, count])};
}

function sampleWindows(image) {
    const windows = [];
    for (let y = 0; y + WINDOW <= image.height; y += STEP)
        for (let x = 0; x + WINDOW <= image.width; x += STEP) {
            const {opaque, counts} = windowColors(image, x, y);
            if (opaque < WINDOW * WINDOW * MIN_OPAQUE_SHARE)
                continue;
            const clusters = clusterColors(counts);
            if (clusters[0].count / opaque < MIN_SURFACE_SHARE)
                continue;
            windows.push({x, y, opaque, clusters});
        }
    return windows;
}

function surfacesOf(windows) {
    const tally = [];
    for (const {clusters} of windows) {
        const index = nearestIndex(tally, clusters[0].color, CLUSTER_TOLERANCE);
        if (index < 0)
            tally.push({color: clusters[0].color, count: 1});
        else
            tally[index] = {...tally[index], count: tally[index].count + 1};
    }
    return tally.filter(entry => entry.count >= SURFACE_WINDOWS).map(entry => entry.color);
}

function spreadAxis(mask, grid, radius) {
    const {width, height, vertical} = grid;
    const grown = new Uint8Array(mask.length);
    const outer = vertical ? width : height;
    const inner = vertical ? height : width;
    const at = (line, step) => vertical ? step * width + line : line * width + step;
    for (let line = 0; line < outer; line++) {
        let live = 0;
        for (let step = 0; step < inner + radius; step++) {
            if (step < inner && mask[at(line, step)])
                live++;
            const gone = step - 2 * radius - 1;
            if (gone >= 0 && mask[at(line, gone)])
                live--;
            const target = step - radius;
            if (target >= 0 && target < inner)
                grown[at(line, target)] = live > 0 ? 1 : 0;
        }
    }
    return grown;
}

function spread(mask, {width, height}, radius) {
    const rows = spreadAxis(mask, {width, height, vertical: false}, radius);
    return spreadAxis(rows, {width, height, vertical: true}, radius);
}

function backgroundMask(image, surfaces) {
    const mask = new Uint8Array(image.width * image.height);
    for (let index = 0; index < mask.length; index++)
        mask[index] = !isOpaque(image, index)
            || surfaces.some(color => colorDistance(color, colorAt(image, index)) <= CLUSTER_TOLERANCE) ? 1 : 0;
    return mask;
}

function* neighbours({width, height}, index) {
    const x = index % width;
    const y = (index - x) / width;
    for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height)
            yield ny * width + nx;
    }
}

function flood(grid, seed) {
    const {background, near, seen, width} = grid;
    const stack = [seed];
    const pixels = [];
    let deep = false;
    let top = Infinity;
    let bottom = -1;
    seen[seed] = 1;
    while (stack.length) {
        const index = stack.pop();
        const y = (index - index % width) / width;
        pixels.push(index);
        deep ||= !near[index];
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        for (const next of neighbours(grid, index))
            if (!background[next] && !seen[next]) {
                seen[next] = 1;
                stack.push(next);
            }
    }
    return {pixels, deep, height: bottom - top + 1};
}

// Anything with an interior further than a stroke's width from the background is a
// region of its own: the wallpaper behind the popup, another indicator's pill, a
// progress bar. Its edges pair up as ink against our surfaces and read as failures.
function regionScan(image, surfaces) {
    const background = backgroundMask(image, surfaces);
    const grid = {background, near: spread(background, image, REGION_DEPTH),
        seen: new Uint8Array(background.length), width: image.width, height: image.height};
    const regions = new Uint8Array(background.length);
    const glyphHeight = new Int16Array(background.length);
    for (let seed = 0; seed < background.length; seed++) {
        if (background[seed] || grid.seen[seed])
            continue;
        const found = flood(grid, seed);
        for (const index of found.pixels) {
            regions[index] = found.deep ? 1 : 0;
            glyphHeight[index] = found.height;
        }
    }
    return {regions: spread(regions, image, REGION_MARGIN), glyphHeight};
}

function touchesRegion(regions, width, window) {
    for (let dy = 0; dy < WINDOW; dy++)
        for (let dx = 0; dx < WINDOW; dx++)
            if (regions[(window.y + dy) * width + window.x + dx])
                return true;
    return false;
}

function inkAnchors(window, background) {
    const candidates = window.clusters.slice(1)
        .filter(cluster => cluster.count >= MIN_INK_PIXELS && cluster.count / window.opaque <= MAX_INK_SHARE)
        .toSorted((a, b) => colorDistance(b.color, background) - colorDistance(a.color, background));
    const anchors = [];
    for (const {color} of candidates)
        if (!anchors.some(anchor => isBlend(color, background, anchor)))
            anchors.push(color);
    return anchors;
}

function markFor(image, window, {background, ink, heights}) {
    const rows = [];
    let color = ink;
    let reach = 1;
    let glyph = 0;
    for (let dy = 0; dy < WINDOW; dy++) {
        const row = [];
        for (let dx = 0; dx < WINDOW; dx++) {
            const index = (window.y + dy) * image.width + window.x + dx;
            const pixel = colorAt(image, index);
            const on = isOpaque(image, index) && colorDistance(pixel, ink) <= CLUSTER_TOLERANCE;
            const fraction = on ? blendFraction(pixel, background, ink) : 0;
            if (on)
                glyph = Math.max(glyph, heights[index]);
            if (fraction > reach)
                [reach, color] = [fraction, pixel];
            row.push(on);
        }
        rows.push(row);
    }
    return {rows, color, glyph};
}

function marksIn(image, window, {surfaces, glyphHeight}) {
    const background = window.clusters[0].color;
    const marks = [];
    for (const ink of inkAnchors(window, background)) {
        if (surfaces.some(color => colorDistance(color, ink) <= CLUSTER_TOLERANCE))
            continue;
        const mark = markFor(image, window, {background, ink, heights: glyphHeight});
        if (!isTextLike(measureMark(mark.rows)))
            continue;
        marks.push({background, ink: mark.color, threshold: textThreshold(mark.glyph),
            ratio: contrastRatio(background, mark.color), x: window.x, y: window.y});
    }
    return marks;
}

function record(findings, mark) {
    const index = findings.findIndex(finding => finding.threshold === mark.threshold
        && colorDistance(finding.background, mark.background) <= GROUP_TOLERANCE
        && colorDistance(finding.ink, mark.ink) <= GROUP_TOLERANCE);
    if (index < 0)
        return [...findings, {...mark, windows: 1}];
    const match = findings[index];
    const worst = mark.ratio < match.ratio ? mark : match;
    return findings.with(index, {...worst, windows: match.windows + 1});
}

// Anti-aliasing lays a ramp of blends between ink and background; each step of it
// reads as a fainter ink than the glyph ever paints.
function withoutBlends(findings) {
    return findings.filter(finding => !findings.some(other => other !== finding
        && colorDistance(other.background, finding.background) <= GROUP_TOLERANCE
        && colorDistance(other.ink, finding.background) > colorDistance(finding.ink, finding.background)
        && isBlend(finding.ink, finding.background, other.ink)));
}

function declaredColor(cssText, scheme, property) {
    const block = new RegExp(`\\.cq-bar-${scheme}\\s*\\{([^}]*)\\}`).exec(cssText)?.[1];
    if (block === undefined)
        throw new Error(`stylesheet has no .cq-bar-${scheme} rule`);
    const value = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+);`).exec(block)?.[1]?.trim();
    if (value === undefined)
        throw new Error(`.cq-bar-${scheme} declares no ${property}`);
    return parseColor(value);
}

function parseColor(value) {
    const rgba = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(value);
    if (rgba) {
        const [red, green, blue] = rgba.slice(1, 4).map(Number);
        return {red, green, blue, alpha: rgba[4] === undefined ? 1 : Number(rgba[4])};
    }
    const hex = /^#([0-9a-f]{6})$/i.exec(value);
    if (!hex)
        throw new Error(`cannot read the colour '${value}'`);
    const channels = [0, 2, 4].map(index => parseInt(hex[1].slice(index, index + 2), 16));
    return {red: channels[0], green: channels[1], blue: channels[2], alpha: 1};
}

function over(color, surface) {
    return mix(surface, color, color.alpha ?? 1);
}

export function tickFindings(cssText) {
    return ['dark', 'light'].flatMap(scheme => {
        const ink = declaredColor(cssText, scheme, 'color');
        const surface = parseColor(POPUP_SURFACE[scheme]);
        return [
            {place: 'track', background: over(declaredColor(cssText, scheme, '-barlevel-background-color'), surface)},
            {place: 'fill', background: declaredColor(cssText, scheme, '-barlevel-active-background-color')},
        ].map(({place, background}) => ({
            label: `${scheme} tick on ${place}`,
            ink,
            background,
            ratio: contrastRatio(ink, background),
            threshold: NON_TEXT,
        }));
    });
}

export function scanImage(image) {
    const windows = sampleWindows(image);
    const surfaces = surfacesOf(windows);
    const panels = surfaces.filter(color => chroma(color) <= NEUTRAL_CHROMA);
    const {regions, glyphHeight} = regionScan(image, panels);
    let findings = [];
    for (const window of windows) {
        if (!panels.some(color => colorDistance(color, window.clusters[0].color) <= CLUSTER_TOLERANCE))
            continue;
        if (touchesRegion(regions, image.width, window))
            continue;
        for (const mark of marksIn(image, window, {surfaces, glyphHeight}))
            findings = record(findings, mark);
    }
    return {surfaces, panels, findings: withoutBlends(findings)};
}
