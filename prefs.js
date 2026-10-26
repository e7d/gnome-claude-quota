import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {_} from './lib/i18n.js';
import {choiceAt, choiceIndex, installLanguage, languageChoices} from './lib/language.js';
import {ACCOUNT_KEY, LANGUAGE_KEY, PLAN_KEY, SCOPES, THRESHOLDS} from './lib/settings.js';
import {accountsGroup} from './ui/accounts-group.js';
import {catalogFiles} from './ui/catalog-files.js';

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
        button.sensitive = !settings.get_value(key).equal(settings.get_default_value(key));
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

function languageRow(settings, catalogs) {
    const choices = languageChoices(catalogs.tags);
    const row = new Adw.ComboRow({
        title: _('Language'),
        model: Gtk.StringList.new([_('Automatic'), ...choices.map(choice => choice.name)]),
    });
    const selected = () => choiceIndex(choices, settings.get_string(LANGUAGE_KEY));
    const sync = () => {
        row.selected = selected();
    };
    sync();
    row.connect('notify::selected', () => {
        if (row.selected !== selected())
            settings.set_string(LANGUAGE_KEY, choiceAt(choices, row.selected));
    });
    settings.connect(`changed::${LANGUAGE_KEY}`, sync);
    return row;
}

function languageGroup(settings, catalogs) {
    const group = new Adw.PreferencesGroup();
    group.add(languageRow(settings, catalogs));
    return group;
}

function displayGroup(settings) {
    const group = new Adw.PreferencesGroup({title: _('Display')});
    group.add(visibilityRow(settings, {title: _('Display active account'), key: ACCOUNT_KEY}));
    group.add(visibilityRow(settings, {title: _('Display plan'), key: PLAN_KEY}));
    return group;
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

function thresholdsGroup(settings) {
    const group = new Adw.PreferencesGroup({title: _('Thresholds')});
    const spins = THRESHOLDS.map(level => {
        const row = thresholdRow(settings, level);
        group.add(row);
        group.add(notifyRow(settings, level));
        return row;
    });
    clampToEachOther(settings, spins);
    return group;
}

function generalPage(settings, catalogs) {
    const page = new Adw.PreferencesPage({name: 'general', title: _('General'), icon_name: 'preferences-system-symbolic'});
    page.add(languageGroup(settings, catalogs));
    page.add(accountsGroup(settings));
    page.add(displayGroup(settings));
    return page;
}

function quotasPage(settings) {
    const page = new Adw.PreferencesPage({name: 'quotas', title: _('Quotas'), icon_name: 'claude-quota-usage-symbolic'});
    page.add(thresholdsGroup(settings));
    SCOPES.forEach(scope => page.add(quotaGroup(settings, scope)));
    return page;
}

export default class ClaudeQuotaPreferences extends ExtensionPreferences {
    // The bindings and handlers below are the settings object's only referrers, and it owns
    // their closures in turn — a cycle GJS is free to collect, after which every row quietly
    // stops following the key it is bound to. The window outlives them and holds it instead.
    fillPreferencesWindow(window) {
        window._settings = this.getSettings();
        window._pages = [];
        const catalogs = catalogFiles(this.dir, this.metadata['gettext-domain']);
        Gtk.IconTheme.get_for_display(window.get_display()).add_search_path(`${this.path}/icons`);
        this._fill(window, catalogs);
        window._settings.connect(`changed::${LANGUAGE_KEY}`, () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._fill(window, catalogs);
            return GLib.SOURCE_REMOVE;
        }));
        window.set_default_size(640, 820);
    }

    // Every string is read once, as its widget is built, so a new language means new pages.
    // Each build gets a settings object of its own, so the old rows' handlers go with them.
    _fill(window, catalogs) {
        this._installLanguage(window._settings, catalogs);
        const visible = window.visible_page_name;
        window._pages.forEach(page => window.remove(page));
        if (window._pageSettings)
            GObject.signal_handlers_destroy(window._pageSettings);
        window._pageSettings = this.getSettings();
        window._pages = [generalPage(window._pageSettings, catalogs), quotasPage(window._pageSettings)];
        window._pages.forEach(page => window.add(page));
        if (visible)
            window.visible_page_name = visible;
    }

    _installLanguage(settings, catalogs) {
        installLanguage({
            language: settings.get_string(LANGUAGE_KEY),
            catalogs,
            system: {
                gettext: this.gettext.bind(this),
                ngettext: this.ngettext.bind(this),
                pgettext: this.pgettext.bind(this),
            },
        });
    }
}
