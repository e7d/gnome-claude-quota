import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    accountDirs, accountRows, addableDirs, configDir, displayPath, isCandidateName, isUsable, movedDir,
    sameSettings, settingsFor, steppedDir,
} from '../lib/config-dir.js';
import {NOT_CLAUDE} from '../lib/errors.js';
import {_, format} from '../lib/i18n.js';
import {ACCOUNT_DIRS_KEY, SHOWN_DIRS_KEY} from '../lib/settings.js';
import {accountDetails, directoryState, hasToken} from '../lib/usage.js';

function homeDirectoryNames(home) {
    const names = [];
    try {
        const entries = Gio.File.new_for_path(home).enumerate_children(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = entries.next_file(null)) !== null) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                names.push(info.get_name());
        }
        entries.close(null);
    } catch (error) {
        logError(error);
    }
    return names;
}

function foundDirs(home) {
    return homeDirectoryNames(home)
        .filter(isCandidateName)
        .map(name => GLib.build_filenamev([home, name]))
        .filter(dir => hasToken(dir));
}

function listed({settings, home}) {
    return accountDirs(settings.get_strv(ACCOUNT_DIRS_KEY), home);
}

function shown({settings, home}) {
    return settings.get_strv(SHOWN_DIRS_KEY).map(setting => configDir(setting, home));
}

function writeDirs({settings, home}, key, dirs) {
    const next = settingsFor(dirs, home);
    if (!sameSettings(next, settings.get_strv(key)))
        settings.set_strv(key, next);
}

function accountLabel(dir, home) {
    const {email} = accountDetails(dir);
    return email ?? displayPath(dir, home);
}

function addAccount(context, dir) {
    writeDirs(context, ACCOUNT_DIRS_KEY, [...listed(context), dir]);
    writeDirs(context, SHOWN_DIRS_KEY, [...shown(context), dir]);
}

function setShown(context, {dir, visible}) {
    const others = shown(context).filter(path => path !== dir);
    writeDirs(context, SHOWN_DIRS_KEY, visible ? [...others, dir] : others);
}

function moveAccount(context, {dir, dirs}) {
    context.state.focus = dir;
    writeDirs(context, ACCOUNT_DIRS_KEY, dirs);
}

// Both lists are taken before the change, so Undo puts back the order and what was
// shown exactly as they were, whatever the change did to either.
function undoable(context, {title, window, change}) {
    const before = {accounts: context.settings.get_strv(ACCOUNT_DIRS_KEY), shown: context.settings.get_strv(SHOWN_DIRS_KEY)};
    const toast = new Adw.Toast({title, button_label: _('Undo'), use_markup: false});
    toast.connect('button-clicked', () => {
        context.settings.set_strv(ACCOUNT_DIRS_KEY, before.accounts);
        context.settings.set_strv(SHOWN_DIRS_KEY, before.shown);
    });
    change();
    window?.add_toast(toast);
}

function removeAccount(context, {dir, window}) {
    undoable(context, {
        title: format(_('{account} removed'), {account: accountLabel(dir, context.home)}),
        window,
        change: () => {
            writeDirs(context, SHOWN_DIRS_KEY, shown(context).filter(path => path !== dir));
            writeDirs(context, ACCOUNT_DIRS_KEY, listed(context).filter(path => path !== dir));
        },
    });
}

function resetAccounts(context, window) {
    undoable(context, {
        title: _('Accounts restored to ~/.claude'),
        window,
        change: () => {
            context.settings.reset(SHOWN_DIRS_KEY);
            context.settings.reset(ACCOUNT_DIRS_KEY);
        },
    });
}

function isDefault({settings}) {
    return [ACCOUNT_DIRS_KEY, SHOWN_DIRS_KEY].every(key => settings.get_value(key).equal(settings.get_default_value(key)));
}

function pickedFolder(dialog, result) {
    try {
        return dialog.select_folder_finish(result).get_path();
    } catch {
        return null;
    }
}

function chooseFolder(context, window) {
    const dialog = new Gtk.FileDialog({title: _('Claude directory'), initial_folder: Gio.File.new_for_path(context.home)});
    dialog.select_folder(window, null, (source, result) => {
        const path = pickedFolder(source, result);
        if (path === null)
            return;
        if (isUsable(directoryState(path)))
            addAccount(context, configDir(path, context.home));
        else
            window.add_toast(new Adw.Toast({title: format(_(NOT_CLAUDE), {path: displayPath(path, context.home)}), use_markup: false}));
    });
}

function groupActions(context) {
    const actions = new Gio.SimpleActionGroup();
    const add = new Gio.SimpleAction({name: 'add', parameter_type: new GLib.VariantType('s')});
    add.connect('activate', (action, dir) => addAccount(context, dir.unpack()));
    const choose = new Gio.SimpleAction({name: 'choose'});
    choose.connect('activate', () => chooseFolder(context, context.group.get_root()));
    actions.add_action(add);
    actions.add_action(choose);
    return actions;
}

function addMenu(context, addable) {
    const found = new Gio.Menu();
    addable.forEach(dir => {
        const {email} = accountDetails(dir);
        const path = displayPath(dir, context.home);
        const label = email ? `${path} · ${email}` : path;
        const item = Gio.MenuItem.new(label.replaceAll('_', '__'), null);
        item.set_action_and_target_value('accounts.add', GLib.Variant.new_string(dir));
        found.append_item(item);
    });
    const other = new Gio.Menu();
    other.append(_('Choose Folder…'), 'accounts.choose');
    const menu = new Gio.Menu();
    menu.append_section(null, found);
    menu.append_section(null, other);
    return menu;
}

function accountSubtitle(dir, detail, home) {
    return [displayPath(dir, home), detail].filter(Boolean).join(' · ');
}

// The address a signed-out folder still names is the account it last held, not one it
// can be read as: it moves to the subtitle, so the title says what the popup will say.
function rowTitle({state, email, dir, home}) {
    if (state === 'signed-in')
        return email ?? displayPath(dir, home);
    return state === 'signed-out' ? _('Signed out') : INVALID_TITLES[state]();
}

function makeDraggable(row, context, dir) {
    const source = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
    source.connect('prepare', () => Gdk.ContentProvider.new_for_value(dir));
    source.connect('drag-begin', dragSource => dragSource.set_icon(new Gtk.WidgetPaintable({widget: row}), 0, 0));
    row.add_controller(source);
    const target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
    target.connect('drop', (dropTarget, dragged) => {
        moveAccount(context, {dir: dragged, dirs: movedDir(listed(context), {dir: dragged, onto: dir})});
        return true;
    });
    row.add_controller(target);
    row.add_prefix(new Gtk.Image({icon_name: 'list-drag-handle-symbolic', css_classes: ['dim-label']}));
}

function moveActions(context, entry) {
    const actions = new Gio.SimpleActionGroup();
    [['move-up', -1, !entry.first], ['move-down', 1, !entry.last]].forEach(([name, step, enabled]) => {
        const action = new Gio.SimpleAction({name, enabled});
        action.connect('activate', () => {
            moveAccount(context, {dir: entry.path, dirs: steppedDir(listed(context), {dir: entry.path, step})});
        });
        actions.add_action(action);
    });
    return actions;
}

function moveMenu() {
    const menu = new Gio.Menu();
    [[_('Move Up'), 'row.move-up', '<Alt>Up'], [_('Move Down'), 'row.move-down', '<Alt>Down']].forEach(([label, action, accel]) => {
        const item = Gio.MenuItem.new(label, action);
        item.set_attribute_value('accel', GLib.Variant.new_string(accel));
        menu.append_item(item);
    });
    return menu;
}

function popupAt(popover, rectangle) {
    popover.pointing_to = new Gdk.Rectangle(rectangle);
    popover.popup();
}

// Dragging needs a pointer, so the same moves sit behind the row's context menu and
// two shortcuts, which is how the keyboard reaches them.
function makeMovable(row, context, entry) {
    row.insert_action_group('row', moveActions(context, entry));
    const popover = Gtk.PopoverMenu.new_from_model(moveMenu());
    popover.set_parent(row);
    row.connect('destroy', () => popover.unparent());
    const click = new Gtk.GestureClick({button: Gdk.BUTTON_SECONDARY});
    click.connect('pressed', (gesture, presses, x, y) => popupAt(popover, {x, y, width: 1, height: 1}));
    row.add_controller(click);
    const shortcuts = new Gtk.ShortcutController();
    [['<Alt>Up', 'row.move-up'], ['<Alt>Down', 'row.move-down']].forEach(([trigger, action]) => shortcuts.add_shortcut(
        new Gtk.Shortcut({trigger: Gtk.ShortcutTrigger.parse_string(trigger), action: Gtk.NamedAction.new(action)})));
    shortcuts.add_shortcut(new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string('Menu|<Shift>F10'),
        action: Gtk.CallbackAction.new(() => {
            popupAt(popover, {x: 0, y: 0, width: row.get_width(), height: row.get_height()});
            return true;
        }),
    }));
    row.add_controller(shortcuts);
    makeDraggable(row, context, entry.path);
}

const INVALID_TITLES = {
    'missing': () => _('Folder not found'),
    'not-claude': () => _('Not a Claude Code directory'),
    'broken': () => _('Invalid login file'),
};

function invalidMark() {
    return new Gtk.Image({icon_name: 'dialog-warning-symbolic', css_classes: ['warning'], valign: Gtk.Align.CENTER});
}

// A folder that stopped being one Claude Code can use keeps every control on its row:
// hiding it while it is being repaired is the likeliest thing to want from it.
function accountEntry(context, entry, movable) {
    const {email, plan} = accountDetails(entry.path);
    const state = directoryState(entry.path);
    const usable = isUsable(state);
    const row = new Adw.ActionRow({
        title: rowTitle({state, email, dir: entry.path, home: context.home}),
        subtitle: accountSubtitle(entry.path, state === 'signed-in' ? plan : email, context.home),
        use_markup: false,
    });
    if (movable)
        makeMovable(row, context, entry);
    if (!usable)
        row.add_suffix(invalidMark());
    const remove = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        tooltip_text: _('Remove'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat', 'error'],
    });
    remove.connect('clicked', () => removeAccount(context, {dir: entry.path, window: row.get_root()}));
    const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER, active: entry.shown});
    toggle.connect('notify::active', () => setShown(context, {dir: entry.path, visible: toggle.active}));
    row.add_suffix(remove);
    row.add_suffix(toggle);
    row.activatable_widget = toggle;
    return {row, toggle, remove, path: entry.path};
}

// Matched by path, never by position: while a list change waits for its rebuild, the
// rows on screen are the old order, and a switch set from the wrong row writes back.
function syncEntries(context) {
    const visible = shown(context);
    context.state.entries.forEach(entry => {
        entry.toggle.active = visible.includes(entry.path);
    });
    context.resetButton.sensitive = !isDefault(context);
}

function currentRows(context) {
    return accountRows({accounts: listed(context), shown: shown(context)});
}

function rebuild(context) {
    const rows = currentRows(context);
    context.state.entries.forEach(entry => context.group.remove(entry.row));
    context.state.entries = rows.map(row => accountEntry(context, row, rows.length > 1));
    context.state.entries.forEach(entry => context.group.add(entry.row));
    syncEntries(context);
    context.state.placeholder.visible = rows.length === 0;
    syncAddButton(context);
    context.state.entries.find(entry => entry.path === context.state.focus)?.row.grab_focus();
    context.state.focus = null;
}

// With nothing detected to offer, a menu holding only the folder picker is one click too
// many, so the plain button that opens the picker takes its place.
function syncAddButton(context) {
    const addable = addableDirs({found: context.found, accounts: listed(context), home: context.home});
    context.addMenuButton.menu_model = addMenu(context, addable);
    context.addMenuButton.visible = addable.length > 0;
    context.chooseButton.visible = addable.length === 0;
}

function headerButtons() {
    const shared = {icon_name: 'list-add-symbolic', tooltip_text: _('Add an account'), valign: Gtk.Align.CENTER, css_classes: ['flat']};
    const addMenuButton = new Gtk.MenuButton(shared);
    const chooseButton = new Gtk.Button({...shared, action_name: 'accounts.choose'});
    const resetButton = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: _('Restore the default'),
        valign: Gtk.Align.CENTER,
        has_frame: false,
    });
    const box = new Gtk.Box({valign: Gtk.Align.CENTER});
    [addMenuButton, chooseButton, resetButton].forEach(button => box.append(button));
    return {box, addMenuButton, chooseButton, resetButton};
}

function placeholderRow() {
    return new Adw.ActionRow({
        title: _('No Claude account is followed.'),
        subtitle: _('Add one with the + button.'),
        css_classes: ['dim-label'],
        use_markup: false,
    });
}

// A list change arrives inside the signal of the widget that caused it — a drop, a
// menu item, the bin — and replacing that widget there would destroy it mid-emission.
function queueRebuild(context) {
    if (context.state.idleId)
        return;
    context.state.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        context.state.idleId = 0;
        rebuild(context);
        return GLib.SOURCE_REMOVE;
    });
}

export function accountsGroup(settings) {
    const home = GLib.get_home_dir();
    const {box, addMenuButton, chooseButton, resetButton} = headerButtons();
    const group = new Adw.PreferencesGroup({title: _('Accounts'), header_suffix: box});
    const placeholder = placeholderRow();
    group.add(placeholder);
    const context = {
        settings, home, group, addMenuButton, chooseButton, resetButton, found: foundDirs(home),
        state: {entries: [], idleId: 0, focus: null, placeholder},
    };
    group.insert_action_group('accounts', groupActions(context));
    resetButton.connect('clicked', () => resetAccounts(context, group.get_root()));
    settings.connect(`changed::${ACCOUNT_DIRS_KEY}`, () => queueRebuild(context));
    settings.connect(`changed::${SHOWN_DIRS_KEY}`, () => syncEntries(context));
    group.connect('destroy', () => {
        if (context.state.idleId)
            GLib.Source.remove(context.state.idleId);
        context.state.idleId = 0;
    });
    rebuild(context);
    return group;
}
