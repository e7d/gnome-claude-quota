import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {claudeCodeStatus} from './model.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const STATUS_ENDPOINT = 'https://status.claude.com/api/v2/summary.json';

function accessToken() {
    let contents;
    try {
        [, contents] = Gio.File.new_for_path(CREDENTIALS_PATH).load_contents(null);
    } catch {
        throw new Error('Cannot read ~/.claude/.credentials.json');
    }
    let data;
    try {
        data = JSON.parse(new TextDecoder().decode(contents));
    } catch {
        throw new Error('Cannot parse ~/.claude/.credentials.json');
    }
    const token = data?.claudeAiOauth?.accessToken;
    if (!token)
        throw new Error('No Claude token in ~/.claude/.credentials.json');
    return token;
}

function responseHeaders(message) {
    const headers = {};
    message.get_response_headers().foreach((name, value) => {
        headers[name] = value;
    });
    return headers;
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

    async fetch(cancellable) {
        const message = Soup.Message.new('GET', ENDPOINT);
        message.request_headers.append('Authorization', `Bearer ${accessToken()}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw error;
            throw new Error('Cannot reach api.anthropic.com');
        }
        const status = message.status_code;
        const headers = responseHeaders(message);
        if (status === Soup.Status.UNAUTHORIZED)
            throw Object.assign(new Error('Token expired, run Claude Code once'), {status, headers});
        if (status === 429) {
            const error = new Error('Rate limited');
            const retryAfter = Number.parseFloat(message.get_response_headers().get_one('retry-after'));
            error.retryAfter = Number.isFinite(retryAfter) ? retryAfter : null;
            error.rateLimited = true;
            error.status = status;
            error.headers = headers;
            throw error;
        }
        if (status !== Soup.Status.OK) {
            const error = new Error(`Usage request failed (HTTP ${status})`);
            error.serverError = status >= 500;
            error.status = status;
            error.headers = headers;
            throw error;
        }
        try {
            return {payload: JSON.parse(new TextDecoder().decode(bytes.get_data())), status, headers};
        } catch {
            throw Object.assign(new Error('Unexpected response from the usage endpoint'), {status, headers});
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
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw error;
            return null;
        }
        if (message.status_code !== Soup.Status.OK)
            return null;
        try {
            return claudeCodeStatus(JSON.parse(new TextDecoder().decode(bytes.get_data())));
        } catch {
            return null;
        }
    }
}
