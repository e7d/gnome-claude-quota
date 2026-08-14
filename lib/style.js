export function severityClass(base, severity, scheme) {
    return severity === 'normal' ? base : `${base} cq-${severity}-${scheme}`;
}

export function quotaClass(base, quota, scheme) {
    return severityClass(base, quota.severity, scheme);
}

export function barClass(scheme) {
    return `cq-bar cq-bar-${scheme}`;
}
