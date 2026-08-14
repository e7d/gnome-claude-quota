import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SCOPES, THRESHOLDS} from './lib/settings.js';

const TITLES = {
    warning: () => _('High usage threshold'),
    critical: () => _('Critical usage threshold'),
};

const NOTIFY_TITLES = {
    warning: () => _('Notify at high usage'),
    critical: () => _('Notify at critical usage'),
};

function resetButton(settings, key) {
    const button = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: _('Restore the default'),
        valign: Gtk.Align.CENTER,
        has_frame: false,
    });
    const sync = () => {
        button.sensitive = settings.get_int(key) !== settings.get_default_value(key).get_int32();
    };
    button.connect('clicked', () => settings.reset(key));
    settings.connect(`changed::${key}`, sync);
    sync();
    return button;
}

function thresholdRow(settings, level) {
    const row = new Adw.SpinRow({
        title: TITLES[level.level](),
        adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 1, page_increment: 5}),
    });
    settings.bind(level.percentKey, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(resetButton(settings, level.percentKey));
    return row;
}

function notifyRow(settings, level) {
    const row = new Adw.SwitchRow({title: NOTIFY_TITLES[level.level]()});
    settings.bind(level.notifyKey, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function visibilityRow(settings, {title, key}) {
    const row = new Adw.SwitchRow({title});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function quotaGroup(settings, scope) {
    const group = new Adw.PreferencesGroup({title: _(scope.name)});
    group.add(visibilityRow(settings, {title: _('Show in top bar'), key: scope.barKey}));
    group.add(visibilityRow(settings, {title: _('Show in menu'), key: scope.menuKey}));
    return group;
}

// A pair the user cannot cross is a pair severityFor never has to disambiguate on
// screen; dconf can still be written by hand, which is why the function clamps too.
function clampToEachOther(settings, rows) {
    const [warning, critical] = rows;
    const sync = () => {
        warning.adjustment.set_upper(settings.get_int('critical-percent'));
        critical.adjustment.set_lower(settings.get_int('warning-percent'));
    };
    settings.connect('changed::warning-percent', sync);
    settings.connect('changed::critical-percent', sync);
    sync();
}

export default class ClaudeQuotaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const thresholds = new Adw.PreferencesGroup({title: _('Thresholds')});
        const spins = THRESHOLDS.map(level => {
            const row = thresholdRow(settings, level);
            thresholds.add(row);
            thresholds.add(notifyRow(settings, level));
            return row;
        });
        clampToEachOther(settings, spins);
        page.add(thresholds);
        SCOPES.forEach(scope => page.add(quotaGroup(settings, scope)));
        window.add(page);
        window.set_default_size(640, 820);
    }
}
