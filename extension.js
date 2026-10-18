import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {attemptRecord} from './lib/attempts.js';
import {credentialsRenewed} from './lib/credentials.js';
import {_, resetTranslator, setTranslator} from './lib/i18n.js';
import {numberLocale, timeLocale} from './lib/format.js';
import {quotas} from './lib/model.js';
import {thresholdsFrom} from './lib/notify.js';
import {isBlocked, markExpired, markSeverity, maxAgeFor, minIntervalWait, nextPollSeconds, pollDelay, shouldFetchOnOpen} from './lib/policy.js';
import {KEYS, readSettings} from './lib/settings.js';
import {adoptShared, applyResult} from './lib/state.js';
import {accountEmail, sharedUsage} from './lib/usage.js';
import {panelView, popupView} from './lib/view.js';
import {Alerts} from './ui/alerts.js';
import {PanelStrip, panelScheme} from './ui/panel-fit.js';
import {Poller} from './ui/poller.js';
import {PopupBody} from './ui/popup-body.js';
import {Store} from './ui/store.js';

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init({iconPath, prefs, openPrefs}) {
        super._init(0.5, _('Claude Quota'));
        this._iconPath = iconPath;
        this._prefs = prefs;
        this._openPrefs = openPrefs;
        this._prefsSignals = [];
        this._store = new Store();
        this._settings = St.Settings.get();
        this._destroyed = false;
        this._quotas = [];
        this._error = null;
        this._service = null;
        this._refreshing = false;
        this._fetchedAt = null;
        this._block = null;
        this._lastRequestAt = null;
        this._accountEmail = null;
        this._rateLimitStreak = 0;
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
            store: this._store,
            onResult: result => this._handleResult(result),
            onServiceStatus: service => this._handleServiceStatus(service),
            onCredentials: expiry => this._handleCredentials(expiry),
            onDue: () => this._refresh('timer'),
            onSent: () => this._handleSent(),
        });
        this._seenExpiry = this._poller.credentialExpiry();
        this._alerts = new Alerts({
            iconPath: this._iconPath,
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
        this._panel = new PanelStrip({container: this.container, box: this._panelQuotas, icon: this._icon});
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

    _adoptCache(cached) {
        if (cached === null)
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
        if (!credentialsRenewed(this._seenExpiry, expiry))
            return;
        this._seenExpiry = expiry;
        this._block = null;
        this._rateLimitStreak = 0;
        this._refresh('credentials');
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
        return sharedUsage();
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
        this._accountEmail = accountEmail();
        this._adoptShared(now);
        this._syncAlerts(now);
        const settled = pollDelay(this._fetchedAt, now, maxAgeFor(trigger));
        if (settled > 0) {
            this._poller.schedule(settled);
            this._renderSafely();
            return;
        }
        if (isBlocked(this._block?.until, now)) {
            this._poller.schedule(nextPollSeconds((this._block.until - now) / 1000));
            this._render();
            return;
        }
        const wait = minIntervalWait(this._lastRequestAt, now);
        if (wait > 0) {
            this._poller.schedule(wait);
            this._render();
            return;
        }
        this._refreshing = true;
        this._renderSafely();
        const outcome = await this._settle(trigger);
        if (this._destroyed || outcome === 'superseded')
            return;
        this._refreshing = false;
        this._renderSafely();
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

    _handleServiceStatus(service) {
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
            accountEmail: this._accountEmail,
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
        setTranslator({
            gettext: this.gettext.bind(this),
            ngettext: this.ngettext.bind(this),
            pgettext: this.pgettext.bind(this),
        });
        this._indicator = new Indicator({
            iconPath: `${this.path}/icons/claude-quota-symbolic.svg`,
            prefs: this.getSettings(),
            openPrefs: () => this.openPreferences(),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        resetTranslator();
    }
}
