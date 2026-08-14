const VERSION = 2;
const ACCEPTED = new Set([1, VERSION]);

export function serialize(limits, fetchedAt, fired = {}) {
    return JSON.stringify({version: VERSION, fetchedAt: fetchedAt.toISOString(), limits, fired});
}

function firedOf(data) {
    const fired = data.fired;
    return fired !== null && typeof fired === 'object' && !Array.isArray(fired) ? fired : {};
}

export function deserialize(text) {
    if (!text)
        return null;
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    if (!ACCEPTED.has(data?.version) || !Array.isArray(data.limits))
        return null;
    const fetchedAt = new Date(data.fetchedAt);
    if (Number.isNaN(fetchedAt.getTime()))
        return null;
    return {limits: data.limits, fetchedAt, fired: firedOf(data)};
}
