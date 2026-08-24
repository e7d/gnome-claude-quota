import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {attemptRecord, outcomeFor} from '../lib/attempts.js';
import {STATUS_POLL_SECONDS} from '../lib/policy.js';
import {UNKNOWN_SERVICE} from '../lib/state.js';
import {StatusClient, UsageClient, credentialExpiry, credentialsPath} from '../lib/usage.js';

const CREDENTIALS_SETTLE_SECONDS = 2;

export class Poller {
    constructor({store, onResult, onServiceStatus, onCredentials, onDue, onSent}) {
        this._store = store;
        this._onResult = onResult;
        this._onServiceStatus = onServiceStatus;
        this._onCredentials = onCredentials;
        this._onDue = onDue;
        this._onSent = onSent;
        this._client = new UsageClient();
        this._status = new StatusClient();
        this._cancellable = null;
        this._timerId = null;
        this._credentialsMonitor = null;
        this._credentialsSignal = 0;
        this._credentialsSettleId = 0;
        this._destroyed = false;
        this._statusCancellable = null;
        this._statusTimerId = 0;
        this._watchCredentials();
        this._pollStatus();
    }

    schedule(seconds) {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, seconds, () => {
            this._timerId = null;
            this._onDue();
            return GLib.SOURCE_REMOVE;
        });
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

    credentialExpiry() {
        return credentialExpiry();
    }

    _onCredentialsWritten() {
        this._onCredentials(this.credentialExpiry());
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

    async _refreshServiceStatus(cancellable, trigger) {
        let result;
        try {
            result = await this._status.fetch(cancellable);
        } catch {
            return UNKNOWN_SERVICE;
        }
        this._recordAttempt({...result, expired: false, retryAfter: null, rateLimited: false}, trigger, 'status');
        return result.value ?? UNKNOWN_SERVICE;
    }

    _recordAttempt(result, trigger, endpoint = 'usage') {
        if (endpoint === 'usage' && result.durationMs !== null)
            this._onSent();
        this._store.appendAttempt(attemptRecord({
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

    // Returns whether this call is still the one in progress once it settles, so a
    // caller that awaited it knows whether a later refresh has already superseded it.
    async refresh(trigger) {
        const cancellable = new Gio.Cancellable();
        this._cancellable?.cancel();
        this._cancellable = cancellable;
        const result = await this._fetchResult(cancellable, trigger);
        if (result === null || this._destroyed || this._cancellable !== cancellable)
            return false;
        this._onResult(result);
        return this._cancellable === cancellable;
    }

    _pollStatus() {
        const cancellable = new Gio.Cancellable();
        this._statusCancellable?.cancel();
        this._statusCancellable = cancellable;
        this._refreshServiceStatus(cancellable, 'status-timer').then(service => {
            if (this._destroyed || this._statusCancellable !== cancellable)
                return;
            this._onServiceStatus(service);
            this._scheduleStatus();
        }).catch(logError);
    }

    _scheduleStatus() {
        this._statusTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, STATUS_POLL_SECONDS, () => {
                this._statusTimerId = 0;
                this._pollStatus();
                return GLib.SOURCE_REMOVE;
            });
    }

    destroy() {
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
        if (this._statusTimerId) {
            GLib.Source.remove(this._statusTimerId);
            this._statusTimerId = 0;
        }
        this._cancellable?.cancel();
        this._statusCancellable?.cancel();
        this._client.destroy();
        this._status.destroy();
    }
}
