const VERSION = 2;
const ACCEPTED = new Set([1, VERSION]);

export function serialize(limits, fetchedAt, fired = {}) {
    return JSON.stringify({version: VERSION, fetchedAt: fetchedAt.toISOString(), limits, fired});
}

function firedEntry(entry) {
    return entry !== null && typeof entry === 'object' && typeof entry.window === 'string';
}

// An entry reaching the planner malformed throws where nothing catches it — the cache
// load runs from _init — so the container being an object is not enough on its own.
function firedOf(data) {
    const fired = data.fired;
    if (fired === null || typeof fired !== 'object' || Array.isArray(fired))
        return {};
    return Object.fromEntries(Object.entries(fired).filter(([, entry]) => firedEntry(entry)));
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
