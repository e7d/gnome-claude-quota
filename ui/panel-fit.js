import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {availableWidth, fittingCount} from '../lib/panel.js';
import {brandColor, schemeForForeground} from '../lib/theme.js';

const SEPARATOR_OPACITY = 120;

// The top bar keeps its own background whatever the desktop scheme is, and an
// extension can repaint it, so the label colour the theme resolved is the only
// honest answer to what the icon and the quota numbers sit on.
export function panelScheme() {
    return schemeForForeground(Main.panel.get_theme_node().get_foreground_color());
}

export class PanelStrip {
    constructor({container, box, icon}) {
        this._container = container;
        this._box = box;
        this._icon = icon;
        this._cells = [];
        this._issueLast = false;
        this._fitLaterId = 0;
        this._panelSignals = [];
        this._watchPanelSpace();
    }

    _separator() {
        return new St.Label({
            text: '·',
            y_align: Clutter.ActorAlign.CENTER,
            opacity: SEPARATOR_OPACITY,
        });
    }

    // Each value owns the dot and the gap to its left, so hiding one takes its own
    // spacing with it and every surviving rung ends flush against the button.
    _cellActor(cell) {
        const label = new St.Label({text: cell.text, y_align: Clutter.ActorAlign.CENTER});
        if (cell.styleClass !== null)
            label.style_class = cell.styleClass;
        const actor = new St.BoxLayout({style_class: 'cq-panel-cell'});
        const dot = cell.dotted ? this._separator() : null;
        if (dot)
            actor.add_child(dot);
        actor.add_child(label);
        this._box.add_child(actor);
        return {actor, label, dot};
    }

    update({cells, issueLast, scheme}) {
        this._icon.style = `color: ${brandColor(scheme)};`;
        this._box.destroy_all_children();
        this._issueLast = issueLast;
        this._cells = cells.map(cell => this._cellActor(cell));
        this.fit();
    }

    // An incident emoji is kept ahead of every value on purpose: it reports
    // something the user cannot be relied on to have the popup open for.
    get _keepOrder() {
        if (!this._issueLast)
            return this._cells;
        const issue = this._cells[this._cells.length - 1];
        return [issue, ...this._cells.slice(0, -1)];
    }

    _showCells(count) {
        const keep = new Set(this._keepOrder.slice(0, count));
        let earlierShown = false;
        this._cells.forEach(cell => {
            const visible = keep.has(cell);
            cell.actor.visible = visible;
            if (cell.dot)
                cell.dot.visible = visible && earlierShown;
            earlierShown = earlierShown || visible;
        });
        // An empty box is still a child, and the shell's own box spacing would leave
        // its 4px beside the icon at the bottom of the ladder.
        this._box.visible = earlierShown;
    }

    _naturalWidth(count) {
        this._showCells(count);
        const [, natural] = this._container.get_preferred_width(-1);
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
    _budget() {
        const center = Main.panel._centerBox;
        const right = Main.panel._rightBox;
        if (!center || !right)
            return null;
        const [, centerWidth] = center.get_preferred_width(-1);
        const [, rightWidth] = right.get_preferred_width(-1);
        const [, ownWidth] = this._container.get_preferred_width(-1);
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
    fit() {
        if (this._container.get_stage() === null)
            return;
        const cells = this._cells.length;
        if (!cells) {
            this._showCells(0);
            return;
        }
        const available = this._budget();
        if (available === null) {
            this._showCells(cells);
            return;
        }
        this._showCells(fittingCount(
            cells, available, count => this._naturalWidth(count)));
    }

    _queueFit() {
        if (this._fitLaterId)
            return;
        this._fitLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._fitLaterId = 0;
            this.fit();
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

    destroy() {
        if (this._fitLaterId) {
            global.compositor.get_laters().remove(this._fitLaterId);
            this._fitLaterId = 0;
        }
        this._panelSignals.forEach(([actor, id]) => actor.disconnect(id));
        this._panelSignals = [];
    }
}
