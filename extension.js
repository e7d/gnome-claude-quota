import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {appendRecord, attemptRecord, outcomeFor} from './lib/attempts.js';
import {deserialize, serialize} from './lib/cache.js';
import {captionLine, percentLine, rateLimitMessage, refreshLine, timeLocale} from './lib/format.js';
import {quotas} from './lib/model.js';
import {availableWidth, fittingCount} from './lib/panel.js';
import {tickRects} from './lib/bar.js';
import {brandColor, schemeForForeground} from './lib/theme.js';
import {isBlocked, markExpired, nextPollSeconds, rateLimitBlock, serviceIssue, shouldFetchOnOpen} from './lib/policy.js';
import {StatusClient, UsageClient} from './lib/usage.js';

const CAPTION_OPACITY = 180;
const SEPARATOR_OPACITY = 120;
const UNKNOWN_SERVICE = 'unknown';
const STATUS_URL = 'https://status.claude.com/';
const SPIN_DURATION_MS = 900;
const TICK_OVERHANG = 2;

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
    item.track_hover = false;
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

function barClass(scheme) {
    return `cq-bar cq-bar-${scheme}`;
}

const PaceBar = GObject.registerClass(
class PaceBar extends BarLevel {
    setPace(ratio) {
        if (this._pace === ratio)
            return;
        this._pace = ratio;
        this.queue_repaint();
    }

    vfunc_repaint() {
        super.vfunc_repaint();
        if (this._pace === null || this._pace === undefined)
            return;
        const themeNode = this.get_theme_node();
        const [width, height] = this.get_surface_size();
        const [hasShadow, shadowColor] = themeNode.lookup_color('-cq-tick-shadow-color', false);
        const {shadow, tick} = tickRects({
            width,
            height,
            barHeight: themeNode.get_length('-barlevel-height'),
            tickWidth: themeNode.get_length('-cq-tick-width'),
            shadowWidth: hasShadow ? themeNode.get_length('-cq-tick-shadow-width') : 0,
            overhang: TICK_OVERHANG,
            ratio: this.get_text_direction() === Clutter.TextDirection.RTL
                ? 1 - this._pace
                : this._pace,
        });
        const cr = this.get_context();
        if (shadow) {
            cr.rectangle(shadow.x, shadow.y, shadow.width, shadow.height);
            cr.setSourceColor(shadowColor);
            cr.fill();
        }
        cr.rectangle(tick.x, tick.y, tick.width, tick.height);
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

    update({quota, now, scheme, locale}) {
        this._name.text = quota.name;
        this._percent.text = percentLine(quota);
        this._percent.style_class = quotaClass('cq-percent', quota, scheme);
        this._bar.value = quota.expired ? 0 : quota.percent / 100;
        this._bar.setPace(quota.expired ? null : quota.windowProgress);
        this._bar.style_class = barClass(scheme);
        this._caption.text = captionLine(quota, now, locale);
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
        this._panelCells = [];
        this._panelSignals = [];
        this._issueLast = false;
        this._fitLaterId = 0;
        this._error = null;
        this._serviceStatus = null;
        this._refreshing = false;
        this._fetchedAt = null;
        this._blockedUntil = null;
        this._rateLimitStreak = 0;
        this._timerId = null;
        this._limits = [];
        this._locale = timeLocale({
            LC_ALL: GLib.getenv('LC_ALL'),
            LC_TIME: GLib.getenv('LC_TIME'),
            LANG: GLib.getenv('LANG'),
        });
        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this._icon = new St.Icon({
            style_class: 'system-status-icon cq-panel-icon',
            gicon: Gio.icon_new_for_string(iconPath),
        });
        box.add_child(this._icon);
        this._panelQuotas = new St.BoxLayout({style_class: 'cq-panel'});
        box.add_child(this._panelQuotas);
        this.add_child(box);
        this._metaBox = new St.BoxLayout({style_class: 'cq-meta', x_expand: true});
        this._refreshLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            opacity: CAPTION_OPACITY,
            x_expand: true,
        });
        this._refreshLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._refreshButton = new St.Button({
            style_class: 'cq-refresh',
            child: new St.Icon({
                style_class: 'popup-menu-icon',
                icon_name: 'view-refresh-symbolic',
            }),
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        this._refreshButton.connect('clicked', () => this._refresh('manual'));
        this._metaBox.add_child(this._refreshLabel);
        this._metaBox.add_child(this._refreshButton);
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
            style_class: 'cq-blocks',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._bodyBox = new St.BoxLayout({
            style_class: 'cq-body',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._bodyBox.add_child(this._metaBox);
        this._bodyBox.add_child(this._blockBox);
        this._body.add_child(this._bodyBox);
        this._issueItem = new PopupMenu.PopupMenuItem('');
        this._issueItem.connect('activate', () => Gio.AppInfo.launch_default_for_uri(STATUS_URL, null));
        this._messageSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._body);
        this.menu.addMenuItem(this._messageSeparator);
        this.menu.addMenuItem(this._message);
        this.menu.addMenuItem(this._issueItem);
        this._schemeId = this._settings.connect('notify::color-scheme', () => this._render());
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                return;
            this._render();
            if (shouldFetchOnOpen(this._fetchedAt, new Date(), this._blockedUntil))
                this._refresh('popup-stale');
        });
        this.connect('destroy', () => this._onDestroy());
        this._watchPanelSpace();
        this._loadCache();
        this._render();
        this._refresh('startup');
    }

    _cachePath() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-quota', 'usage.json']);
    }

    _attemptsPath() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-quota', 'attempts.jsonl']);
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

    _readAttempts(file) {
        try {
            const [, contents] = file.load_contents(null);
            return new TextDecoder().decode(contents);
        } catch {
            return '';
        }
    }

    _appendAttempt(record) {
        const file = Gio.File.new_for_path(this._attemptsPath());
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

    get _scheme() {
        return Main.getStyleVariant() === 'light' ? 'light' : 'dark';
    }

    _scheduleNext(seconds) {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, seconds, () => {
            this._timerId = null;
            this._refresh('timer');
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh(trigger) {
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
        await this._fetchCycle(cancellable, trigger);
        if (this._destroyed || this._cancellable !== cancellable)
            return;
        this._refreshing = false;
        this._renderSafely();
    }

    async _fetchCycle(cancellable, trigger) {
        const result = await this._fetchResult(cancellable, trigger);
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

    async _fetchResult(cancellable, trigger) {
        try {
            const {payload, status, headers} = await this._client.fetch(cancellable);
            return this._recordAttempt({
                payload,
                error: null,
                retryAfter: null,
                rateLimited: false,
                serverError: false,
                status,
                headers,
            }, trigger);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return null;
            return this._recordAttempt({
                payload: null,
                error: error.message,
                retryAfter: error.retryAfter ?? null,
                rateLimited: error.rateLimited ?? false,
                serverError: error.serverError ?? false,
                status: error.status ?? null,
                headers: error.headers ?? {},
            }, trigger);
        }
    }

    _recordAttempt(result, trigger) {
        this._appendAttempt(attemptRecord({
            now: new Date(),
            trigger,
            outcome: outcomeFor(result),
            status: result.status,
            retryAfter: result.retryAfter,
            headers: result.headers,
        }));
        return result;
    }

    _applyResult(result) {
        if (result.error === null) {
            this._limits = Array.isArray(result.payload?.limits) ? result.payload.limits : [];
            this._quotas = quotas(result.payload, new Date());
            this._error = null;
            this._serviceStatus = null;
            this._blockedUntil = null;
            this._rateLimitStreak = 0;
            this._fetchedAt = new Date();
            this._saveCache();
            this._scheduleNext(nextPollSeconds(null));
            return;
        }
        if (result.rateLimited) {
            const block = rateLimitBlock(result.retryAfter, new Date(), this._rateLimitStreak);
            this._rateLimitStreak += 1;
            this._blockedUntil = block.until;
            this._scheduleNext(nextPollSeconds(block.seconds));
            this._error = null;
            this._serviceStatus = null;
            return;
        }
        this._blockedUntil = null;
        this._scheduleNext(nextPollSeconds(result.retryAfter));
        this._error = result.error;
        // Named before status.claude.com has answered, so the line appears with the
        // first failed poll and is only ever refined, never introduced late.
        this._serviceStatus = result.serverError ? UNKNOWN_SERVICE : null;
    }

    _renderMessage(now, hasQuotas) {
        const silenced = isBlocked(this._blockedUntil, now);
        const issue = silenced ? null : serviceIssue(this._serviceStatus);
        const error = silenced || issue || this._error === null ? '' : this._error;
        const throttled = rateLimitMessage(this._blockedUntil, now, this._locale);
        const loading = issue === null && error === '' && !hasQuotas && !silenced;
        const message = loading ? 'Loading…' : throttled || error;
        this._refreshLabel.text = refreshLine(this._fetchedAt, now, this._locale);
        this._issueItem.visible = issue !== null;
        if (issue)
            this._issueItem.label.text = `${issue.emoji} ${issue.text}`;
        this._messageLabel.text = message;
        this._message.visible = message !== '';
        this._messageSeparator.visible = (issue !== null || error !== '' || throttled !== '') && hasQuotas;
        this._body.visible = !loading;
    }

    _renderActions(now) {
        this._refreshButton.reactive = !this._refreshing && !isBlocked(this._blockedUntil, now);
        this._refreshButton.opacity = this._refreshButton.reactive ? 255 : CAPTION_OPACITY;
        if (this._refreshing)
            this._startSpinner();
        else
            this._stopSpinner();
    }

    _startSpinner() {
        const icon = this._refreshButton.child;
        if (icon.get_transition('spin'))
            return;
        icon.set_pivot_point(0.5, 0.5);
        const spin = new Clutter.PropertyTransition({property_name: 'rotation-angle-z'});
        spin.set_from(0);
        spin.set_to(360);
        spin.set_duration(SPIN_DURATION_MS);
        spin.set_repeat_count(-1);
        spin.set_progress_mode(Clutter.AnimationMode.LINEAR);
        icon.add_transition('spin', spin);
    }

    _stopSpinner() {
        const icon = this._refreshButton.child;
        icon.remove_transition('spin');
        icon.rotation_angle_z = 0;
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
        quotaViews.forEach((quota, index) =>
            this._blocks[index].update({quota, now, scheme, locale: this._locale}));
        const hasQuotas = quotaViews.length > 0;
        this._blockBox.visible = hasQuotas;
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
        this._panelCells = this._panelLabels(quotaViews, scheme).map(({label, dotted}) => {
            const actor = new St.BoxLayout({style_class: 'cq-panel-cell'});
            const dot = dotted ? this._panelSeparator() : null;
            if (dot)
                actor.add_child(dot);
            actor.add_child(label);
            this._panelQuotas.add_child(actor);
            return {actor, label, dot};
        });
        this._fitPanel();
    }

    // Each value owns the dot and the gap to its left, so hiding one takes its own
    // spacing with it and every surviving rung ends flush against the button.
    _panelLabels(quotaViews, scheme) {
        const labels = quotaViews.map(quota => ({
            dotted: true,
            label: new St.Label({
                text: `${quota.short} ${percentLine(quota)}`,
                style_class: quotaClass('cq-panel-quota', quota, scheme),
                y_align: Clutter.ActorAlign.CENTER,
            }),
        }));
        if (!labels.length) {
            labels.push({
                dotted: false,
                label: new St.Label({
                    text: this._error ? '-' : '…',
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
        }
        const issue = serviceIssue(this._serviceStatus);
        this._issueLast = issue !== null;
        if (issue) {
            labels.push({
                dotted: false,
                label: new St.Label({
                    text: issue.emoji,
                    style_class: 'cq-panel-issue',
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
        }
        return labels;
    }

    // An incident emoji is kept ahead of every value on purpose: it reports
    // something the user cannot be relied on to have the popup open for.
    get _panelKeepOrder() {
        if (!this._issueLast)
            return this._panelCells;
        const issue = this._panelCells[this._panelCells.length - 1];
        return [issue, ...this._panelCells.slice(0, -1)];
    }

    _showPanelCells(count) {
        const keep = new Set(this._panelKeepOrder.slice(0, count));
        let earlierShown = false;
        this._panelCells.forEach(cell => {
            const visible = keep.has(cell);
            cell.actor.visible = visible;
            if (cell.dot)
                cell.dot.visible = visible && earlierShown;
            earlierShown = earlierShown || visible;
        });
        // An empty box is still a child, and the shell's own box spacing would leave
        // its 4px beside the icon at the bottom of the ladder.
        this._panelQuotas.visible = earlierShown;
    }

    _panelNaturalWidth(count) {
        this._showPanelCells(count);
        const [, natural] = this.container.get_preferred_width(-1);
        return natural;
    }

    _centerOffset() {
        const monitor = Main.layoutManager.findMonitorForActor(Main.panel);
        if (!monitor)
            return 0;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        return 2 * (workArea.x - monitor.x) + workArea.width - monitor.width;
    }

    // Subtracting our own width is what makes the budget independent of the fit
    // that produced it: reading the right box whole would let a shrink widen the
    // budget that caused it, and the panel would oscillate.
    _panelBudget() {
        const center = Main.panel._centerBox;
        const right = Main.panel._rightBox;
        if (!center || !right)
            return null;
        const [, centerWidth] = center.get_preferred_width(-1);
        const [, rightWidth] = right.get_preferred_width(-1);
        const [, ownWidth] = this.container.get_preferred_width(-1);
        return availableWidth({
            panelWidth: Main.panel.width,
            centerWidth,
            centerOffset: this._centerOffset(),
            othersWidth: Math.max(0, rightWidth - ownWidth),
        });
    }

    // The first render runs before addToStatusArea, and measuring a widget that has
    // no stage yet asks St for a theme node it will not resolve. Being added to the
    // panel is itself a fit trigger, so nothing is lost by waiting for it.
    _fitPanel() {
        const cells = this._panelCells.length;
        if (!cells || this.container.get_stage() === null)
            return;
        const available = this._panelBudget();
        if (available === null) {
            this._showPanelCells(cells);
            return;
        }
        this._showPanelCells(fittingCount(
            cells, available, count => this._panelNaturalWidth(count)));
    }

    _queueFit() {
        if (this._fitLaterId)
            return;
        this._fitLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._fitLaterId = 0;
            this._fitPanel();
            return GLib.SOURCE_REMOVE;
        });
    }

    _watchPanelSpace() {
        const watched = [
            [Main.panel, 'notify::width'],
            [Main.panel._centerBox, 'notify::width'],
            [Main.panel._rightBox, 'child-added'],
            [Main.panel._rightBox, 'child-removed'],
        ];
        this._panelSignals = watched
            .filter(([actor]) => actor)
            .map(([actor, signal]) => [actor, actor.connect(signal, () => this._queueFit())]);
    }

    _onDestroy() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        if (this._fitLaterId) {
            global.compositor.get_laters().remove(this._fitLaterId);
            this._fitLaterId = 0;
        }
        this._panelSignals.forEach(([actor, id]) => actor.disconnect(id));
        this._panelSignals = [];
        this._stopSpinner();
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
