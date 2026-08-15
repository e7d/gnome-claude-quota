import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {appendRecord} from '../lib/attempts.js';
import {deserialize, serialize} from '../lib/cache.js';

export class Store {
    _cachePath() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-quota', 'usage.json']);
    }

    attemptsPath() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-quota', 'attempts.jsonl']);
    }

    load() {
        let contents;
        try {
            [, contents] = Gio.File.new_for_path(this._cachePath()).load_contents(null);
        } catch {
            return null;
        }
        return deserialize(new TextDecoder().decode(contents));
    }

    save({limits, fetchedAt, fired}) {
        const file = Gio.File.new_for_path(this._cachePath());
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch {
        }
        try {
            file.replace_contents(
                new TextEncoder().encode(serialize(limits, fetchedAt, fired)),
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

    appendAttempt(record) {
        const file = Gio.File.new_for_path(this.attemptsPath());
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
}
