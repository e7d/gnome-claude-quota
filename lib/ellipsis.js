const ELLIPSIS = '…';
const MIN_NAME = 3;

function longest({from, to, build, fits}) {
    for (let length = from; length >= to; length--) {
        if (fits(build(length)))
            return build(length);
    }
    return null;
}

function cutName(name, host, fits) {
    return longest({
        from: name.length - 2,
        to: MIN_NAME,
        build: length => `${name.slice(0, length)}${ELLIPSIS}@${host}`,
        fits,
    });
}

function cutHost(name, host, fits) {
    const lead = name.length > MIN_NAME + 1 ? `${name.slice(0, MIN_NAME)}${ELLIPSIS}` : name;
    const build = length => `${lead}@${ELLIPSIS}${host.slice(-length)}`;
    return longest({from: host.length - 1, to: 1, build, fits}) ?? build(1);
}

export function shortenEmail(email, fits) {
    if (fits(email))
        return email;
    const at = email.lastIndexOf('@');
    if (at < 1)
        return email;
    const name = email.slice(0, at);
    const host = email.slice(at + 1);
    return cutName(name, host, fits) ?? cutHost(name, host, fits);
}
