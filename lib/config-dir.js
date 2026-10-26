const DEFAULT_NAME = '.claude';
const CREDENTIALS_NAME = '.credentials.json';
const CONFIG_NAME = '.claude.json';
const MARKER_NAMES = [CONFIG_NAME, CREDENTIALS_NAME, 'settings.json', 'projects'];

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

// Any of these says Claude Code has used the directory, signed in or not.
export function markerPaths(dir, home) {
    return unique([...configFiles(dir, home), ...MARKER_NAMES.map(name => join(dir, name))]);
}

// Claude Code creates its default directory on the first login, so a missing or empty
// one is a machine that has not signed in yet rather than a wrong path.
export function dirState({exists, marked, signedIn, broken, isDefault}) {
    if (signedIn)
        return 'signed-in';
    if (broken)
        return 'broken';
    if (isDefault)
        return 'signed-out';
    if (!exists)
        return 'missing';
    return marked ? 'signed-out' : 'not-claude';
}

export function isUsable(state) {
    return state === 'signed-in' || state === 'signed-out';
}

export function isCandidateName(name) {
    return name.startsWith(DEFAULT_NAME) && name !== CONFIG_NAME;
}

export function displayPath(path, home) {
    if (path === home)
        return '~';
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function unique(paths) {
    return [...new Set(paths)];
}

export function accountDirs(settings, home) {
    return unique(settings.map(setting => configDir(setting, home)));
}

// The account list alone decides the order; the shown list is a set taken from it.
export function shownDirs({accounts, shown}) {
    return accounts.filter(dir => shown.includes(dir));
}

export function settingsFor(dirs, home) {
    return unique(dirs).map(dir => settingFor(dir, home));
}

// The default directory is stored as an empty string, so joining the lists would make
// a list holding only ~/.claude read as an empty one, and removing it would write nothing.
export function sameSettings(a, b) {
    return a.length === b.length && a.every((setting, index) => setting === b[index]);
}

export function movedDir(dirs, {dir, onto}) {
    const rest = dirs.filter(path => path !== dir);
    if (rest.length === dirs.length || !dirs.includes(onto) || dir === onto)
        return dirs;
    const at = dirs.indexOf(onto);
    return [...rest.slice(0, at), dir, ...rest.slice(at)];
}

export function steppedDir(dirs, {dir, step}) {
    const onto = dirs[dirs.indexOf(dir) + step];
    return onto === undefined ? dirs : movedDir(dirs, {dir, onto});
}

// The default directory is always offered, login or not: it is where Claude Code looks
// first, and a removed one has to be reachable again from somewhere.
export function addableDirs({found, accounts, home}) {
    return unique([defaultDir(home), ...found]).filter(dir => !accounts.includes(dir)).toSorted();
}

export function accountRows({accounts, shown}) {
    return accounts.map((path, index) => ({
        path,
        shown: shown.includes(path),
        first: index === 0,
        last: index === accounts.length - 1,
    }));
}
