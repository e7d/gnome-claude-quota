import {_, format, n_} from './i18n.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const WINDOW_LENGTH_MS = {
    session: 5 * HOUR,
    weekly: 7 * DAY,
};

function posixLocale(posix) {
    const tag = posix.split('.')[0].split('@')[0].replace('_', '-');
    if (tag === '' || tag === 'C' || tag === 'POSIX')
        return undefined;
    return tag;
}

export function timeLocale(env) {
    return posixLocale(env.LC_ALL || env.LC_TIME || env.LANG || '');
}

export function numberLocale(env) {
    return posixLocale(env.LC_ALL || env.LC_NUMERIC || env.LANG || '');
}

function daysLeft(remaining) {
    const days = Math.floor(remaining / DAY);
    return format(n_('{d}d {h}h left', '{d}d {h}h left', days),
        {d: days, h: Math.floor((remaining % DAY) / HOUR)});
}

function hoursLeft(remaining) {
    const hours = Math.floor(remaining / HOUR);
    const minutes = Math.floor((remaining % HOUR) / MINUTE);
    return format(n_('{h}h {m}m left', '{h}h {m}m left', hours),
        {h: hours, m: String(minutes).padStart(2, '0')});
}

// The trailing word is inside each branch's msgid because French agrees it with
// whichever unit leads — jours masculine, heures feminine, one minute singular —
// so a sentence joined from a duration and a shared word cannot be translated.
export function remainingLine(target, now) {
    const remaining = target - now;
    if (remaining <= 0)
        return _('now');
    if (remaining >= DAY)
        return daysLeft(remaining);
    if (remaining >= HOUR)
        return hoursLeft(remaining);
    const minutes = Math.max(1, Math.floor(remaining / MINUTE));
    return format(n_('{m}m left', '{m}m left', minutes), {m: minutes});
}

function roundToMinute(target) {
    return new Date(Math.round(target.getTime() / MINUTE) * MINUTE);
}

function isSameDay(target, now) {
    return target.getFullYear() === now.getFullYear() &&
        target.getMonth() === now.getMonth() &&
        target.getDate() === now.getDate();
}

export function absoluteTime(target, now, locale = undefined) {
    const options = {hour: 'numeric', minute: '2-digit'};
    if (!isSameDay(target, now))
        options.weekday = 'short';
    return new Intl.DateTimeFormat(locale, options).format(target);
}

export function percentLine(quota, locale = undefined) {
    if (quota.expired || !Number.isFinite(quota.percent))
        return '-';
    return new Intl.NumberFormat(locale, {style: 'percent', maximumFractionDigits: 0})
        .format(quota.percent / 100);
}

export function captionLine(quota, now, locale = undefined) {
    if (quota.expired || !quota.resetsAt)
        return '-';
    return format('{remaining} · {time}', {
        remaining: remainingLine(quota.resetsAt, now),
        time: absoluteTime(roundToMinute(quota.resetsAt), now, locale),
    });
}

export function refreshLine(fetchedAt, now, locale = undefined) {
    const time = fetchedAt === null ? '-' : absoluteTime(fetchedAt, now, locale);
    return format(_('Last refresh: {time}'), {time});
}

export function accountDetail(email) {
    return email === null ? null : {label: _('Account'), value: email};
}

export function planDetail(plan) {
    return plan === null ? null : {label: _('Plan'), value: plan};
}

export function rateLimitLine(until, now, locale = undefined) {
    if (!until)
        return '';
    const target = roundToMinute(until);
    const time = absoluteTime(target, now, locale);
    return isSameDay(target, now)
        ? format(_('retry at {time}'), {time})
        : format(_('retry {time}'), {time});
}

export function serviceUntilLine(until, now, locale = undefined) {
    if (!until || until <= now)
        return '';
    return format(_('until {time}'), {time: absoluteTime(roundToMinute(until), now, locale)});
}

export function rateLimitMessage(until, now, locale = undefined) {
    const line = rateLimitLine(until, now, locale);
    return line === '' ? '' : `⏳ ${_('Rate limited')} · ${line}`;
}

export function windowProgress(resetsAt, now, windowMs) {
    if (!resetsAt)
        return null;
    const elapsed = 1 - (resetsAt - now) / windowMs;
    return Math.min(1, Math.max(0, elapsed));
}
