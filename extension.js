import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {absoluteTime, relativeDuration} from './lib/format.js';
import {quotas} from './lib/model.js';
import {UsageClient} from './lib/usage.js';

const POLL_SECONDS = 60;
const LEGEND = 'tick: window elapsed · red: over pace';
const CAPTION_OPACITY = 180;
const SEPARATOR_OPACITY = 120;

function severityClass(base, severity, scheme) {
    return severity === 'normal' ? base : `${base} cq-${severity}-${scheme}`;
}

const QuotaBlock = GObject.registerClass(
class QuotaBlock extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'cq-block',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._name = new St.Label({style_class: 'cq-name'});
        this._percent = new St.Label({style_class: 'cq-percent'});
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(this._name);
        header.add_child(new St.Widget({x_expand: true}));
        header.add_child(this._percent);
        this._bar = new BarLevel({x_expand: true});
        this._bar.add_style_class_name('cq-bar');
        this._barScheme = null;
        this._caption = new St.Label({style_class: 'cq-caption', opacity: CAPTION_OPACITY});
        this.add_child(header);
        this.add_child(this._bar);
        this.add_child(this._caption);
    }

    update(quota, now, scheme) {
        this._name.text = quota.name;
        this._percent.text = `${quota.percent}%`;
        this._percent.style_class = severityClass('cq-percent', quota.severity, scheme);
        this._bar.value = quota.percent / 100;
        this._bar.overdriveStart = quota.windowProgress ?? 1;
        this._setBarScheme(scheme);
        this._caption.visible = quota.resetsAt !== null;
        if (quota.resetsAt)
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
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            style_class: 'system-status-icon',
            gicon: Gio.icon_new_for_string(iconPath),
        }));
        this._panelQuotas = new St.BoxLayout({style_class: 'cq-panel'});
        box.add_child(this._panelQuotas);
        this.add_child(box);
        this._message = new PopupMenu.PopupMenuItem('Loading…', {reactive: false});
        this._body = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._blockBox = new St.BoxLayout({
            style_class: 'cq-body',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._body.add_child(this._blockBox);
        this._legend = new PopupMenu.PopupMenuItem(LEGEND, {reactive: false});
        this._legend.label.style_class = 'cq-legend';
        this._legend.opacity = CAPTION_OPACITY;
        this.menu.addMenuItem(this._message);
        this.menu.addMenuItem(this._body);
        this.menu.addMenuItem(this._legend);
        this._schemeId = this._settings.connect('notify::color-scheme', () => this._render());
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                return;
            this._render();
            this._refresh();
        });
        this.connect('destroy', () => this._onDestroy());
        this._render();
        this._refresh();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get _scheme() {
        return Main.getStyleVariant() === 'light' ? 'light' : 'dark';
    }

    async _refresh() {
        const cancellable = new Gio.Cancellable();
        this._cancellable?.cancel();
        this._cancellable = cancellable;
        let result;
        try {
            result = {payload: await this._client.fetch(cancellable), error: null};
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            result = {payload: null, error: error.message};
        }
        if (this._destroyed || this._cancellable !== cancellable)
            return;
        if (result.error === null)
            this._quotas = quotas(result.payload, new Date());
        this._error = result.error;
        try {
            this._render();
        } catch (error) {
            logError(error);
        }
    }

    _render() {
        const now = new Date();
        const scheme = this._scheme;
        this._renderPanel(scheme);
        if (this._blocks.length !== this._quotas.length) {
            this._blockBox.destroy_all_children();
            this._blocks = this._quotas.map(() => {
                const block = new QuotaBlock();
                this._blockBox.add_child(block);
                return block;
            });
        }
        this._quotas.forEach((quota, index) => this._blocks[index].update(quota, now, scheme));
        const hasQuotas = this._quotas.length > 0;
        const hasWindowProgress = this._quotas.some(quota => quota.windowProgress !== null);
        this._body.visible = hasQuotas;
        this._legend.visible = hasQuotas && hasWindowProgress;
        this._message.visible = !hasQuotas || this._error !== null;
        this._message.label.text = this._error ?? 'Loading…';
    }

    _renderPanel(scheme) {
        this._panelQuotas.destroy_all_children();
        if (!this._quotas.length) {
            this._panelQuotas.add_child(new St.Label({
                text: this._error ? '—' : '…',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }
        this._quotas.forEach((quota, index) => {
            if (index > 0) {
                this._panelQuotas.add_child(new St.Label({
                    text: '·',
                    y_align: Clutter.ActorAlign.CENTER,
                    opacity: SEPARATOR_OPACITY,
                }));
            }
            this._panelQuotas.add_child(new St.Label({
                text: `${quota.short} ${quota.percent}%`,
                style_class: severityClass('cq-panel-quota', quota.severity, scheme),
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
        this._indicator = new Indicator(`${this.path}/icons/claude-quota-symbolic.svg`);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
