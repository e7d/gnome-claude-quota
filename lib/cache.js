const VERSION = 1;

export function serialize(limits, fetchedAt) {
    return JSON.stringify({version: VERSION, fetchedAt: fetchedAt.toISOString(), limits});
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
    if (data?.version !== VERSION || !Array.isArray(data.limits))
        return null;
    const fetchedAt = new Date(data.fetchedAt);
    if (Number.isNaN(fetchedAt.getTime()))
        return null;
    return {limits: data.limits, fetchedAt};
}
