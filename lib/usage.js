import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {parseCredentials, tokenExpired} from './credentials.js';
import {claudeCodeService} from './model.js';
import {parseSharedUsage} from './shared-usage.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const SHARED_USAGE_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']);
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const STATUS_ENDPOINT = 'https://status.claude.com/api/v2/summary.json';

export function credentialsPath() {
    return CREDENTIALS_PATH;
}

function readCredentials() {
    let contents;
    try {
        [, contents] = Gio.File.new_for_path(CREDENTIALS_PATH).load_contents(null);
    } catch {
        throw new Error('Cannot read ~/.claude/.credentials.json');
    }
    const parsed = parseCredentials(new TextDecoder().decode(contents));
    if (parsed === null)
        throw new Error('No Claude token in ~/.claude/.credentials.json');
    return parsed;
}

export function credentialExpiry() {
    try {
        return readCredentials().expiresAt;
    } catch {
        return null;
    }
}

export function sharedUsage() {
    let contents;
    try {
        [, contents] = Gio.File.new_for_path(SHARED_USAGE_PATH).load_contents(null);
    } catch {
        return null;
    }
    return parseSharedUsage(new TextDecoder().decode(contents));
}

function responseHeaders(message) {
    const headers = {};
    message.get_response_headers().foreach((name, value) => {
        headers[name] = value;
    });
    return headers;
}

function elapsedMs(startedAt) {
    return Math.round((GLib.get_monotonic_time() - startedAt) / 1000);
}

export class UsageClient {
    constructor() {
        this._session = new Soup.Session({timeout: 10});
    }

    destroy() {
        if (!this._session)
            return;
        this._session.abort();
        this._session = null;
    }

    async fetch(cancellable, now = new Date()) {
        const {token, expiresAt} = readCredentials();
        if (tokenExpired(expiresAt, now))
            throw Object.assign(new Error('Token expired, run Claude Code once'), {
                expired: true, status: null, headers: {}, body: null, durationMs: null, expiresAt,
            });
        const message = Soup.Message.new('GET', ENDPOINT);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        const startedAt = GLib.get_monotonic_time();
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw error;
            throw Object.assign(new Error('Cannot reach api.anthropic.com'), {
                status: null, headers: {}, body: null, durationMs: elapsedMs(startedAt), expiresAt,
            });
        }
        const wire = {
            status: message.status_code,
            headers: responseHeaders(message),
            body: new TextDecoder().decode(bytes.get_data()),
            durationMs: elapsedMs(startedAt),
            expiresAt,
        };
        if (wire.status === Soup.Status.UNAUTHORIZED)
            throw Object.assign(new Error('Token expired, run Claude Code once'), wire);
        if (wire.status === 429) {
            const retryAfter = Number.parseFloat(message.get_response_headers().get_one('retry-after'));
            throw Object.assign(new Error('Rate limited'), {
                ...wire,
                rateLimited: true,
                retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
            });
        }
        if (wire.status !== Soup.Status.OK)
            throw Object.assign(new Error(`Usage request failed (HTTP ${wire.status})`), {
                ...wire,
                serverError: wire.status >= 500,
            });
        try {
            return {...wire, payload: JSON.parse(wire.body)};
        } catch {
            throw Object.assign(new Error('Unexpected response from the usage endpoint'), wire);
        }
    }
}

// Fetched only after our own call has already failed, so the steady-state poll
// stays a single request and a status.claude.com outage cannot slow it down.
export class StatusClient {
    constructor() {
        this._session = new Soup.Session({timeout: 10});
    }

    destroy() {
        if (!this._session)
            return;
        this._session.abort();
        this._session = null;
    }

    async fetch(cancellable) {
        const message = Soup.Message.new('GET', STATUS_ENDPOINT);
        const startedAt = GLib.get_monotonic_time();
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw error;
            return {
                value: null, status: null, headers: {}, body: null,
                durationMs: elapsedMs(startedAt), error: 'Cannot reach status.claude.com',
            };
        }
        const wire = {
            status: message.status_code,
            headers: responseHeaders(message),
            durationMs: elapsedMs(startedAt),
            body: new TextDecoder().decode(bytes.get_data()),
        };
        if (wire.status !== Soup.Status.OK)
            return {...wire, value: null, error: `Status request failed (HTTP ${wire.status})`};
        try {
            return {...wire, value: claudeCodeService(JSON.parse(wire.body), new Date()), error: null};
        } catch {
            return {...wire, value: null, error: 'Unexpected response from the status endpoint'};
        }
    }
}
