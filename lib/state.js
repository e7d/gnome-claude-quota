import {quotas} from './model.js';
import {blockReason, nextPollSeconds, rateLimitBlock, RATE_LIMIT} from './policy.js';
import {fresherThan} from './shared-usage.js';

export const UNKNOWN_SERVICE = {status: 'unknown', until: null};

const NO_EFFECTS = {save: false, syncAlerts: false, schedule: 0};

function succeeded({state, result, now}) {
    return {
        state: {
            ...state,
            limits: Array.isArray(result.payload?.limits) ? result.payload.limits : [],
            quotas: quotas(result.payload, now),
            error: null,
            block: null,
            rateLimitStreak: 0,
            fetchedAt: now,
            seenExpiry: result.expiresAt ?? state.seenExpiry,
        },
        effects: {save: true, syncAlerts: true, schedule: nextPollSeconds(null)},
    };
}

function blocked({state, result, reason, now}) {
    const block = rateLimitBlock(result.retryAfter, now, state.rateLimitStreak);
    return {
        state: {
            ...state,
            rateLimitStreak: state.rateLimitStreak + 1,
            block: {until: block.until, reason},
            error: reason === RATE_LIMIT ? null : result.desc,
        },
        effects: {...NO_EFFECTS, schedule: nextPollSeconds(block.seconds)},
    };
}

function failed({state, result}) {
    return {
        state: {
            ...state,
            block: null,
            error: result.desc,
        },
        effects: {...NO_EFFECTS, schedule: nextPollSeconds(result.retryAfter)},
    };
}

export function applyResult({state, result, now}) {
    if (result.error === null)
        return succeeded({state, result, now});
    const reason = blockReason(result);
    return reason === null ? failed({state, result}) : blocked({state, result, reason, now});
}

export function adoptShared({state, shared, now}) {
    if (!fresherThan(shared, state.fetchedAt))
        return null;
    return {
        state: {
            ...state,
            limits: shared.limits,
            quotas: quotas({limits: shared.limits}, now),
            error: null,
            fetchedAt: shared.fetchedAt,
        },
        effects: {save: true, syncAlerts: true, schedule: 0},
    };
}
