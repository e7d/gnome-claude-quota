import Gio from 'gi://Gio';

export function catalogFiles(extensionDir, domain) {
    const locale = extensionDir.get_child('locale');
    const file = tag => locale.get_child(tag).get_child('LC_MESSAGES').get_child(`${domain}.mo`);
    const tags = [...locale.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null)]
        .map(info => info.get_name())
        .filter(tag => file(tag).query_exists(null));
    return {tags, read: tag => file(tag).load_contents(null)[1]};
}
