// Claude Code caches the same payload we fetch, under its own account id. That id
// is compared against the account the file says is logged in, because switching
// accounts leaves the previous one's numbers in the block until something
// refreshes it — and .credentials.json carries no id to bind it to our token.
function accountAgrees(data) {
    const cached = data?.cachedUsageUtilization?.accountUuid;
    const account = data?.oauthAccount?.accountUuid;
    return typeof cached === 'string' && cached !== '' && cached === account;
}

export function parseSharedUsage(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    if (!accountAgrees(data))
        return null;
    const block = data.cachedUsageUtilization;
    if (!Number.isFinite(block.fetchedAtMs))
        return null;
    const fetchedAt = new Date(block.fetchedAtMs);
    if (Number.isNaN(fetchedAt.getTime()))
        return null;
    const limits = block.utilization?.limits;
    if (!Array.isArray(limits) || limits.length === 0)
        return null;
    return {limits, fetchedAt};
}

export function fresherThan(shared, fetchedAt) {
    if (shared === null)
        return false;
    if (!(fetchedAt instanceof Date) || Number.isNaN(fetchedAt.getTime()))
        return true;
    return shared.fetchedAt > fetchedAt;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function parseAccountEmail(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    const email = data?.oauthAccount?.emailAddress;
    if (typeof email !== 'string')
        return null;
    const trimmed = email.trim();
    return EMAIL.test(trimmed) ? trimmed : null;
}
