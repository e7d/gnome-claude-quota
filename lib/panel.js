export function availableWidth({panelWidth, centerWidth, centerOffset = 0, othersWidth = 0}) {
    const side = Math.max(0, (panelWidth - centerWidth + centerOffset) / 2);
    return Math.max(0, side - othersWidth);
}

export function fittingCount(cellCount, available, measure) {
    for (let visible = cellCount; visible > 0; visible -= 1) {
        if (measure(visible) <= available)
            return visible;
    }
    return 0;
}

function total(widths) {
    return widths.reduce((sum, width) => sum + width, 0);
}

// Room goes to the leftmost indicator first, so the bar gives way from the right: each
// strip is measured against what the strips left of it take now and the icon each one
// right of it keeps whatever happens.
export function peersWidth({rightWidth, strips, index}) {
    const own = total(strips.map(strip => strip.width));
    const left = total(strips.slice(0, index).map(strip => strip.width));
    const right = total(strips.slice(index + 1).map(strip => strip.iconWidth));
    return Math.max(0, rightWidth - own + left + right);
}
