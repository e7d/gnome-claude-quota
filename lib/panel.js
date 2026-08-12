// These are the shell's own terms for the right box, from ui/panel.js
// vfunc_allocate: it hands that box min(sideWidth, its natural width).
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
