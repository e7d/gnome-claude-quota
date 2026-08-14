import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {appendRecord, attemptRecord, outcomeFor} from './lib/attempts.js';
import {deserialize, serialize} from './lib/cache.js';
import {credentialsRenewed} from './lib/credentials.js';
import {_, resetTranslator, setTranslator} from './lib/i18n.js';
import {numberLocale, timeLocale} from './lib/format.js';
import {quotas} from './lib/model.js';
import {alertPlan, alertRefresh, refreshDelayMs, thresholdsFrom} from './lib/notify.js';
import {isBlocked, markExpired, markSeverity, maxAgeFor, minIntervalWait, nextPollSeconds, pollDelay, shouldFetchOnOpen} from './lib/policy.js';
import {KEYS, readSettings} from './lib/settings.js';
import {adoptShared, applyResult, UNKNOWN_SERVICE} from './lib/state.js';
import {StatusClient, UsageClient, credentialExpiry, credentialsPath, sharedUsage} from './lib/usage.js';
import {panelView, popupView} from './lib/view.js';
import {PanelStrip, panelScheme} from './ui/panel-fit.js';
import {PopupBody} from './ui/popup-body.js';

const CREDENTIALS_SETTLE_SECONDS = 2;
const URGENCY = {
    warning: MessageTray.Urgency.NORMAL,
    critical: MessageTray.Urgency.HIGH,
};

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init({iconPath, prefs, openPrefs}) {
        super._init(0.5, _('Claude Quota'));
        this._iconPath = iconPath;
        this._prefs = prefs;
        this._openPrefs = openPrefs;
        this._source = null;
        this._alerts = new Map();
        this._alertTimerId = null;
        this._prefsSignals = [];
        this._client = new UsageClient();
        this._status = new StatusClient();
        this._settings = St.Settings.get();
        this._cancellable = null;
        this._destroyed = false;
        this._quotas = [];
        this._error = null;
        this._service = null;
        this._refreshing = false;
        this._fetchedAt = null;
        this._block = null;
        this._lastRequestAt = null;
        this._rateLimitStreak = 0;
        this._timerId = null;
        this._credentialsMonitor = null;
        this._credentialsSignal = 0;
        this._credentialsSettleId = 0;
        this._seenExpiry = this._credentialExpiry();
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
        this._watchCredentials();
        this._watchPrefs();
        this._loadCache();
        this._render();
        this._refresh('startup');
    }

    _cachePath() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-quota', 'usage.json']);
    }

    _attemptsPath() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-quota', 'attempts.jsonl']);
    }

    _loadCache() {
        let contents;
        try {
            [, contents] = Gio.File.new_for_path(this._cachePath()).load_contents(null);
        } catch {
            return;
        }
        const cached = deserialize(new TextDecoder().decode(contents));
        if (cached === null)
            return;
        this._limits = cached.limits;
        this._quotas = quotas({limits: cached.limits}, new Date());
        this._fetchedAt = cached.fetchedAt;
        this._fired = cached.fired;
        this._syncAlerts(new Date());
    }

    _saveCache() {
        const file = Gio.File.new_for_path(this._cachePath());
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch {
        }
        try {
            file.replace_contents(
                new TextEncoder().encode(serialize(this._limits, this._fetchedAt, this._fired)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (error) {
            logError(error);
        }
    }

    _readAttempts(file) {
        try {
            const [, contents] = file.load_contents(null);
            return new TextDecoder().decode(contents);
        } catch {
            return '';
        }
    }

    _appendAttempt(record) {
        const file = Gio.File.new_for_path(this._attemptsPath());
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch {
        }
        try {
            file.replace_contents(
                new TextEncoder().encode(appendRecord(this._readAttempts(file), record)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (error) {
            logError(error);
        }
    }

    get _scheme() {
        return Main.getStyleVariant() === 'light' ? 'light' : 'dark';
    }

    // Claude Code replaces the file rather than editing it in place, and a monitor
    // on the file itself stops following at the first replace.
    _watchCredentials() {
        const file = Gio.File.new_for_path(credentialsPath());
        try {
            this._credentialsMonitor = file.get_parent()
                .monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch (error) {
            logError(error);
            return;
        }
        this._credentialsSignal = this._credentialsMonitor.connect('changed', (monitor, changed) => {
            if (changed.get_basename() === file.get_basename())
                this._settleCredentials();
        });
    }

    // One replace arrives as several events, and every one of them that reached a
    // fetch would spend a request against a five-per-five-minutes budget.
    _settleCredentials() {
        if (this._credentialsSettleId)
            GLib.Source.remove(this._credentialsSettleId);
        this._credentialsSettleId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, CREDENTIALS_SETTLE_SECONDS, () => {
                this._credentialsSettleId = 0;
                this._onCredentialsWritten();
                return GLib.SOURCE_REMOVE;
            });
    }

    _credentialExpiry() {
        return credentialExpiry();
    }

    _onCredentialsWritten() {
        const expiry = this._credentialExpiry();
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

    // A Source destroys itself when its last notification is removed, so the
    // reference has to be re-made rather than kept — the shell's own
    // getSystemSource() handles it the same way.
    _notifySource() {
        if (this._source !== null)
            return this._source;
        this._source = new MessageTray.Source({
            title: _('Claude Quota'),
            icon: Gio.icon_new_for_string(this._iconPath),
        });
        this._source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(this._source);
        return this._source;
    }

    _postAlert(alert) {
        const source = this._notifySource();
        const notification = new MessageTray.Notification({
            source,
            title: alert.title,
            body: alert.body,
            gicon: Gio.icon_new_for_string(this._iconPath),
            urgency: URGENCY[alert.level],
            isTransient: false,
        });
        notification.connect('activated', () => this.menu.open(true));
        notification.connect('destroy', () => this._alerts.delete(alert.key));
        this._alerts.set(alert.key, notification);
        source.addNotification(notification);
    }

    _withdrawAlert(key) {
        const notification = this._alerts.get(key);
        if (notification === undefined)
            return;
        this._alerts.delete(key);
        notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
    }

    _syncAlerts(now) {
        const plan = alertPlan({
            quotas: markExpired(this._quotas, now),
            fired: this._fired,
            thresholds: thresholdsFrom(this._settingsValues()),
            now,
            locale: this._locale,
            percentLocale: this._percentLocale,
        });
        plan.withdraw.forEach(key => this._withdrawAlert(key));
        plan.post.forEach(alert => this._postAlert(alert));
        this._fired = plan.fired;
        // The plan can only have moved an entry by dropping or writing one, and both
        // of those leave a key in withdraw or post — so an empty diff has nothing to
        // persist, which is every ordinary poll.
        if (plan.post.length || plan.withdraw.length)
            this._saveCache();
        this._refreshAlerts(now);
        this._trackAlertRefresh();
    }

    // Writing any property schedules an idle that re-stamps datetime to now, so a
    // notification refreshed every minute would read "Just now" forever. Assigning
    // datetime cancels that idle — but only a *different* boxed value emits the notify
    // that does the cancelling, hence a fresh DateTime over the same instant.
    _rewrite(notification, {title, body}) {
        if (notification.title === title && notification.body === body)
            return;
        const raisedAt = notification.datetime.to_unix();
        notification.title = title;
        notification.body = body;
        notification.datetime = GLib.DateTime.new_from_unix_local(raisedAt);
    }

    _refreshAlerts(now) {
        alertRefresh({
            quotas: markExpired(this._quotas, now),
            fired: this._fired,
            now,
            locale: this._locale,
            percentLocale: this._percentLocale,
        }).forEach(alert => {
            const notification = this._alerts.get(alert.key);
            if (notification !== undefined)
                this._rewrite(notification, alert);
        });
    }

    // The tick re-plans as well as re-words, so a window ending while the extension is
    // rate-limited withdraws within the minute instead of waiting for a fetch it is not
    // allowed to make. It exists only while something is on screen to correct.
    _trackAlertRefresh() {
        if (this._alerts.size === 0) {
            this._stopAlertRefresh();
            return;
        }
        if (this._alertTimerId)
            return;
        this._armAlertRefresh();
    }

    // One shot that re-arms from the tick, rather than a repeating timer: each arming is
    // measured from the clock, so the cadence cannot drift and a suspended laptop resumes on
    // the boundary instead of wherever it left off. The id is cleared before the sync, which
    // is what lets _trackAlertRefresh arm the next one.
    _armAlertRefresh() {
        this._alertTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, refreshDelayMs(new Date()), () => {
            this._alertTimerId = null;
            this._syncAlerts(new Date());
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopAlertRefresh() {
        if (!this._alertTimerId)
            return;
        GLib.Source.remove(this._alertTimerId);
        this._alertTimerId = null;
    }

    _scheduleNext(seconds) {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, seconds, () => {
            this._timerId = null;
            this._refresh('timer');
            return GLib.SOURCE_REMOVE;
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

    _perform(effects, now) {
        if (effects.save)
            this._saveCache();
        if (effects.syncAlerts)
            this._syncAlerts(now);
        if (effects.schedule > 0)
            this._scheduleNext(effects.schedule);
    }

    // Claude Code holds the same payload under its own cache, so whichever of the
    // two was fetched later is the one worth showing — and adopting it costs no
    // request, which is why it is tried before the block and the interval.
    _adoptShared(now) {
        const outcome = adoptShared({state: this._snapshot(), shared: this._sharedUsage(), now});
        if (outcome === null)
            return;
        this._adopt(outcome.state);
        this._appendAttempt(attemptRecord({
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
        this._adoptShared(now);
        this._syncAlerts(now);
        const settled = pollDelay(this._fetchedAt, now, maxAgeFor(trigger));
        if (settled > 0) {
            this._scheduleNext(settled);
            this._renderSafely();
            return;
        }
        if (isBlocked(this._block?.until, now)) {
            this._scheduleNext(nextPollSeconds((this._block.until - now) / 1000));
            this._render();
            return;
        }
        const wait = minIntervalWait(this._lastRequestAt, now);
        if (wait > 0) {
            this._scheduleNext(wait);
            this._render();
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._cancellable?.cancel();
        this._cancellable = cancellable;
        this._refreshing = true;
        this._renderSafely();
        await this._fetchCycle(cancellable, trigger);
        if (this._destroyed || this._cancellable !== cancellable)
            return;
        this._refreshing = false;
        this._renderSafely();
    }

    async _fetchCycle(cancellable, trigger) {
        const result = await this._fetchResult(cancellable, trigger);
        if (result === null || this._destroyed || this._cancellable !== cancellable)
            return;
        this._applyResult(result);
        this._renderSafely();
        if (!result.serverError)
            return;
        await this._refreshServiceStatus(cancellable, trigger);
        if (this._destroyed || this._cancellable !== cancellable)
            return;
        this._renderSafely();
    }

    async _refreshServiceStatus(cancellable, trigger) {
        let result;
        try {
            result = await this._status.fetch(cancellable);
        } catch {
            this._service = UNKNOWN_SERVICE;
            return;
        }
        this._recordAttempt({...result, expired: false, retryAfter: null, rateLimited: false}, trigger, 'status');
        this._service = result.value ?? UNKNOWN_SERVICE;
    }

    _renderSafely() {
        try {
            this._render();
        } catch (error) {
            logError(error);
        }
    }

    async _fetchResult(cancellable, trigger) {
        try {
            const {payload, status, headers, body, durationMs, expiresAt} = await this._client.fetch(cancellable);
            return this._recordAttempt({
                payload,
                error: null,
                desc: null,
                retryAfter: null,
                rateLimited: false,
                serverError: false,
                expired: false,
                status,
                headers,
                body,
                durationMs,
                expiresAt,
            }, trigger);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return null;
            return this._recordAttempt({
                payload: null,
                error: error.message,
                desc: error.desc ?? null,
                retryAfter: error.retryAfter ?? null,
                rateLimited: error.rateLimited ?? false,
                serverError: error.serverError ?? false,
                expired: error.expired ?? false,
                status: error.status ?? null,
                headers: error.headers ?? {},
                body: error.body ?? null,
                durationMs: error.durationMs ?? null,
                expiresAt: error.expiresAt ?? null,
            }, trigger);
        }
    }

    _markSent(result, endpoint) {
        if (endpoint === 'usage' && result.durationMs !== null)
            this._lastRequestAt = new Date();
    }

    _recordAttempt(result, trigger, endpoint = 'usage') {
        this._markSent(result, endpoint);
        this._appendAttempt(attemptRecord({
            now: new Date(),
            trigger,
            endpoint,
            outcome: outcomeFor(result),
            status: result.status,
            retryAfter: result.retryAfter,
            durationMs: result.durationMs,
            tokenExpiresAt: result.expiresAt,
            tokenExpired: result.expired,
            headers: result.headers,
            body: result.body,
        }));
        return result;
    }

    _applyResult(result) {
        const now = new Date();
        const {state, effects} = applyResult({state: this._snapshot(), result, now});
        this._adopt(state);
        this._perform(effects, now);
    }

    _quotaViews(now) {
        const settings = this._settingsValues();
        return markSeverity(markExpired(this._quotas, now), {
            warning: settings.warning.percent,
            critical: settings.critical.percent,
        });
    }

    _visibleOn(surface, views) {
        const visible = this._settingsValues().visible;
        return views.filter(quota => visible[quota.scope][surface]);
    }

    _popupViewModel(quotaViews, menuViews, now) {
        return {
            ...popupView({
                block: this._block,
                service: this._service,
                error: this._error,
                fetchedAt: this._fetchedAt,
                refreshing: this._refreshing,
                lastRequestAt: this._lastRequestAt,
                quotaCount: quotaViews.length,
                menuQuotaCount: menuViews.length,
                locale: this._locale,
                now,
            }),
            refreshing: this._refreshing,
        };
    }

    _render() {
        const now = new Date();
        const scheme = this._scheme;
        const quotaViews = this._quotaViews(now);
        const menuViews = this._visibleOn('menu', quotaViews);
        const view = this._popupViewModel(quotaViews, menuViews, now);
        this._popup.update({view, quotas: menuViews, now, scheme, locale: this._locale, percentLocale: this._percentLocale});
        const barScheme = panelScheme();
        const panel = panelView({
            quotas: this._visibleOn('bar', quotaViews),
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
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        if (this._credentialsSettleId) {
            GLib.Source.remove(this._credentialsSettleId);
            this._credentialsSettleId = 0;
        }
        if (this._credentialsMonitor) {
            this._credentialsMonitor.disconnect(this._credentialsSignal);
            this._credentialsMonitor.cancel();
            this._credentialsMonitor = null;
        }
        this._popup.destroy();
        this._panel.destroy();
        this._settings.disconnect(this._schemeId);
        this._prefsSignals.forEach(id => this._prefs.disconnect(id));
        this._prefsSignals = [];
        this._stopAlertRefresh();
        this._alerts.clear();
        this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._source = null;
        this._cancellable?.cancel();
        this._client.destroy();
        this._status.destroy();
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
