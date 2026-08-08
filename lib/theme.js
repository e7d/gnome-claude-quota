const BRAND = {dark: '#d97757', light: '#c6613f'};

export function relativeLuminance(color) {
    const channel = value => {
        const part = value / 255;
        return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue);
}

export function schemeForForeground(color) {
    return relativeLuminance(color) > 0.5 ? 'dark' : 'light';
}

export function brandColor(scheme) {
    return BRAND[scheme];
}
