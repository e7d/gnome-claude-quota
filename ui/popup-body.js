import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {CAPTION_OPACITY, QuotaBlock, displayItem} from './quota-block.js';

const STATUS_URL = 'https://status.claude.com/';
const SPIN_DURATION_MS = 900;

export class PopupBody {
    constructor({onRefresh, onOpenPrefs}) {
        this._onRefresh = onRefresh;
        this._onOpenPrefs = onOpenPrefs;
        this._blocks = [];
        this._buildActors();
        this.items = [this._body, this._hiddenNoteItem, this._messageSeparator, this._message, this._issueItem];
    }

    _buildActors() {
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
        this._refreshButton.connect('clicked', () => this._onRefresh());
        this._metaBox.add_child(this._refreshLabel);
        this._metaBox.add_child(this._refreshButton);
        this._accountLabel = new St.Label({style_class: 'cq-account', opacity: CAPTION_OPACITY, x_expand: true});
        this._accountLabel.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        this._buildMessage();
        this._buildBody();
        this._buildHiddenNote();
        this._issueItem = new PopupMenu.PopupMenuItem('');
        this._issueItem.label.clutter_text.line_wrap = true;
        this._issueItem.label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._issueItem.connect('activate', () => Gio.AppInfo.launch_default_for_uri(STATUS_URL, null));
        this._messageSeparator = new PopupMenu.PopupSeparatorMenuItem();
    }

    _buildMessage() {
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
    }

    _buildBody() {
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
        this._bodyBox.add_child(this._accountLabel);
        this._bodyBox.add_child(this._blockBox);
        this._body.add_child(this._bodyBox);
    }

    _buildHiddenNote() {
        this._hiddenNoteItem = displayItem();
        this._hiddenNoteBox = new St.BoxLayout({
            style_class: 'cq-message',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._hiddenNote = new St.Label({style_class: 'cq-caption', text: ''});
        this._hiddenNote.clutter_text.line_wrap = true;
        this._hiddenNote.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._hiddenNoteButton = new St.Button({
            style_class: 'button',
            label: '',
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._hiddenNoteButton.connect('clicked', () => this._onOpenPrefs());
        this._hiddenNoteBox.add_child(this._hiddenNote);
        this._hiddenNoteBox.add_child(this._hiddenNoteButton);
        this._hiddenNoteItem.add_child(this._hiddenNoteBox);
    }

    update({view, quotas, now, scheme, locale, percentLocale}) {
        this._renderActions(view);
        this._renderBlocks({quotas, now, scheme, locale, percentLocale});
        this._renderHiddenNote(view.hiddenNote);
        this._renderMessage(view);
    }

    _renderActions(view) {
        this._refreshButton.reactive = view.refreshEnabled;
        this._refreshButton.opacity = this._refreshButton.reactive ? 255 : CAPTION_OPACITY;
        if (view.refreshing)
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

    _renderBlocks({quotas, now, scheme, locale, percentLocale}) {
        if (this._blocks.length !== quotas.length) {
            this._blockBox.destroy_all_children();
            this._blocks = quotas.map(() => {
                const block = new QuotaBlock();
                this._blockBox.add_child(block);
                return block;
            });
        }
        quotas.forEach((quota, index) =>
            this._blocks[index].update({quota, now, scheme, locale, percentLocale}));
        this._blockBox.visible = quotas.length > 0;
    }

    _renderHiddenNote(hiddenNote) {
        this._hiddenNote.visible = hiddenNote.visible;
        this._hiddenNoteButton.visible = hiddenNote.visible;
        this._hiddenNoteItem.visible = hiddenNote.visible;
        if (!hiddenNote.visible)
            return;
        this._hiddenNote.text = hiddenNote.text;
        this._hiddenNoteButton.label = hiddenNote.buttonLabel;
    }

    _renderMessage(view) {
        this._refreshLabel.text = view.refreshText;
        this._accountLabel.text = view.accountText;
        this._accountLabel.visible = view.accountVisible;
        this._issueItem.visible = view.issue !== null;
        this._renderIssue(view.issue);
        this._messageLabel.text = view.message;
        this._message.visible = view.messageVisible;
        this._messageSeparator.visible = view.separatorVisible;
        this._body.visible = view.bodyVisible;
    }

    // Cleared rather than left behind when there is no issue: a hidden row that keeps
    // the last incident's wording hands it back the moment the next one differs.
    _renderIssue(issue) {
        if (issue === null) {
            this._issueItem.label.text = '';
            return;
        }
        this._issueItem.label.text = issue.oneLine;
        if (!this._issueFits())
            this._issueItem.label.text = issue.twoLine;
    }

    // The popup is as wide as its widest item, so a window that does not fit beside the
    // wording would stretch every quota row — hence the body's width, not a pixel budget.
    _issueFits() {
        if (this._issueItem.get_stage() === null)
            return true;
        const [, issueWidth] = this._issueItem.get_preferred_width(-1);
        const [, bodyWidth] = this._body.get_preferred_width(-1);
        return issueWidth <= bodyWidth;
    }

    destroy() {
        this._stopSpinner();
    }
}
