// A token that expires mid-flight comes back 401, and the endpoint answers the
// fourth consecutive 401 with retry-after: 3600 — so a token about to die is
// treated as already dead rather than spent on a request that earns an hour's ban.
export const EXPIRY_SKEW_SECONDS = 60;

export function parseCredentials(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    const oauth = data?.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || oauth.accessToken === '')
        return null;
    return {token: oauth.accessToken, expiresAt: expiryDate(oauth.expiresAt)};
}

function expiryDate(milliseconds) {
    return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

export function tokenExpired(expiresAt, now, skewSeconds = EXPIRY_SKEW_SECONDS) {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()))
        return false;
    return expiresAt.getTime() - skewSeconds * 1000 <= now.getTime();
}

// The hour-long block the endpoint arms for repeated auth failures is scoped to
// the token that earned it, so a newer token lifts it server-side and our own
// backoff is the only thing left holding the indicator down.
export function credentialsRenewed(seenExpiresAt, expiresAt) {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()))
        return false;
    if (!(seenExpiresAt instanceof Date) || Number.isNaN(seenExpiresAt.getTime()))
        return true;
    return expiresAt.getTime() > seenExpiresAt.getTime();
}
