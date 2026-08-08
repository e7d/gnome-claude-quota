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
import {absoluteTime, relativeDuration} from './lib/format.js';
import {quotas} from './lib/model.js';
import {blockedUntil, isBlocked, markExpired, nextPollSeconds, shouldFetchOnOpen} from './lib/policy.js';
import {UsageClient} from './lib/usage.js';

const CAPTION_OPACITY = 180;
const SEPARATOR_OPACITY = 120;

function severityClass(base, severity, scheme) {
    return severity === 'normal' ? base : `${base} cq-${severity}-${scheme}`;
}

function quotaClass(base, quota, scheme) {
    if (quota.modelScoped)
        return `${base} cq-model`;
    return severityClass(base, quota.expired ? 'normal' : quota.severity, scheme);
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
        this._bar.add_style_class_name('cq-bar');
        this._barScheme = null;
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
        this._setBarScheme(scheme);
        this._caption.visible = !quota.expired && quota.resetsAt !== null;
        if (!quota.expired && quota.resetsAt)
            this._caption.text = `${relativeDuration(quota.resetsAt, now)} left · ${absoluteTime(quota.resetsAt, now)}`;
    }

    _setBarScheme(scheme) {
        if (this._barScheme === scheme)
            return;
        if (this._barScheme)
            this._bar.remove_style_class_name(`cq-bar-${this._barScheme}`);
        this._bar.add_style_class_name(`cq-bar-${scheme}`);
        this._barScheme = scheme;
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(iconPath) {
        super._init(0.5, 'Claude Quota');
        this._client = new UsageClient();
        this._settings = St.Settings.get();
        this._cancellable = null;
        this._destroyed = false;
        this._quotas = [];
        this._blocks = [];
        this._error = null;
        this._fetchedAt = null;
        this._blockedUntil = null;
        this._timerId = null;
        this._limits = [];
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            style_class: 'system-status-icon',
            gicon: Gio.icon_new_for_string(iconPath),
        }));
        this._panelQuotas = new St.BoxLayout({style_class: 'cq-panel'});
        box.add_child(this._panelQuotas);
        this.add_child(box);
        this._message = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._messageBox = new St.BoxLayout({
            style_class: 'cq-message',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._metaBox = new St.BoxLayout({
            style_class: 'cq-meta',
            orientation: Clutter.Orientation.VERTICAL,
            opacity: CAPTION_OPACITY,
            x_expand: true,
        });
        this._refreshLabel = new St.Label();
        this._nextLabel = new St.Label();
        this._metaBox.add_child(this._refreshLabel);
        this._metaBox.add_child(this._nextLabel);
        this._messageLabel = new St.Label();
        this._messageLabel.clutter_text.line_wrap = true;
        this._messageLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._messageLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._messageBox.add_child(this._metaBox);
        this._messageBox.add_child(this._messageLabel);
        this._message.add_child(this._messageBox);
        this._body = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._blockBox = new St.BoxLayout({
            style_class: 'cq-body',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._body.add_child(this._blockBox);
        this.menu.addMenuItem(this._body);
        this.menu.addMenuItem(this._message);
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
        const result = await this._fetchResult(cancellable);
        if (result === null || this._destroyed || this._cancellable !== cancellable)
            return;
        this._applyResult(result);
        try {
            this._render();
        } catch (error) {
            logError(error);
        }
    }

    async _fetchResult(cancellable) {
        try {
            return {payload: await this._client.fetch(cancellable), error: null, retryAfter: null};
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return null;
            return {payload: null, error: error.message, retryAfter: error.retryAfter ?? null};
        }
    }

    _applyResult(result) {
        if (result.error === null) {
            this._limits = Array.isArray(result.payload?.limits) ? result.payload.limits : [];
            this._quotas = quotas(result.payload, new Date());
            this._error = null;
            this._blockedUntil = null;
            this._fetchedAt = new Date();
            this._saveCache();
            this._scheduleNext(nextPollSeconds(null));
            return;
        }
        this._error = result.error;
        this._blockedUntil = blockedUntil(result.retryAfter, new Date());
        this._scheduleNext(nextPollSeconds(result.retryAfter));
    }

    _composeMessage(now) {
        if (this._error === null || isBlocked(this._blockedUntil, now))
            return null;
        return this._error;
    }

    _composeRefresh(now) {
        if (this._fetchedAt === null)
            return null;
        return `Last refresh: ${absoluteTime(this._fetchedAt, now)}`;
    }

    _composeNext(now) {
        if (!isBlocked(this._blockedUntil, now))
            return null;
        return `Next refresh: ${absoluteTime(this._blockedUntil, now)}`;
    }

    _renderMessage(now, hasQuotas) {
        const refresh = this._composeRefresh(now);
        const next = this._composeNext(now);
        const message = this._composeMessage(now) ?? (hasQuotas ? '' : 'Loading…');
        this._refreshLabel.text = refresh ?? '';
        this._refreshLabel.visible = refresh !== null;
        this._nextLabel.text = next ?? '';
        this._nextLabel.visible = next !== null;
        this._metaBox.visible = refresh !== null || next !== null;
        this._messageLabel.text = message;
        this._messageLabel.visible = message !== '';
        this._message.visible = !hasQuotas || this._error !== null;
    }

    _render() {
        const now = new Date();
        const scheme = this._scheme;
        const quotaViews = markExpired(this._quotas, now);
        this._renderPanel(quotaViews, scheme);
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
        this._renderMessage(now, hasQuotas);
    }

    _renderPanel(quotaViews, scheme) {
        this._panelQuotas.destroy_all_children();
        if (!quotaViews.length) {
            this._panelQuotas.add_child(new St.Label({
                text: this._error ? '-' : '…',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }
        quotaViews.forEach((quota, index) => {
            if (index > 0) {
                this._panelQuotas.add_child(new St.Label({
                    text: '·',
                    y_align: Clutter.ActorAlign.CENTER,
                    opacity: SEPARATOR_OPACITY,
                }));
            }
            this._panelQuotas.add_child(new St.Label({
                text: quota.expired ? `${quota.short} -` : `${quota.short} ${quota.percent}%`,
                style_class: quotaClass('cq-panel-quota', quota, scheme),
                y_align: Clutter.ActorAlign.CENTER,
            }));
        });
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
    }
});

export default class ClaudeQuotaExtension extends Extension {
    enable() {
        this._indicator = new Indicator(`${this.path}/icons/claude-quota.svg`);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
