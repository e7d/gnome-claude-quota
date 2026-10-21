const PREFS_APP_ID = 'org.gnome.Shell.Extensions';

export function isOwnPrefsWindow({appId, title}, extensionName) {
    return appId === PREFS_APP_ID && title === extensionName;
}
