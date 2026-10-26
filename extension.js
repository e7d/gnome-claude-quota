import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {attemptRecord} from './lib/attempts.js';
import {accountDirs, configDir, defaultDir, displayPath, shownDirs} from './lib/config-dir.js';
import {credentialsRenewed} from './lib/credentials.js';
import {_, resetTranslator} from './lib/i18n.js';
import {installLanguage} from './lib/language.js';
import {numberLocale, timeLocale} from './lib/format.js';
import {quotas} from './lib/model.js';
import {thresholdsFrom} from './lib/notify.js';
import {isOwnPrefsWindow} from './lib/prefs-window.js';
import {isBlocked, markExpired, markSeverity, maxAgeFor, minIntervalWait, nextPollSeconds, pollDelay, shouldFetchOnOpen} from './lib/policy.js';
import {ACCOUNT_DIRS_KEY, ACCOUNT_KEY, KEYS, LANGUAGE_KEY, PLAN_KEY, SHOWN_DIRS_KEY, migrateConfigDir, readSettings} from './lib/settings.js';
import {adoptShared, applyResult} from './lib/state.js';
import {accountDetails, hasToken, sharedUsage} from './lib/usage.js';
import {panelView, popupView} from './lib/view.js';
import {Alerts} from './ui/alerts.js';
import {catalogFiles} from './ui/catalog-files.js';
import {EmptyIndicator} from './ui/empty-indicator.js';
import {PanelStrip, panelScheme} from './ui/panel-fit.js';
import {Poller} from './ui/poller.js';
import {PopupBody} from './ui/popup-body.js';
import {ServiceStatus} from './ui/service-status.js';
import {Store} from './ui/store.js';

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init({dir, parked, service, iconPath, prefs, openPrefs, onCredentialsWritten, panelPeers}) {
        super._init(0.5, _('Claude Quota'));
        this._iconPath = iconPath;
        this._prefs = prefs;
        this._openPrefs = openPrefs;
        this._onCredentialsWritten = onCredentialsWritten;
        this._prefsSignals = [];
        this._dir = dir;
        this._shared = false;
        this._store = new Store({dir: this._dir});
        this._settings = St.Settings.get();
        this._destroyed = false;
        this._quotas = [];
        this._error = null;
        this._service = service;
        this._refreshing = false;
        this._fetchedAt = null;
        this._block = parked.block;
        this._lastRequestAt = null;
        this._accountEmail = null;
        this._accountPlan = null;
        this._rateLimitStreak = parked.rateLimitStreak;
        this._limits = [];
        this._fired = {};
        this._locale = timeLocale({
            LC_ALL: GLib.getenv('LC_ALL'),
            LC_TIME: GLib.getenv('LC_TIME'),
            LANG: GLib.getenv('LANG'),
        });
        this._percentLocale = numberLocale({
            LC_ALL: GLib.getenv('LC_ALL'),
            LC_NUMERIC: GLib.getenv('LC_NUMERIC'),
            LANG: GLib.getenv('LANG'),
        });
        this._poller = new Poller({
            dir: this._dir,
            store: this._store,
            onResult: result => this._handleResult(result),
            onCredentials: expiry => this._handleCredentials(expiry),
            onDue: () => this._refresh('timer'),
            onSent: () => this._handleSent(),
        });
        this._seenExpiry = this._poller.credentialExpiry();
        this._alerts = new Alerts({
            iconPath: this._iconPath,
            title: () => this._title(),
            onActivate: () => this.menu.open(true),
            onTick: () => this._syncAlerts(new Date()),
        });
        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this._icon = new St.Icon({
            style_class: 'system-status-icon cq-panel-icon',
            gicon: Gio.icon_new_for_string(this._iconPath),
        });
        box.add_child(this._icon);
        this._panelQuotas = new St.BoxLayout({style_class: 'cq-panel'});
        box.add_child(this._panelQuotas);
        this.add_child(box);
        this._popup = new PopupBody({
            onRefresh: () => this._refresh('manual'),
            onOpenPrefs: () => {
                this.menu.close();
                this._openPrefs?.();
            },
        });
        this._popup.items.forEach(item => this.menu.addMenuItem(item));
        this._panel = new PanelStrip({
            container: this.container,
            box: this._panelQuotas,
            icon: this._icon,
            peers: () => panelPeers().map(indicator => indicator._panel),
        });
        this._schemeId = this._settings.connect('notify::color-scheme', () => this._render());
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                return;
            this._render();
            if (shouldFetchOnOpen(this._fetchedAt, new Date(), this._block?.until))
                this._refresh('popup-stale');
        });
        this.connect('destroy', () => this._onDestroy());
        this._watchPrefs();
        this._loadCache();
        this._render();
        this._refresh('startup');
    }

    // The file holds a payload we did not author and this runs from _init, so a throw
    // here would fail enable() at every login until the user found the file and deleted it.
    _loadCache() {
        try {
            this._adoptCache(this._store.load());
        } catch (error) {
            logError(error);
            this._limits = [];
            this._quotas = [];
            this._fetchedAt = null;
            this._fired = {};
        }
    }

    _signedIn() {
        return hasToken(this._dir);
    }

    // A cache kept for a folder that has since lost its login holds numbers nothing can
    // refresh, so it waits on disk for the next sign-in instead of reaching the screen.
    _adoptCache(cached) {
        if (cached === null || !this._signedIn())
            return;
        this._limits = cached.limits;
        this._quotas = quotas({limits: cached.limits}, new Date());
        this._fetchedAt = cached.fetchedAt;
        this._fired = cached.fired;
        this._syncAlerts(new Date());
    }

    _saveCache() {
        this._store.save({limits: this._limits, fetchedAt: this._fetchedAt, fired: this._fired});
    }

    get _scheme() {
        return Main.getStyleVariant() === 'light' ? 'light' : 'dark';
    }

    _handleCredentials(expiry) {
        this._onCredentialsWritten();
        if (!credentialsRenewed(this._seenExpiry, expiry)) {
            if (!this._signedIn())
                this._refresh('credentials');
            return;
        }
        this._seenExpiry = expiry;
        this._block = null;
        this._rateLimitStreak = 0;
        this._refresh('credentials');
    }

    // A block belongs to the token that earned it, so it outlives the indicator: turning
    // the account off and on again must not spend a request the server will refuse.
    parked() {
        return {block: this._block, rateLimitStreak: this._rateLimitStreak};
    }

    // With one account the extension's name says enough; beside others, a notification has
    // to say whose quota it is, and the address is the name the user knows the account by.
    setShared(shared) {
        this._shared = shared;
        this.accessible_name = this._title();
    }

    _title() {
        if (!this._shared)
            return _('Claude Quota');
        return `${_('Claude Quota')} · ${this._accountEmail ?? displayPath(this._dir, GLib.get_home_dir())}`;
    }

    _settingsValues() {
        return readSettings({
            int: key => this._prefs.get_int(key),
            boolean: key => this._prefs.get_boolean(key),
        });
    }

    _watchPrefs() {
        KEYS.forEach(key => this._prefsSignals.push(
            this._prefs.connect(`changed::${key}`, () => {
                this._syncAlerts(new Date());
                this._render();
            })));
        [ACCOUNT_KEY, PLAN_KEY].forEach(key => this._prefsSignals.push(
            this._prefs.connect(`changed::${key}`, () => this._render())));
    }

    relanguage() {
        this.accessible_name = this._title();
        this._quotas = quotas({limits: this._limits}, new Date());
        this._render();
    }

    // Guarded for the same reason _render is: it reaches the shell's own message tray, and
    // every caller of it either arms the next poll or runs from _init.
    _syncAlerts(now) {
        try {
            this._planAlerts(now);
        } catch (error) {
            logError(error);
        }
    }

    _planAlerts(now) {
        const dated = markExpired(this._quotas, now);
        const {fired, changed} = this._alerts.sync({
            quotas: dated,
            fired: this._fired,
            thresholds: thresholdsFrom(this._settingsValues()),
            now,
            locale: this._locale,
            percentLocale: this._percentLocale,
        });
        this._fired = fired;
        // The plan can only have moved an entry by dropping or writing one, and both
        // of those leave a key in withdraw or post — so an empty diff has nothing to
        // persist, which is every ordinary poll.
        if (changed)
            this._saveCache();
        this._alerts.refresh({
            quotas: dated,
            fired,
            now,
            locale: this._locale,
            percentLocale: this._percentLocale,
        });
    }

    _sharedUsage() {
        return sharedUsage(this._dir);
    }

    _snapshot() {
        return {
            limits: this._limits,
            quotas: this._quotas,
            error: this._error,
            service: this._service,
            block: this._block,
            fetchedAt: this._fetchedAt,
            seenExpiry: this._seenExpiry,
            rateLimitStreak: this._rateLimitStreak,
        };
    }

    _adopt(state) {
        this._limits = state.limits;
        this._quotas = state.quotas;
        this._error = state.error;
        this._service = state.service;
        this._block = state.block;
        this._fetchedAt = state.fetchedAt;
        this._seenExpiry = state.seenExpiry;
        this._rateLimitStreak = state.rateLimitStreak;
    }

    // The timer is armed before the side effects, not after: a throw in either of them
    // would otherwise take the next poll with it and the indicator would never fetch again.
    _perform(effects, now) {
        if (effects.schedule > 0)
            this._poller.schedule(effects.schedule);
        if (effects.save)
            this._saveCache();
        if (effects.syncAlerts)
            this._syncAlerts(now);
    }

    // Claude Code holds the same payload under its own cache, so whichever of the
    // two was fetched later is the one worth showing — and adopting it costs no
    // request, which is why it is tried before the block and the interval.
    _adoptShared(now) {
        const outcome = adoptShared({state: this._snapshot(), shared: this._sharedUsage(), now});
        if (outcome === null)
            return;
        this._adopt(outcome.state);
        this._store.appendAttempt(attemptRecord({
            now,
            trigger: 'shared',
            endpoint: 'claude-code',
            outcome: 'adopted',
            status: null,
            retryAfter: null,
            durationMs: null,
            tokenExpiresAt: null,
            tokenExpired: false,
            headers: {},
            body: null,
        }));
        this._perform(outcome.effects, now);
    }

    // Time is an input to the plan, so a poll that ends early — settled, blocked, or
    // inside the request floor — is still a poll on which a window can have rolled
    // over. Withdrawing there is what keeps the tray agreeing with the popup.
    async _refresh(trigger) {
        const now = new Date();
        const details = accountDetails(this._dir);
        this._accountEmail = details.email;
        this._accountPlan = details.plan;
        const signedIn = this._signedIn();
        if (signedIn)
            this._adoptShared(now);
        this._syncAlerts(now);
        if (signedIn && this._heldBack(trigger, now))
            return;
        this._refreshing = true;
        this._renderSafely();
        const outcome = await this._settle(trigger);
        if (this._destroyed || outcome === 'superseded')
            return;
        this._refreshing = false;
        this._renderSafely();
    }

    // Each of these saves a request, and a folder with no login spends none: it goes
    // straight to the read that finds it signed out, which is what clears its numbers.
    _heldBack(trigger, now) {
        const settled = pollDelay(this._fetchedAt, now, maxAgeFor(trigger));
        if (settled > 0) {
            this._poller.schedule(settled);
            this._renderSafely();
            return true;
        }
        if (isBlocked(this._block?.until, now)) {
            this._poller.schedule(nextPollSeconds((this._block.until - now) / 1000));
            this._render();
            return true;
        }
        const wait = minIntervalWait(this._lastRequestAt, now);
        if (wait > 0) {
            this._poller.schedule(wait);
            this._render();
            return true;
        }
        return false;
    }

    // Everything past the request runs against the shell itself — the tray, the actors —
    // so a throw there would leave the spinner turning, the refresh button refusing and
    // no timer armed, which is a dead indicator with no way back for the user.
    async _settle(trigger) {
        try {
            return await this._poller.refresh(trigger) ? 'settled' : 'superseded';
        } catch (error) {
            logError(error);
            this._poller.schedule(nextPollSeconds(null));
            return 'failed';
        }
    }

    _handleSent() {
        this._lastRequestAt = new Date();
    }

    _handleResult(result) {
        this._applyResult(result);
        this._renderSafely();
    }

    setService(service) {
        this._service = service;
        this._renderSafely();
    }

    _renderSafely() {
        try {
            this._render();
        } catch (error) {
            logError(error);
        }
    }

    _applyResult(result) {
        const now = new Date();
        const {state, effects} = applyResult({state: this._snapshot(), result, now});
        this._adopt(state);
        this._perform(effects, now);
    }

    _quotaViews(now, settings) {
        return markSeverity(markExpired(this._quotas, now), {
            warning: settings.warning.percent,
            critical: settings.critical.percent,
        });
    }

    _visibleOn(surface, views, visible) {
        return views.filter(quota => visible[quota.scope][surface]);
    }

    _render() {
        const now = new Date();
        const scheme = this._scheme;
        const settings = this._settingsValues();
        const quotaViews = this._quotaViews(now, settings);
        const menuViews = this._visibleOn('menu', quotaViews, settings.visible);
        const view = popupView({
            block: this._block,
            service: this._service,
            error: this._error,
            fetchedAt: this._fetchedAt,
            refreshing: this._refreshing,
            lastRequestAt: this._lastRequestAt,
            accountEmail: settings.account ? this._accountEmail : null,
            accountPlan: settings.plan ? this._accountPlan : null,
            quotaCount: quotaViews.length,
            menuQuotaCount: menuViews.length,
            locale: this._locale,
            now,
        });
        this._popup.update({view, quotas: menuViews, now, scheme, locale: this._locale, percentLocale: this._percentLocale});
        const barScheme = panelScheme();
        const panel = panelView({
            quotas: this._visibleOn('bar', quotaViews, settings.visible),
            hasAnyQuota: quotaViews.length > 0,
            service: this._service,
            error: this._error,
            scheme: barScheme,
            percentLocale: this._percentLocale,
        });
        this._panel.update({cells: panel.cells, issueLast: panel.issueLast, scheme: barScheme});
    }

    _onDestroy() {
        this._destroyed = true;
        this._poller.destroy();
        this._popup.destroy();
        this._panel.destroy();
        this._settings.disconnect(this._schemeId);
        this._prefsSignals.forEach(id => this._prefs.disconnect(id));
        this._prefsSignals = [];
        this._alerts.destroy();
    }
});

export default class ClaudeQuotaExtension extends Extension {
    enable() {
        this._prefs = this.getSettings();
        migrateConfigDir({
            string: key => this._prefs.get_string(key),
            strv: key => this._prefs.get_strv(key),
            setStrv: (key, value) => this._prefs.set_strv(key, value),
            reset: key => this._prefs.reset(key),
        });
        this._applyLanguage = this._languageInstaller(this._prefs);
        this._applyLanguage();
        this._indicators = new Map();
        this._parked = new Map();
        this._placeholder = null;
        this._service = null;
        this._status = new ServiceStatus({
            store: new Store({dir: defaultDir(GLib.get_home_dir())}),
            canPoll: () => [...this._indicators.keys()].some(dir => hasToken(dir)),
            onStatus: service => this._spreadService(service),
        });
        this._prefsSignals = [
            this._prefs.connect(`changed::${ACCOUNT_DIRS_KEY}`, () => this._syncIndicators()),
            this._prefs.connect(`changed::${SHOWN_DIRS_KEY}`, () => this._syncIndicators()),
            this._prefs.connect(`changed::${LANGUAGE_KEY}`, () => this._relanguage()),
        ];
        this._syncIndicators();
    }

    _accountDirs() {
        return accountDirs(this._prefs.get_strv(ACCOUNT_DIRS_KEY), GLib.get_home_dir());
    }

    _shownSetting() {
        return this._prefs.get_strv(SHOWN_DIRS_KEY).map(setting => configDir(setting, GLib.get_home_dir()));
    }

    _shownDirs() {
        return shownDirs({accounts: this._accountDirs(), shown: this._shownSetting()});
    }

    // Indicators that stay shown are kept rather than rebuilt: each one holds a live
    // request, a timer and posted notifications that a rebuild would cut off or repost.
    _syncIndicators() {
        const dirs = this._shownDirs();
        [...this._indicators.keys()].filter(dir => !dirs.includes(dir)).forEach(dir => this._removeIndicator(dir));
        this._syncPlaceholder(dirs);
        dirs.filter(dir => !this._indicators.has(dir)).forEach(dir => this._addIndicator(dir));
        dirs.forEach(dir => this._indicators.get(dir).setShared(dirs.length > 1));
        this._orderIndicators(dirs);
        this._status.pollUnlessArmed();
    }

    _syncPlaceholder(dirs) {
        if (dirs.length > 0) {
            this._placeholder?.destroy();
            this._placeholder = null;
            return;
        }
        const reason = this._accountDirs().length === 0 ? 'no-account' : 'none-shown';
        if (this._placeholder) {
            this._placeholder.setReason(reason);
            return;
        }
        this._placeholder = new EmptyIndicator({
            iconPath: `${this.path}/icons/claude-quota-symbolic.svg`,
            reason,
            onOpenPrefs: () => this._raiseOrOpenPrefs(),
        });
        Main.panel.addToStatusArea(this.uuid, this._placeholder);
        this._placeholder.render();
    }

    _orderedIndicators() {
        return this._shownDirs().map(dir => this._indicators.get(dir)).filter(Boolean);
    }

    _addIndicator(dir) {
        const indicator = new Indicator({
            dir,
            parked: this._parked.get(dir) ?? {block: null, rateLimitStreak: 0},
            service: this._service,
            iconPath: `${this.path}/icons/claude-quota-symbolic.svg`,
            prefs: this._prefs,
            openPrefs: () => this._raiseOrOpenPrefs(),
            onCredentialsWritten: () => this._status.pollUnlessArmed(),
            panelPeers: () => this._orderedIndicators(),
        });
        this._indicators.set(dir, indicator);
        Main.panel.addToStatusArea(this._roleFor(dir), indicator);
    }

    _removeIndicator(dir) {
        const indicator = this._indicators.get(dir);
        this._parked.set(dir, indicator.parked());
        this._indicators.delete(dir);
        indicator.destroy();
    }

    // The first indicator answers to the bare uuid, which is the role every release before
    // this one registered and the one the tooling reaches the indicator through.
    _roleFor(dir) {
        return Main.panel.statusArea[this.uuid] ? `${this.uuid}:${dir}` : this.uuid;
    }

    _orderIndicators(dirs) {
        const indicators = dirs.map(dir => this._indicators.get(dir));
        indicators.slice(1).forEach((indicator, index) =>
            indicator.container.get_parent()?.set_child_above_sibling(indicator.container, indicators[index].container));
        indicators.forEach(indicator => indicator._panel.fit());
    }

    _spreadService(service) {
        this._service = service;
        this._indicators.forEach(indicator => indicator.setService(service));
    }

    _relanguage() {
        this._applyLanguage();
        this._indicators.forEach(indicator => indicator.relanguage());
    }

    // The preferences service refuses a second open while a window is up and raises nothing.
    _raiseOrOpenPrefs() {
        const open = global.get_window_actors().map(actor => actor.meta_window).find(window =>
            isOwnPrefsWindow({appId: window.get_wm_class(), title: window.get_title()}, this.metadata.name));
        if (open)
            Main.activateWindow(open);
        else
            this.openPreferences();
    }

    _languageInstaller(prefs) {
        const catalogs = catalogFiles(this.dir, this.metadata['gettext-domain']);
        const system = {
            gettext: this.gettext.bind(this),
            ngettext: this.ngettext.bind(this),
            pgettext: this.pgettext.bind(this),
        };
        return () => installLanguage({language: prefs.get_string(LANGUAGE_KEY), catalogs, system});
    }

    disable() {
        this._prefsSignals.forEach(id => this._prefs.disconnect(id));
        this._prefsSignals = [];
        this._status.destroy();
        this._status = null;
        this._placeholder?.destroy();
        this._placeholder = null;
        this._indicators.forEach(indicator => indicator.destroy());
        this._indicators = null;
        this._parked = null;
        this._prefs = null;
        resetTranslator();
    }
}
