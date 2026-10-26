import {planName} from './plan.js';

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

export function parseAccountPlan(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    const account = data?.oauthAccount;
    return planName({type: account?.organizationType, tier: account?.organizationRateLimitTier});
}

function holdsLogin(text) {
    try {
        const account = JSON.parse(text)?.oauthAccount;
        return typeof account === 'object' && account !== null;
    } catch {
        return false;
    }
}

// Claude Code leaves a login-less stub at ~/.claude/.claude.json after any run that
// names ~/.claude in CLAUDE_CONFIG_DIR, and that stub must not hide ~/.claude.json.
export function loggedInConfig(texts) {
    return texts.find(holdsLogin) ?? null;
}

function accountId(text) {
    try {
        return JSON.parse(text)?.oauthAccount?.accountUuid ?? null;
    } catch {
        return null;
    }
}

// Claude Code can leave a partial copy of the login at ~/.claude/.claude.json — the
// address without the organisation — ahead of the full one in ~/.claude.json, so each
// detail is taken from the first file that has it, as long as that file is the same
// account: a detail borrowed from another login would be a wrong answer, not a gap.
export function accountDetailsFrom(texts) {
    const first = loggedInConfig(texts);
    if (first === null)
        return {email: null, plan: null};
    const same = texts.filter(holdsLogin).filter(text => accountId(text) === accountId(first));
    const firstOf = parse => same.map(parse).find(value => value !== null) ?? null;
    return {email: firstOf(parseAccountEmail), plan: firstOf(parseAccountPlan)};
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
