import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {deserialize, serialize} from './lib/cache.js';
import {absoluteTime, captionLine, refreshLine} from './lib/format.js';
import {quotas} from './lib/model.js';
import {brandColor, schemeForForeground} from './lib/theme.js';
import {blockedUntil, isBlocked, markExpired, nextPollSeconds, serviceIssue, shouldFetchOnOpen} from './lib/policy.js';
import {StatusClient, UsageClient} from './lib/usage.js';

const CAPTION_OPACITY = 180;
const SEPARATOR_OPACITY = 120;
const UNKNOWN_SERVICE = 'unknown';
const STATUS_URL = 'https://status.claude.com/';

// The insensitive pseudo-class the shipped theme paints at 50% alpha is what a
// non-reactive item gets, and every child label inherits it.
function displayItem() {
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: true,
        activate: false,
        hover: false,
        can_focus: false,
    });
    item.remove_style_class_name('popup-inactive-menu-item');
    return item;
}

// The top bar keeps its own background whatever the desktop scheme is, and an
// extension can repaint it, so the label colour the theme resolved is the only
// honest answer to what the icon and the quota numbers sit on.
function panelScheme() {
    return schemeForForeground(Main.panel.get_theme_node().get_foreground_color());
}

function severityClass(base, severity, scheme) {
    return severity === 'normal' ? base : `${base} cq-${severity}-${scheme}`;
}

function quotaClass(base, quota, scheme) {
    return severityClass(base, quota.expired ? 'normal' : quota.severity, scheme);
}

function barClass(quota, scheme) {
    const ahead = quota.aheadOfPace && !quota.expired;
    return `cq-bar cq-bar-${scheme}${ahead ? ` cq-bar-ahead-${scheme}` : ''}`;
}

const PaceBar = GObject.registerClass(
class PaceBar extends BarLevel {
    vfunc_repaint() {
        super.vfunc_repaint();
        if (this.overdriveStart >= this.maximumValue)
            return;
        const themeNode = this.get_theme_node();
        const [width, height] = this.get_surface_size();
        const barHeight = themeNode.get_length('-barlevel-height');
        const tickWidth = themeNode.get_length('-barlevel-overdrive-separator-width');
        const radius = Math.min(width, barHeight) / 2;
        let ratio = this.overdriveStart / this.maximumValue;
        if (this.get_text_direction() === Clutter.TextDirection.RTL)
            ratio = 1 - ratio;
        const cr = this.get_context();
        cr.rectangle(
            radius + (width - 2 * radius) * ratio - tickWidth / 2,
            (height - barHeight) / 2, tickWidth, barHeight);
        cr.setSourceColor(themeNode.get_foreground_color());
        cr.fill();
        cr.$dispose();
    }
});

const QuotaBlock = GObject.registerClass(
class QuotaBlock extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'cq-block',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._name = new St.Label({style_class: 'cq-name'});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._percent = new St.Label({style_class: 'cq-percent'});
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(this._name);
        header.add_child(new St.Widget({x_expand: true}));
        header.add_child(this._percent);
        this._bar = new PaceBar({x_expand: true});
        this._caption = new St.Label({style_class: 'cq-caption', opacity: CAPTION_OPACITY});
        this.add_child(header);
        this.add_child(this._bar);
        this.add_child(this._caption);
    }

    update(quota, now, scheme) {
        this._name.text = quota.name;
        this._percent.text = quota.expired ? '-' : `${quota.percent}%`;
        this._percent.style_class = quotaClass('cq-percent', quota, scheme);
        this._bar.value = quota.expired ? 0 : quota.percent / 100;
        this._bar.overdriveStart = quota.expired ? 1 : (quota.windowProgress ?? 1);
        this._bar.style_class = barClass(quota, scheme);
        this._caption.visible = !quota.expired && quota.resetsAt !== null;
        if (this._caption.visible)
            this._caption.text = captionLine(quota, now);
    }
});

const RefreshItem = GObject.registerClass(
class RefreshItem extends PopupMenu.PopupMenuItem {
    activate(event) {
        this.emit('activate', event);
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(iconPath) {
        super._init(0.5, 'Claude Quota');
        this._client = new UsageClient();
        this._status = new StatusClient();
        this._settings = St.Settings.get();
        this._cancellable = null;
        this._destroyed = false;
        this._quotas = [];
        this._blocks = [];
        this._error = null;
        this._serviceStatus = null;
        this._refreshing = false;
        this._fetchedAt = null;
        this._blockedUntil = null;
        this._timerId = null;
        this._limits = [];
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            style_class: 'system-status-icon',
            gicon: Gio.icon_new_for_string(iconPath),
        });
        box.add_child(this._icon);
        this._panelQuotas = new St.BoxLayout({style_class: 'cq-panel'});
        box.add_child(this._panelQuotas);
        this.add_child(box);
        this._meta = displayItem();
        this._metaBox = new St.BoxLayout({
            style_class: 'cq-meta',
            orientation: Clutter.Orientation.VERTICAL,
            opacity: CAPTION_OPACITY,
            x_expand: true,
        });
        this._refreshLabel = new St.Label();
        this._metaBox.add_child(this._refreshLabel);
        this._meta.add_child(this._metaBox);
        this._message = displayItem();
        this._messageBox = new St.BoxLayout({
            style_class: 'cq-message',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._messageLabel = new St.Label();
        this._messageLabel.clutter_text.line_wrap = true;
        this._messageLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._messageLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._messageBox.add_child(this._messageLabel);
        this._message.add_child(this._messageBox);
        this._body = displayItem();
        this._blockBox = new St.BoxLayout({
            style_class: 'cq-body',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._body.add_child(this._blockBox);
        this._refreshItem = new RefreshItem('Refresh now');
        this._refreshItem.connect('activate', () => this._refresh());
        this._statusItem = new PopupMenu.PopupMenuItem('Claude status');
        this._statusItem.connect('activate', () => Gio.AppInfo.launch_default_for_uri(STATUS_URL, null));
        this._bodySeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._messageSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._body);
        this.menu.addMenuItem(this._bodySeparator);
        this.menu.addMenuItem(this._meta);
        this.menu.addMenuItem(this._refreshItem);
        this.menu.addMenuItem(this._messageSeparator);
        this.menu.addMenuItem(this._message);
        this.menu.addMenuItem(this._statusItem);
        this._schemeId = this._settings.connect('notify::color-scheme', () => this._render());
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                return;
            this._render();
            if (shouldFetchOnOpen(this._fetchedAt, new Date(), this._blockedUntil))
                this._refresh();
        });
        this.connect('destroy', () => this._onDestroy());
        this._loadCache();
        this._render();
        this._refresh();
    }

    _cachePath() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-quota', 'usage.json']);
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
    }

    _saveCache() {
        const file = Gio.File.new_for_path(this._cachePath());
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch {
        }
        try {
            file.replace_contents(
                new TextEncoder().encode(serialize(this._limits, this._fetchedAt)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (error) {
            logError(error);
        }
    }

    get _scheme() {
        return Main.getStyleVariant() === 'light' ? 'light' : 'dark';
    }

    _scheduleNext(seconds) {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, seconds, () => {
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        const now = new Date();
        if (isBlocked(this._blockedUntil, now)) {
            this._scheduleNext(nextPollSeconds((this._blockedUntil - now) / 1000));
            this._render();
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._cancellable?.cancel();
        this._cancellable = cancellable;
        this._refreshing = true;
        this._renderSafely();
        await this._fetchCycle(cancellable);
        if (this._destroyed || this._cancellable !== cancellable)
            return;
        this._refreshing = false;
        this._renderSafely();
    }

    async _fetchCycle(cancellable) {
        const result = await this._fetchResult(cancellable);
        if (result === null || this._destroyed || this._cancellable !== cancellable)
            return;
        this._applyResult(result);
        this._renderSafely();
        if (!result.serverError)
            return;
        await this._refreshServiceStatus(cancellable);
        if (this._destroyed || this._cancellable !== cancellable)
            return;
        this._renderSafely();
    }

    async _refreshServiceStatus(cancellable) {
        try {
            this._serviceStatus = await this._status.fetch(cancellable) ?? UNKNOWN_SERVICE;
        } catch {
            this._serviceStatus = UNKNOWN_SERVICE;
        }
    }

    _renderSafely() {
        try {
            this._render();
        } catch (error) {
            logError(error);
        }
    }

    async _fetchResult(cancellable) {
        try {
            const payload = await this._client.fetch(cancellable);
            return {payload, error: null, retryAfter: null, serverError: false};
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return null;
            return {
                payload: null,
                error: error.message,
                retryAfter: error.retryAfter ?? null,
                serverError: error.serverError ?? false,
            };
        }
    }

    _applyResult(result) {
        if (result.error === null) {
            this._limits = Array.isArray(result.payload?.limits) ? result.payload.limits : [];
            this._quotas = quotas(result.payload, new Date());
            this._error = null;
            this._serviceStatus = null;
            this._blockedUntil = null;
            this._fetchedAt = new Date();
            this._saveCache();
            this._scheduleNext(nextPollSeconds(null));
            return;
        }
        this._error = result.error;
        // Named before status.claude.com has answered, so the line appears with the
        // first failed poll and is only ever refined, never introduced late.
        this._serviceStatus = result.serverError ? UNKNOWN_SERVICE : null;
        this._blockedUntil = blockedUntil(result.retryAfter, new Date());
        this._scheduleNext(nextPollSeconds(result.retryAfter));
    }

    _composeMessage(now) {
        if (this._error === null || isBlocked(this._blockedUntil, now))
            return null;
        const issue = serviceIssue(this._serviceStatus);
        return issue ? `${issue.emoji} ${issue.text}` : this._error;
    }

    _renderMessage(now, hasQuotas) {
        const message = this._composeMessage(now) ?? (hasQuotas ? '' : 'Loading…');
        this._refreshLabel.text = refreshLine(this._fetchedAt, now);
        this._messageLabel.text = message;
        this._message.visible = message !== '';
        this._messageSeparator.visible = message !== '';
    }

    _renderActions(now) {
        const stale = shouldFetchOnOpen(this._fetchedAt, now, this._blockedUntil);
        this._refreshItem.label.text = this._refreshLabelText(now, stale);
        this._refreshItem.setSensitive(!this._refreshing && stale);
        this._statusItem.visible = this._error !== null && !isBlocked(this._blockedUntil, now);
    }

    _refreshLabelText(now, stale) {
        if (this._refreshing)
            return 'Refreshing…';
        if (isBlocked(this._blockedUntil, now))
            return `Refresh at ${absoluteTime(this._blockedUntil, now)}`;
        if (!stale)
            return 'Up to date';
        return 'Refresh now';
    }

    _render() {
        const now = new Date();
        const scheme = this._scheme;
        const quotaViews = markExpired(this._quotas, now);
        this._renderActions(now);
        this._renderPanel(quotaViews);
        if (this._blocks.length !== quotaViews.length) {
            this._blockBox.destroy_all_children();
            this._blocks = quotaViews.map(() => {
                const block = new QuotaBlock();
                this._blockBox.add_child(block);
                return block;
            });
        }
        quotaViews.forEach((quota, index) => this._blocks[index].update(quota, now, scheme));
        const hasQuotas = quotaViews.length > 0;
        this._body.visible = hasQuotas;
        this._bodySeparator.visible = hasQuotas;
        this._renderMessage(now, hasQuotas);
    }

    _panelSeparator() {
        return new St.Label({
            text: '·',
            y_align: Clutter.ActorAlign.CENTER,
            opacity: SEPARATOR_OPACITY,
        });
    }

    _renderPanel(quotaViews) {
        const scheme = panelScheme();
        this._icon.style = `color: ${brandColor(scheme)};`;
        this._panelQuotas.destroy_all_children();
        if (!quotaViews.length) {
            this._panelQuotas.add_child(new St.Label({
                text: this._error ? '-' : '…',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        quotaViews.forEach((quota, index) => {
            if (index > 0)
                this._panelQuotas.add_child(this._panelSeparator());
            this._panelQuotas.add_child(new St.Label({
                text: quota.expired ? `${quota.short} -` : `${quota.short} ${quota.percent}%`,
                style_class: quotaClass('cq-panel-quota', quota, scheme),
                y_align: Clutter.ActorAlign.CENTER,
            }));
        });
        const issue = serviceIssue(this._serviceStatus);
        if (!issue)
            return;
        this._panelQuotas.add_child(this._panelSeparator());
        this._panelQuotas.add_child(new St.Label({
            text: issue.emoji,
            style_class: 'cq-panel-issue',
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }

    _onDestroy() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        this._settings.disconnect(this._schemeId);
        this._cancellable?.cancel();
        this._client.destroy();
        this._status.destroy();
    }
});

export default class ClaudeQuotaExtension extends Extension {
    enable() {
        this._indicator = new Indicator(`${this.path}/icons/claude-quota-symbolic.svg`);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
