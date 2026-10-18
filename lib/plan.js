const KNOWN = new Map([
    ['enterprise', 'Enterprise'],
    ['free', 'Free'],
    ['pro', 'Pro'],
    ['team', 'Team'],
]);

function humanize(id) {
    return id.split('_').filter(word => word !== '')
        .map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

function maxName(tier) {
    const multiple = /max_(\d+)x$/.exec(typeof tier === 'string' ? tier : '');
    return multiple === null ? 'Max' : `Max ${multiple[1]}x`;
}

export function planName({type, tier}) {
    if (typeof type !== 'string')
        return null;
    const id = type.trim().replace(/^claude_/, '');
    const name = id === 'max' ? maxName(tier) : KNOWN.get(id) ?? humanize(id);
    return name === '' ? null : name;
}
