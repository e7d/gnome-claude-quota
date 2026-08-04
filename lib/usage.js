import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

function accessToken() {
    let contents;
    try {
        [, contents] = Gio.File.new_for_path(CREDENTIALS_PATH).load_contents(null);
    } catch {
        throw new Error('Cannot read ~/.claude/.credentials.json');
    }
    const token = JSON.parse(new TextDecoder().decode(contents))?.claudeAiOauth?.accessToken;
    if (!token)
        throw new Error('No Claude token in ~/.claude/.credentials.json');
    return token;
}

export class UsageClient {
    constructor() {
        this._session = new Soup.Session({timeout: 10});
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }

    async fetch(cancellable) {
        const message = Soup.Message.new('GET', ENDPOINT);
        message.request_headers.append('Authorization', `Bearer ${accessToken()}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        const status = message.get_status();
        if (status === Soup.Status.UNAUTHORIZED)
            throw new Error('Token expired — run Claude Code once');
        if (status !== Soup.Status.OK)
            throw new Error(`Usage request failed (HTTP ${status})`);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }
}
