import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {describe} from '../lib/errors.js';
import {panelView, popupView} from '../lib/view.js';

const NOW = new Date('2026-08-14T12:00:00Z');

function base(overrides = {}) {
    return {
        block: null,
        service: null,
        error: null,
        fetchedAt: NOW,
        refreshing: false,
        lastRequestAt: null,
        quotaCount: 2,
        menuQuotaCount: 2,
        locale: 'en-US',
        now: NOW,
        ...overrides,
    };
}

test('popupView shows the loading message before anything has been fetched', () => {
    const view = popupView(base({quotaCount: 0, menuQuotaCount: 0, fetchedAt: null}));
    assert.equal(view.message, 'Loading…');
    assert.equal(view.bodyVisible, false);
});

test('popupView hides the message entirely once quotas are on screen', () => {
    const view = popupView(base());
    assert.equal(view.message, '');
    assert.equal(view.messageVisible, false);
    assert.equal(view.bodyVisible, true);
});

test('popupView silences an error while the extension is rate-limited', () => {
    const view = popupView(base({
        block: {until: new Date('2026-08-14T12:30:00Z'), reason: 'rate-limit'},
        error: 'boom',
    }));
    assert.equal(view.issue, null);
    assert.match(view.message, /12:30/);
});

test('popupView offers a service incident on one line and on two', () => {
    const view = popupView(base({
        service: {status: 'major_outage', until: new Date('2026-08-14T14:00:00Z')},
    }));
    assert.notEqual(view.issue, null);
    assert.ok(view.issue.oneLine.includes(' · '));
    assert.ok(view.issue.twoLine.includes('\n'));
    assert.equal(view.separatorVisible, true);
});

test('popupView leaves the issue as a bare label when there is no until to append', () => {
    const view = popupView(base({service: {status: 'major_outage', until: null}}));
    const label = `${view.issue.emoji} ${view.issue.text}`;
    assert.equal(view.issue.oneLine, label);
    assert.equal(view.issue.twoLine, label);
});

test('popupView renders the plain error text when nothing else silences or explains it', () => {
    const view = popupView(base({error: describe('Something went sideways')}));
    assert.equal(view.message, 'Something went sideways');
});

test('popupView keeps the separator down when every quota is hidden, even with a live issue', () => {
    const view = popupView(base({
        quotaCount: 2,
        menuQuotaCount: 0,
        service: {status: 'major_outage', until: new Date('2026-08-14T14:00:00Z')},
    }));
    assert.equal(view.separatorVisible, false);
});

test('popupView disables refresh while a request is in flight', () => {
    assert.equal(popupView(base({refreshing: true})).refreshEnabled, false);
});

test('popupView returns refreshing as its own field, not just folded into refreshEnabled', () => {
    assert.equal(popupView(base({refreshing: true})).refreshing, true);
    assert.equal(popupView(base({refreshing: false})).refreshing, false);
});

test('popupView disables refresh inside the minimum request interval', () => {
    const view = popupView(base({lastRequestAt: new Date('2026-08-14T11:59:55Z')}));
    assert.equal(view.refreshEnabled, false);
});

test('popupView raises the hidden note when prefs have hidden every quota', () => {
    const view = popupView(base({menuQuotaCount: 0}));
    assert.equal(view.hiddenNote.visible, true);
    assert.equal(view.hiddenNote.text, 'Every quota is hidden.');
    assert.equal(view.hiddenNote.buttonLabel, 'Open settings');
});

test('popupView leaves the hidden note down when there is simply no data', () => {
    assert.equal(popupView(base({quotaCount: 0, menuQuotaCount: 0})).hiddenNote.visible, false);
});

test('panelView builds one dotted cell per visible quota', () => {
    const {cells, issueLast} = panelView({
        quotas: [{short: 'S', percent: 40, severity: 'normal'},
            {short: 'W', percent: 90, severity: 'critical'}],
        hasAnyQuota: true,
        service: null,
        error: null,
        scheme: 'dark',
        percentLocale: 'en-US',
    });
    assert.equal(cells.length, 2);
    assert.equal(cells[0].dotted, true);
    assert.equal(cells[1].styleClass, 'cq-panel-quota cq-critical-dark');
    assert.equal(issueLast, false);
});

test('panelView falls back to an ellipsis before anything is fetched', () => {
    const {cells} = panelView({
        quotas: [], hasAnyQuota: false, service: null, error: null,
        scheme: 'dark', percentLocale: 'en-US'});
    assert.equal(cells.length, 1);
    assert.equal(cells[0].text, '…');
    assert.equal(cells[0].dotted, false);
});

test('panelView falls back to a dash once a fetch has failed', () => {
    const {cells} = panelView({
        quotas: [], hasAnyQuota: false, service: null, error: 'boom',
        scheme: 'dark', percentLocale: 'en-US'});
    assert.equal(cells[0].text, '-');
});

test('panelView shows no fallback when the user hid every bar quota', () => {
    const {cells} = panelView({
        quotas: [], hasAnyQuota: true, service: null, error: null,
        scheme: 'dark', percentLocale: 'en-US'});
    assert.equal(cells.length, 0);
});

test('panelView appends an incident emoji and flags it as last', () => {
    const {cells, issueLast} = panelView({
        quotas: [{short: 'S', percent: 40, severity: 'normal'}],
        hasAnyQuota: true,
        service: {status: 'major_outage'},
        error: null,
        scheme: 'dark',
        percentLocale: 'en-US',
    });
    assert.equal(cells.length, 2);
    assert.equal(cells[1].dotted, false);
    assert.equal(issueLast, true);
});
