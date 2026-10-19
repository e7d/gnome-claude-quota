const DEFAULT_NAME = '.claude';
const CREDENTIALS_NAME = '.credentials.json';
const CONFIG_NAME = '.claude.json';

function join(...parts) {
    return parts.join('/');
}

function trimmed(path) {
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function defaultDir(home) {
    return join(home, DEFAULT_NAME);
}

export function configDir(setting, home) {
    return setting === '' ? defaultDir(home) : trimmed(setting);
}

export function settingFor(dir, home) {
    const path = trimmed(dir);
    return path === defaultDir(home) ? '' : path;
}

export function credentialsFile(dir) {
    return join(dir, CREDENTIALS_NAME);
}

// Claude Code keeps its config beside the credentials only when CLAUDE_CONFIG_DIR names
// the directory; left unset, the file sits in the home directory instead.
export function configFiles(dir, home) {
    const own = join(dir, CONFIG_NAME);
    return dir === defaultDir(home) ? [own, join(home, CONFIG_NAME)] : [own];
}

// The default keeps the name every earlier release wrote, so an upgrade starts from
// the numbers it already holds instead of spending a request to rebuild them.
export function cacheName({dir, home, digest}) {
    return dir === defaultDir(home) ? 'usage.json' : `usage-${digest(dir).slice(0, 16)}.json`;
}

export function isCandidateName(name) {
    return name.startsWith(DEFAULT_NAME) && name !== CONFIG_NAME;
}

export function displayPath(path, home) {
    if (path === home)
        return '~';
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function choiceLabel({path, email}, home) {
    const shown = displayPath(path, home);
    return email ? `${shown} · ${email}` : shown;
}

export function directoryChoices({found, current, home}) {
    const byPath = new Map([[defaultDir(home), {path: defaultDir(home), email: null}]]);
    found.forEach(entry => byPath.set(entry.path, entry));
    if (!byPath.has(current))
        byPath.set(current, {path: current, email: null});
    return [...byPath.values()].toSorted((a, b) => (a.path < b.path ? -1 : 1));
}
