function tickLeft({width, barHeight, tickWidth, ratio}) {
    const radius = Math.min(width, barHeight) / 2;
    return Math.round(radius + (width - 2 * radius) * ratio - tickWidth / 2);
}

// Cast by a light on the right, so it falls to the left of the tick and never past
// the bar, where a sliver would merely read as a wider tick.
function shadowRect({left, top, barHeight, shadowWidth}) {
    const x = Math.max(0, left - shadowWidth);
    const visible = left - x;
    return visible > 0 ? {x, y: top, width: visible, height: barHeight} : null;
}

export function tickRects({width, height, barHeight, tickWidth, shadowWidth = 0, overhang = 0, ratio}) {
    const left = tickLeft({width, barHeight, tickWidth, ratio});
    const top = Math.round((height - barHeight) / 2);
    return {
        shadow: shadowRect({left, top, barHeight, shadowWidth}),
        tick: {
            x: left,
            y: Math.max(0, top - overhang),
            width: tickWidth,
            height: barHeight + 2 * overhang,
        },
    };
}
