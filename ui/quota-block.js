import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {captionLine, percentLine} from '../lib/format.js';
import {barClass, quotaClass} from '../lib/style.js';

import PaceBar from './pace-bar.js';

export const CAPTION_OPACITY = 180;

// The insensitive pseudo-class the shipped theme paints at 50% alpha is what a
// non-reactive item gets, and every child label inherits it.
export function displayItem() {
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

export const QuotaBlock = GObject.registerClass(
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

    update({quota, now, scheme, locale, percentLocale}) {
        this._name.text = quota.name;
        this._percent.text = percentLine(quota, percentLocale);
        this._percent.style_class = quotaClass('cq-percent', quota, scheme);
        this._bar.value = quota.expired ? 0 : quota.percent / 100;
        this._bar.setPace(quota.expired ? null : quota.windowProgress);
        this._bar.style_class = barClass(scheme);
        this._caption.text = captionLine(quota, now, locale);
    }
});
