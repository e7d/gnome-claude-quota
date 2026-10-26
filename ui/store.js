import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {appendRecord, recordLine} from '../lib/attempts.js';
import {deserialize, serialize} from '../lib/cache.js';
import {cacheName} from '../lib/config-dir.js';

// Appending costs one open and one write whatever the log already holds, where rewriting it
// whole cost a read, a split and a write of every record on the compositor's own thread.
// Trimming still has to see the file, so it runs on one append in this many and the log
// oscillates just above MAX_RECORDS rather than sitting exactly on it. It also heals a line
// torn by an interrupted write, which is why a session compacts on its first attempt.
const COMPACT_EVERY = 200;

export class Store {
    constructor({dir}) {
        this._sinceCompaction = COMPACT_EVERY;
        this._dir = dir;
    }

    _cachePath() {
        const name = cacheName({
            dir: this._dir,
            home: GLib.get_home_dir(),
            digest: path => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, path, -1),
        });
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-quota', name]);
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

    _ensureParent(file) {
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch {
        }
    }

    save({limits, fetchedAt, fired}) {
        const file = Gio.File.new_for_path(this._cachePath());
        this._ensureParent(file);
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
        this._ensureParent(file);
        try {
            if (this._sinceCompaction >= COMPACT_EVERY)
                this._compactAttempts(file, record);
            else
                this._appendLine(file, record);
        } catch (error) {
            logError(error);
        }
    }

    _appendLine(file, record) {
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(new TextEncoder().encode(recordLine(record)), null);
        stream.close(null);
        this._sinceCompaction += 1;
    }

    _compactAttempts(file, record) {
        file.replace_contents(
            new TextEncoder().encode(appendRecord(this._readAttempts(file), record)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        this._sinceCompaction = 1;
    }
}
