import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {parseCredentials, tokenExpired} from './credentials.js';
import {NO_LOGIN, describe} from './errors.js';
import {claudeCodeService} from './model.js';
import {parseAccountEmail, parseAccountPlan, parseSharedUsage} from './shared-usage.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const SHARED_USAGE_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']);
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const STATUS_ENDPOINT = 'https://status.claude.com/api/v2/summary.json';

export function credentialsPath() {
    return CREDENTIALS_PATH;
}

export function credentialsExist() {
    return Gio.File.new_for_path(CREDENTIALS_PATH).query_exists(null);
}

function readCredentials() {
    if (!credentialsExist())
        throw fail(NO_LOGIN, {}, {});
    let contents;
    try {
        [, contents] = Gio.File.new_for_path(CREDENTIALS_PATH).load_contents(null);
    } catch {
        throw fail('Cannot read ~/.claude/.credentials.json', {}, {});
    }
    const parsed = parseCredentials(new TextDecoder().decode(contents));
    if (parsed === null)
        throw fail('No Claude token in ~/.claude/.credentials.json', {}, {});
    return parsed;
}

export function credentialExpiry() {
    try {
        return readCredentials().expiresAt;
    } catch {
        return null;
    }
}

function readClaudeConfig() {
    try {
        const [, contents] = Gio.File.new_for_path(SHARED_USAGE_PATH).load_contents(null);
        return new TextDecoder().decode(contents);
    } catch {
        return null;
    }
}

export function sharedUsage() {
    const text = readClaudeConfig();
    return text === null ? null : parseSharedUsage(text);
}

export function accountDetails() {
    const text = readClaudeConfig();
    if (text === null)
        return {email: null, plan: null};
    return {email: parseAccountEmail(text), plan: parseAccountPlan(text)};
}

function fail(msgid, values, extra) {
    const desc = describe(msgid, values);
    return Object.assign(new Error(desc.message), {desc}, extra);
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
            throw fail('Token expired, run Claude Code once', {},
                {expired: true, status: null, headers: {}, body: null, durationMs: null, expiresAt});
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
            throw fail('Cannot reach api.anthropic.com', {},
                {status: null, headers: {}, body: null, durationMs: elapsedMs(startedAt), expiresAt});
        }
        const wire = {
            status: message.status_code,
            headers: responseHeaders(message),
            body: new TextDecoder().decode(bytes.get_data()),
            durationMs: elapsedMs(startedAt),
            expiresAt,
        };
        if (wire.status === Soup.Status.UNAUTHORIZED)
            throw fail('Token expired, run Claude Code once', {}, wire);
        if (wire.status === 429) {
            const retryAfter = Number.parseFloat(message.get_response_headers().get_one('retry-after'));
            throw fail('Rate limited', {}, {
                ...wire,
                rateLimited: true,
                retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
            });
        }
        if (wire.status !== Soup.Status.OK)
            throw fail('Usage request failed (HTTP {status})', {status: wire.status}, {
                ...wire,
                serverError: wire.status >= 500,
            });
        try {
            return {...wire, payload: JSON.parse(wire.body)};
        } catch {
            throw fail('Unexpected response from the usage endpoint', {}, wire);
        }
    }
}

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
