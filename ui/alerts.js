import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {_} from '../lib/i18n.js';
import {alertPlan, alertRefresh, refreshDelayMs} from '../lib/notify.js';

const URGENCY = {
    warning: MessageTray.Urgency.NORMAL,
    critical: MessageTray.Urgency.HIGH,
};

export class Alerts {
    constructor({iconPath, onActivate, onTick}) {
        this._iconPath = iconPath;
        this._onActivate = onActivate;
        this._onTick = onTick;
        this._live = new Map();
        this._source = null;
        this._timerId = null;
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
        notification.connect('activated', () => this._onActivate());
        notification.connect('destroy', () => this._live.delete(alert.key));
        this._live.set(alert.key, notification);
        source.addNotification(notification);
    }

    _withdrawAlert(key) {
        const notification = this._live.get(key);
        if (notification === undefined)
            return;
        this._live.delete(key);
        notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
    }

    sync({quotas, fired, thresholds, now, locale, percentLocale}) {
        const plan = alertPlan({quotas, fired, thresholds, now, locale, percentLocale});
        plan.withdraw.forEach(key => this._withdrawAlert(key));
        plan.post.forEach(alert => this._postAlert(alert));
        return {fired: plan.fired, changed: plan.post.length > 0 || plan.withdraw.length > 0};
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

    _refreshAlerts({quotas, fired, now, locale, percentLocale}) {
        alertRefresh({quotas, fired, now, locale, percentLocale}).forEach(alert => {
            const notification = this._live.get(alert.key);
            if (notification !== undefined)
                this._rewrite(notification, alert);
        });
    }

    // The tick re-plans as well as re-words, so a window ending while the extension is
    // rate-limited withdraws within the minute instead of waiting for a fetch it is not
    // allowed to make. It exists only while something is on screen to correct.
    _trackAlertRefresh() {
        if (this._live.size === 0) {
            this._stopAlertRefresh();
            return;
        }
        if (this._timerId)
            return;
        this._armAlertRefresh();
    }

    // One shot that re-arms from the tick, rather than a repeating timer: each arming is
    // measured from the clock, so the cadence cannot drift and a suspended laptop resumes on
    // the boundary instead of wherever it left off. The id is cleared before the sync, which
    // is what lets _trackAlertRefresh arm the next one.
    _armAlertRefresh() {
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, refreshDelayMs(new Date()), () => {
            this._timerId = null;
            this._onTick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopAlertRefresh() {
        if (!this._timerId)
            return;
        GLib.Source.remove(this._timerId);
        this._timerId = null;
    }

    refresh({quotas, fired, now, locale, percentLocale}) {
        this._refreshAlerts({quotas, fired, now, locale, percentLocale});
        this._trackAlertRefresh();
    }

    destroy() {
        this._stopAlertRefresh();
        this._live.clear();
        this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._source = null;
    }
}
