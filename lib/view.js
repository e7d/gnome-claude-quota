import {errorText} from './errors.js';
import {accountLine, percentLine, planLine, rateLimitMessage, refreshLine, serviceUntilLine} from './format.js';
import {_} from './i18n.js';
import {isBlocked, minIntervalWait, serviceIssue, throttledUntil} from './policy.js';
import {quotaClass} from './style.js';

function issueView({service, until, locale, now}) {
    const issue = serviceIssue(service?.status);
    if (issue === null)
        return null;
    const label = `${issue.emoji} ${issue.text}`;
    const untilLine = serviceUntilLine(until, now, locale);
    return {
        emoji: issue.emoji,
        text: issue.text,
        oneLine: untilLine === '' ? label : `${label} · ${untilLine}`,
        twoLine: untilLine === '' ? label : `${label}\n${untilLine}`,
    };
}

function hiddenNoteView(quotaCount, menuQuotaCount) {
    const visible = quotaCount > 0 && menuQuotaCount === 0;
    return {
        visible,
        text: visible ? _('Every quota is hidden.') : '',
        buttonLabel: visible ? _('Open settings') : '',
    };
}

export function popupView({block, service, error, fetchedAt, refreshing, lastRequestAt,
    accountEmail, accountPlan, quotaCount, menuQuotaCount, locale, now}) {
    const throttleUntil = throttledUntil(block);
    const silenced = isBlocked(throttleUntil, now);
    const issue = silenced ? null : issueView({service, until: service?.until, locale, now});
    const errorLine = silenced || issue || error === null ? '' : errorText(error);
    const throttled = rateLimitMessage(throttleUntil, now, locale);
    const loading = issue === null && errorLine === '' && quotaCount === 0 && !silenced;
    const message = loading ? _('Loading…') : throttled || errorLine;
    return {
        refreshText: refreshLine(fetchedAt, now, locale),
        accountText: accountLine(accountEmail),
        accountVisible: accountEmail !== null,
        planText: planLine(accountPlan),
        planVisible: accountPlan !== null,
        issue,
        message,
        messageVisible: message !== '',
        separatorVisible: (issue !== null || errorLine !== '' || throttled !== '')
            && menuQuotaCount > 0,
        bodyVisible: !loading,
        hiddenNote: hiddenNoteView(quotaCount, menuQuotaCount),
        refreshing,
        refreshEnabled: !refreshing && !isBlocked(block?.until, now)
            && minIntervalWait(lastRequestAt, now) === 0,
    };
}

// The fallback is for nothing having been fetched yet. A bar list emptied by the
// user's own prefs still has quotas behind it, and falls through to the icon-only
// floor instead — which is why the visible list and the total are separate inputs.
export function panelView({quotas, hasAnyQuota, service, error, scheme, percentLocale}) {
    const cells = quotas.map(quota => ({
        dotted: true,
        text: `${quota.short} ${percentLine(quota, percentLocale)}`,
        styleClass: quotaClass('cq-panel-quota', quota, scheme),
    }));
    if (cells.length === 0 && !hasAnyQuota)
        cells.push({dotted: false, text: error ? '-' : '…', styleClass: null});
    const issue = serviceIssue(service?.status);
    if (issue === null)
        return {cells, issueLast: false};
    cells.push({dotted: false, text: issue.emoji, styleClass: 'cq-panel-issue'});
    return {cells, issueLast: true};
}
