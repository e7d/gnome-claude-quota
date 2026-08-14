import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';

import {tickRects} from '../lib/bar.js';

const TICK_OVERHANG = 2;

export default GObject.registerClass(
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
