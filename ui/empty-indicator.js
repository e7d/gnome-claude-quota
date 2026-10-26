import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {_} from '../lib/i18n.js';
import {brandColor} from '../lib/theme.js';

import {panelScheme} from './panel-fit.js';
import {displayItem} from './quota-block.js';

const REASONS = {
    'no-account': () => _('No Claude account is followed.'),
    'none-shown': () => _('No Claude account is shown in the top bar.'),
};

// Stands in for the account indicators when none is shown, so the top bar always keeps
// the way back to the preferences. Its popup is the regular header with the reason in
// place of the refresh time, and nothing to act on besides the settings.
export const EmptyIndicator = GObject.registerClass(
class EmptyIndicator extends PanelMenu.Button {
    _init({iconPath, reason, onOpenPrefs}) {
        super._init(0.5, _('Claude Quota'));
        this._reason = reason;
        this._icon = new St.Icon({
            style_class: 'system-status-icon cq-panel-icon',
            gicon: Gio.icon_new_for_string(iconPath),
        });
        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        box.add_child(this._icon);
        this.add_child(box);
        this.menu.addMenuItem(this._body(onOpenPrefs));
        this.menu.connect('open-state-changed', (menu, open) => open && this.render());
        this.render();
    }

    _body(onOpenPrefs) {
        this._messageLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._messageLabel.clutter_text.line_wrap = true;
        this._messageLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._prefsButton = new St.Button({
            style_class: 'cq-meta-button',
            child: new St.Icon({style_class: 'popup-menu-icon', icon_name: 'emblem-system-symbolic'}),
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        this._prefsButton.connect('clicked', () => {
            this.menu.close();
            onOpenPrefs();
        });
        const meta = new St.BoxLayout({style_class: 'cq-meta', x_expand: true});
        meta.add_child(this._messageLabel);
        meta.add_child(this._prefsButton);
        const content = new St.BoxLayout({style_class: 'cq-body', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        content.add_child(meta);
        const item = displayItem();
        item.add_child(content);
        return item;
    }

    setReason(reason) {
        this._reason = reason;
        this.render();
    }

    render() {
        this._messageLabel.text = REASONS[this._reason]();
        this.accessible_name = _('Claude Quota');
        if (this._icon.get_stage() !== null)
            this._icon.style = `color: ${brandColor(panelScheme())};`;
    }
});
