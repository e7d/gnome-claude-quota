const BRAND = {dark: '#d97757', light: '#c6613f'};

function linearize(value) {
    const part = value / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color) {
    return 0.2126 * linearize(color.red) + 0.7152 * linearize(color.green) + 0.0722 * linearize(color.blue);
}

export function schemeForForeground(color) {
    return relativeLuminance(color) > 0.5 ? 'dark' : 'light';
}

export function brandColor(scheme) {
    return BRAND[scheme];
}
