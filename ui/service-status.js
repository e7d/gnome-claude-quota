import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {attemptRecord, outcomeFor} from '../lib/attempts.js';
import {STATUS_POLL_SECONDS} from '../lib/policy.js';
import {UNKNOWN_SERVICE} from '../lib/state.js';
import {StatusClient} from '../lib/usage.js';

// The status page describes the service, not an account, so every indicator shown
// is fed from this one poll rather than spending a request each.
export class ServiceStatus {
    constructor({store, canPoll, onStatus}) {
        this._store = store;
        this._canPoll = canPoll;
        this._onStatus = onStatus;
        this._client = new StatusClient();
        this._cancellable = null;
        this._timerId = 0;
        this._polling = false;
        this._destroyed = false;
    }

    // A checkout with no token has no quotas to explain, and the nested sessions the
    // tooling runs are exactly that — so this is also what keeps a dev shell off the
    // network, the same way a missing token already refuses the usage fetch.
    poll() {
        if (!this._canPoll() || this._polling)
            return;
        const cancellable = new Gio.Cancellable();
        this._cancellable?.cancel();
        this._cancellable = cancellable;
        this._polling = true;
        this._round(cancellable);
    }

    pollUnlessArmed() {
        if (!this._timerId)
            this.poll();
    }

    // The next round is armed whatever this one did. A poller that stops on its first bad
    // answer looks exactly like one with nothing to report, and the badge it feeds is the
    // only thing on screen that would have said otherwise.
    async _round(cancellable) {
        try {
            const service = await this._fetch(cancellable);
            if (!this._destroyed && this._cancellable === cancellable)
                this._onStatus(service);
        } catch (error) {
            logError(error);
        } finally {
            this._polling = false;
        }
        if (!this._destroyed && this._cancellable === cancellable)
            this._schedule();
    }

    async _fetch(cancellable) {
        let result;
        try {
            result = await this._client.fetch(cancellable);
        } catch {
            return UNKNOWN_SERVICE;
        }
        this._record(result);
        return result.value ?? UNKNOWN_SERVICE;
    }

    _record(result) {
        this._store.appendAttempt(attemptRecord({
            now: new Date(),
            trigger: 'status-timer',
            endpoint: 'status',
            outcome: outcomeFor({...result, expired: false, rateLimited: false}),
            status: result.status,
            retryAfter: null,
            durationMs: result.durationMs,
            tokenExpiresAt: result.expiresAt,
            tokenExpired: false,
            headers: result.headers,
            body: result.body,
        }));
    }

    _schedule() {
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, STATUS_POLL_SECONDS, () => {
            this._timerId = 0;
            this.poll();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        this._cancellable?.cancel();
        this._client.destroy();
    }
}
