# Project Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `extension.js` into pure `lib/` logic and shell-bound `ui/` modules, enforce the coverage that split makes possible, make CI run on GitHub as well as Forgejo, and leave an architecture map an agent can navigate from.

**Architecture:** Three layers. `lib/` stays free of `gi://` and is imported by both `node --test` and the shell. A new `ui/` holds GObject classes and Gio/St wrappers. `extension.js` shrinks to construction, wiring, render orchestration and teardown. Rendering stays one-way: state fields on the Indicator are the truth, a pure view model is derived from them, and widgets consume the view model.

**Tech Stack:** GJS / GNOME Shell 50, plain ES modules, no build step. `node --test` (Node 24) for units, a Mutter devkit harness for e2e, `oxlint`, `xgettext`/`msgmerge` for i18n.

**Spec:** [`docs/superpowers/specs/2026-08-14-project-hardening-design.md`](../specs/2026-08-14-project-hardening-design.md)

## Global Constraints

- **`lib/*.js` must never import `gi://`.** Every module there is imported by the Node test runner. `lib/usage.js` is the one existing exception and is not touched by this plan.
- **State stays on the Indicator.** `_quotas`, `_limits`, `_error`, `_service`, `_block`, `_refreshing`, `_fetchedAt`, `_fired`, `_lastRequestAt`, `_rateLimitStreak`, `_seenExpiry` keep their names and remain direct properties of `Indicator`. `lib/state.js` computes the next state; it does not own it.
- **The e2e harness reads 42 Indicator internals over `Eval`.** When a member moves, its probes in `tools/e2e.sh`, `tools/lib/capture.sh` and `tools/lib/indicator.sh` are re-pathed **in the same commit**. A probe is never deleted or weakened to make a move easier.
- **No WHAT comments.** Only a WHY that a reader could not derive from the code. The existing comments in `extension.js` are WHY comments and travel with the code they explain.
- **No blank lines inside a function body.** Extract instead.
- **≤ 3 positional args** before switching to an options object.
- Every task ends green on `npm test && npm run lint && npm run e2e`.
- Commits are signed (`git commit -S`). No `Co-Authored-By` trailer is added in this repo's workspace.
- Forgejo (`origin`) is unreachable until 2026-08-15. Push only to the `github` remote during this branch's work.

---

### Task 1: CI runs on GitHub as well as Forgejo

**Files:**
- Modify: `.github/workflows/ci.yml:18-32`

**Interfaces:**
- Consumes: nothing
- Produces: a workflow that is byte-identical on both forges. Later tasks add one step to it (Task 6, `coverage`).

The workflow logs in to `git.lan.e7d.io` and pulls or pushes a cached CI image using `secrets.REGISTRY_TOKEN`. A GitHub runner reaches neither the host nor the secret, so today the run dies at the `login` step. Guard the two registry-touching steps on `github.server_url`; leave every check step untouched so the two forges run the same suite.

- [ ] **Step 1: Guard the login step**

In `.github/workflows/ci.yml`, replace the `login` step:

```yaml
      - name: login
        if: ${{ github.server_url != 'https://github.com' }}
        env: { T: "${{ secrets.REGISTRY_TOKEN }}", U: "${{ github.actor }}" }
        run: echo "$T" | docker login "$REGISTRY" -u "$U" --password-stdin
```

- [ ] **Step 2: Make the image step pull-or-build everywhere and push only where cached**

Replace the `image` step:

```yaml
      - name: image
        env:
          CACHED: ${{ github.server_url != 'https://github.com' }}
        run: |
          IMAGE="$CI_IMAGE:$(sha256sum .github/ci.Dockerfile | cut -c1-16)"
          echo "IMAGE=$IMAGE" >> $GITHUB_ENV
          if [ "$CACHED" = 'true' ] && docker pull "$IMAGE" 2>/dev/null; then
            exit 0
          fi
          docker build -f .github/ci.Dockerfile -t "$IMAGE" .github
          if [ "$CACHED" = 'true' ]; then
            docker push "$IMAGE"
          fi
```

The `if` blocks are deliberate rather than `&&` chains: `[ … ] && docker push` as the final line makes the step's exit status the test's, so a false test fails a step that did nothing wrong.

- [ ] **Step 3: Verify the workflow parses**

Run: `docker --context rootless run --rm -v "$PWD:/w:ro" -w /w mikefarah/yq:latest '.jobs.ci.steps[].name' .github/workflows/ci.yml`

Expected: the step names print in order — `null` (the checkout), `login`, `image`, `setup`, `install`, `lint`, `shellcheck`, `test`, `e2e`, `a11y`, `cleanup`. Any parse error is a YAML fault to fix before pushing.

The host `yq` is the kislyuk Python wrapper, so `yq '.jobs…' file` works there too if preferred — but not `yq eval`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -S -m "ci: run the same workflow on GitHub and Forgejo

The registry lives on the LAN and the token only exists on Forgejo, so
login and the image cache are guarded on the forge. Every check step is
unchanged, so both sides run the same suite."
```

- [ ] **Step 5: Push the branch to GitHub and dispatch the workflow**

```bash
git push github chore/project-hardening
gh workflow run ci.yml --repo e7d/gnome-claude-quota --ref chore/project-hardening
```

`on:` carries `workflow_dispatch`, and the workflow exists on the default branch, so the dispatch resolves against this branch's copy of the file. Pushing the branch alone triggers nothing — `push` is scoped to `main` and there is no PR.

- [ ] **Step 6: Watch the run and read the result**

```bash
gh run watch --repo e7d/gnome-claude-quota "$(gh run list --repo e7d/gnome-claude-quota --branch chore/project-hardening --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: `login` shows as skipped, `image` builds the Arch image without pushing, and `lint`, `shellcheck`, `test`, `e2e`, `a11y` all pass.

Two failure modes worth recognising rather than debugging blind:

- The build pulls `archlinux:base` from Docker Hub anonymously. A `toomanyrequests` here is a registry rate limit, not a workflow fault — re-run rather than rewriting the step.
- The e2e step needs `.github/logind-stub.sh` to have taken effect. A failure that names logind or a seat is the stub, not the guard added in this task.

Report what the run did. Do not proceed to Task 2 on a red run.

---

### Task 2: `lib/style.js` — style-class builders

**Files:**
- Create: `lib/style.js`
- Create: `test/style.test.js`
- Modify: `extension.js:65-75` (delete the three functions), `extension.js:16-29` (add the import)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `severityClass(base: string, severity: string, scheme: 'light'|'dark') → string`
  - `quotaClass(base: string, quota: {severity: string}, scheme: 'light'|'dark') → string`
  - `barClass(scheme: 'light'|'dark') → string`

`panelScheme()` stays in `extension.js` for now — it reads `Main.panel`'s theme node and belongs with the panel actors it serves. It moves in Task 6.

- [ ] **Step 1: Write the failing test**

Create `test/style.test.js`:

```js
import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {barClass, quotaClass, severityClass} from '../lib/style.js';

test('severityClass leaves a normal quota on the base class alone', () => {
    assert.equal(severityClass('cq-percent', 'normal', 'dark'), 'cq-percent');
});

test('severityClass appends a scheme-qualified class for a warning', () => {
    assert.equal(severityClass('cq-percent', 'warning', 'light'), 'cq-percent cq-warning-light');
});

test('severityClass appends a scheme-qualified class for a critical', () => {
    assert.equal(severityClass('cq-percent', 'critical', 'dark'), 'cq-percent cq-critical-dark');
});

test('quotaClass reads the severity off the quota', () => {
    assert.equal(quotaClass('cq-panel-quota', {severity: 'critical'}, 'light'),
        'cq-panel-quota cq-critical-light');
});

test('barClass names the bar for its scheme', () => {
    assert.equal(barClass('dark'), 'cq-bar cq-bar-dark');
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `TZ=UTC LC_ALL=C node --test test/style.test.js`
Expected: FAIL — `Cannot find module '.../lib/style.js'`.

- [ ] **Step 3: Create the module**

Create `lib/style.js`:

```js
export function severityClass(base, severity, scheme) {
    return severity === 'normal' ? base : `${base} cq-${severity}-${scheme}`;
}

export function quotaClass(base, quota, scheme) {
    return severityClass(base, quota.severity, scheme);
}

export function barClass(scheme) {
    return `cq-bar cq-bar-${scheme}`;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `TZ=UTC LC_ALL=C node --test test/style.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Point `extension.js` at the module**

Delete `severityClass`, `quotaClass` and `barClass` from `extension.js` (lines 65-75, leaving `displayItem` and `panelScheme` in place) and add to the import block, in the alphabetical position the block already uses:

```js
import {barClass, quotaClass} from './lib/style.js';
```

`severityClass` is not imported — `extension.js` only ever calls it through `quotaClass`. Let `oxlint` confirm that rather than assuming it.

- [ ] **Step 6: Verify the whole suite and the lint**

Run: `npm test && npm run lint`
Expected: 342 unit tests pass (337 + 5), lint silent.

- [ ] **Step 7: Verify the shell still renders**

Run: `npm run e2e -- --group=state --dark-only`
Expected: the state group passes with no `control …` line on stderr. A `control` failure means an assertion has gone dead — fix the assertion, never the control.

- [ ] **Step 8: Commit**

```bash
git add lib/style.js test/style.test.js extension.js
git commit -S -m "refactor(style): move the style-class builders to lib

They are string builders with no shell dependency, and no test could
reach them while they lived in extension.js."
```

---

### Task 3: `lib/view.js` — the popup and panel view models

**Files:**
- Create: `lib/view.js`
- Create: `test/view.test.js`
- Modify: `extension.js` — `_renderMessage`, `_renderIssue`, `_renderActions`, `_renderHiddenNote`, `_panelLabels` become actor-assignment only

**Interfaces:**
- Consumes: `quotaClass` from `lib/style.js` (Task 2)
- Produces:
  - `popupView({block, service, error, fetchedAt, refreshing, lastRequestAt, quotaCount, menuQuotaCount, locale, now}) → PopupView`
  - `panelView({quotas, hasAnyQuota, service, error, scheme, percentLocale}) → {cells: PanelCell[], issueLast: boolean}`

`quotas` is the **bar-visible** list; `hasAnyQuota` says whether any quota exists at all. The two differ whenever the user has hidden every quota from the bar, and the difference decides the fallback: an empty bar list with data behind it renders nothing, while an empty bar list with no data renders `…` or `-`. Collapsing them into one argument is the one way to get this function subtly wrong.

```
PopupView = {
  refreshText: string,
  issue: {emoji, text, oneLine, twoLine} | null,
  message: string,
  messageVisible: boolean,
  separatorVisible: boolean,
  bodyVisible: boolean,
  hiddenNote: {visible: boolean, text: string, buttonLabel: string},
  refreshEnabled: boolean,
}
PanelCell = {dotted: boolean, text: string, styleClass: string | null}
```

`issue.oneLine` and `issue.twoLine` are both returned because choosing between them needs an actor measurement (`_issueFits`). The view model offers both wordings; the widget picks. That keeps the measurement in the shell and the wording in a tested function.

- [ ] **Step 1: Write the failing test**

Create `test/view.test.js`:

```js
import {strict as assert} from 'node:assert';
import {test} from 'node:test';

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
});

test('popupView disables refresh while a request is in flight', () => {
    assert.equal(popupView(base({refreshing: true})).refreshEnabled, false);
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `TZ=UTC LC_ALL=C node --test test/view.test.js`
Expected: FAIL — `Cannot find module '.../lib/view.js'`.

- [ ] **Step 3: Create the module**

Create `lib/view.js`. Every helper it calls already exists and is already pure — this task moves the composition, it does not reimplement any of it.

```js
import {errorText} from './errors.js';
import {captionLine, percentLine, rateLimitMessage, refreshLine, serviceUntilLine} from './format.js';
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
    quotaCount, menuQuotaCount, locale, now}) {
    const throttleUntil = throttledUntil(block);
    const silenced = isBlocked(throttleUntil, now);
    const issue = silenced ? null : issueView({service, until: service?.until, locale, now});
    const errorLine = silenced || issue || error === null ? '' : errorText(error);
    const throttled = rateLimitMessage(throttleUntil, now, locale);
    const loading = issue === null && errorLine === '' && quotaCount === 0 && !silenced;
    const message = loading ? _('Loading…') : throttled || errorLine;
    return {
        refreshText: refreshLine(fetchedAt, now, locale),
        issue,
        message,
        messageVisible: message !== '',
        separatorVisible: (issue !== null || errorLine !== '' || throttled !== '')
            && menuQuotaCount > 0,
        bodyVisible: !loading,
        hiddenNote: hiddenNoteView(quotaCount, menuQuotaCount),
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `TZ=UTC LC_ALL=C node --test test/view.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Rewrite the render methods to consume the view model**

In `extension.js`, replace `_renderMessage`, `_renderIssue`, `_renderActions`, `_renderHiddenNote` and `_panelLabels` with assignment-only bodies driven by `popupView`/`panelView`. `_render` becomes:

```js
    _render() {
        const now = new Date();
        const scheme = this._scheme;
        const quotaViews = this._quotaViews(now);
        const menuViews = this._visibleOn('menu', quotaViews);
        const view = popupView({
            block: this._block,
            service: this._service,
            error: this._error,
            fetchedAt: this._fetchedAt,
            refreshing: this._refreshing,
            lastRequestAt: this._lastRequestAt,
            quotaCount: quotaViews.length,
            menuQuotaCount: menuViews.length,
            locale: this._locale,
            now,
        });
        this._renderActions(view);
        this._renderPanel(this._visibleOn('bar', quotaViews), quotaViews.length > 0, scheme);
        this._renderBlocks(menuViews, now, scheme);
        this._blockBox.visible = menuViews.length > 0;
        this._renderHiddenNote(view.hiddenNote);
        this._renderMessage(view);
    }
```

and `_renderMessage` becomes:

```js
    _renderMessage(view) {
        this._refreshLabel.text = view.refreshText;
        this._issueItem.visible = view.issue !== null;
        this._renderIssue(view.issue);
        this._messageLabel.text = view.message;
        this._message.visible = view.messageVisible;
        this._messageSeparator.visible = view.separatorVisible;
        this._body.visible = view.bodyVisible;
    }

    _renderIssue(issue) {
        if (issue === null) {
            this._issueItem.label.text = '';
            return;
        }
        this._issueItem.label.text = issue.oneLine;
        if (!this._issueFits())
            this._issueItem.label.text = issue.twoLine;
    }
```

`_renderActions` keeps the spinner calls and reads `view.refreshEnabled` for `reactive`/`opacity`. `_renderPanel` gains the `scheme` argument it currently recomputes and maps `panelView(...).cells` into `St.Label`s, setting `this._issueLast` from `issueLast`.

- [ ] **Step 6: Verify units, lint and the full e2e**

Run: `npm test && npm run lint && npm run e2e`
Expected: 355 unit tests (342 + 13) pass, lint silent, e2e green in both themes with no `control` line.

This is the first task whose change can alter rendered pixels, so the e2e runs whole rather than narrowed.

- [ ] **Step 7: Commit**

```bash
git add lib/view.js test/view.test.js extension.js
git commit -S -m "refactor(view): derive the popup and panel from a tested view model

The wording, visibility and severity decisions were reachable only
through a running shell. They are pure, so they move to lib and the
render methods keep only actor assignment."
```

---

### Task 4: `lib/state.js` — the result reducer

**Files:**
- Create: `lib/state.js`
- Create: `test/state.test.js`
- Modify: `extension.js` — `_applyResult`, `_adoptShared`, `_markSent`, and the `UNKNOWN_SERVICE` constant

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `UNKNOWN_SERVICE` — `{status: 'unknown', until: null}`
  - `applyResult({state, result, now}) → {state: State, effects: Effects}`
  - `adoptShared({state, shared, now}) → {state: State, effects: Effects} | null`

```
State = {limits, quotas, error, service, block, fetchedAt, seenExpiry, rateLimitStreak}
Effects = {save: boolean, syncAlerts: boolean, schedule: number}
```

`effects.schedule` is always a whole number of seconds — every branch of the original schedules something, so there is no null case. `adoptShared` returns `null` when the shared payload is not fresher, which is the caller's signal to do nothing at all.

- [ ] **Step 1: Write the failing test**

Create `test/state.test.js`:

```js
import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {adoptShared, applyResult, UNKNOWN_SERVICE} from '../lib/state.js';

const NOW = new Date('2026-08-14T12:00:00Z');

function state(overrides = {}) {
    return {
        limits: [],
        quotas: [],
        error: null,
        service: null,
        block: null,
        fetchedAt: null,
        seenExpiry: null,
        rateLimitStreak: 0,
        ...overrides,
    };
}

function ok(overrides = {}) {
    return {
        error: null,
        payload: {limits: [{type: 'five_hour', utilization: 40}]},
        expiresAt: null,
        desc: null,
        retryAfter: null,
        rateLimited: false,
        serverError: false,
        expired: false,
        ...overrides,
    };
}

test('applyResult on success clears the error, the block and the streak', () => {
    const {state: next, effects} = applyResult({
        state: state({error: 'boom', block: {until: NOW, reason: 'rate-limit'}, rateLimitStreak: 3}),
        result: ok(),
        now: NOW,
    });
    assert.equal(next.error, null);
    assert.equal(next.block, null);
    assert.equal(next.rateLimitStreak, 0);
    assert.deepEqual(next.fetchedAt, NOW);
    assert.equal(effects.save, true);
    assert.equal(effects.syncAlerts, true);
});

test('applyResult on success keeps the previous expiry when the result carries none', () => {
    const seen = new Date('2026-08-14T18:00:00Z');
    const {state: next} = applyResult({state: state({seenExpiry: seen}), result: ok(), now: NOW});
    assert.deepEqual(next.seenExpiry, seen);
});

test('applyResult on success adopts a new expiry when the result carries one', () => {
    const fresh = new Date('2026-08-15T00:00:00Z');
    const {state: next} = applyResult({
        state: state({seenExpiry: NOW}), result: ok({expiresAt: fresh}), now: NOW});
    assert.deepEqual(next.seenExpiry, fresh);
});

test('applyResult on a rate limit sets a block, advances the streak and shows no error', () => {
    const {state: next, effects} = applyResult({
        state: state(),
        result: ok({error: 'rate limited', payload: null, rateLimited: true, retryAfter: 60,
            desc: 'slow down'}),
        now: NOW,
    });
    assert.notEqual(next.block, null);
    assert.equal(next.rateLimitStreak, 1);
    assert.equal(next.error, null);
    assert.ok(effects.schedule > 0);
    assert.equal(effects.save, false);
});

test('applyResult on a repeated rate limit backs off further than the first', () => {
    const once = applyResult({
        state: state(),
        result: ok({error: 'rate limited', payload: null, rateLimited: true, retryAfter: null}),
        now: NOW,
    });
    const twice = applyResult({
        state: state({rateLimitStreak: 3}),
        result: ok({error: 'rate limited', payload: null, rateLimited: true, retryAfter: null}),
        now: NOW,
    });
    assert.ok(twice.effects.schedule > once.effects.schedule);
});

test('applyResult on a plain failure keeps the description and clears any block', () => {
    const {state: next} = applyResult({
        state: state({block: {until: NOW, reason: 'rate-limit'}}),
        result: ok({error: 'nope', payload: null, desc: 'Network unreachable'}),
        now: NOW,
    });
    assert.equal(next.block, null);
    assert.equal(next.error, 'Network unreachable');
    assert.equal(next.service, null);
});

test('applyResult names the service unknown on a server error before status has answered', () => {
    const {state: next} = applyResult({
        state: state(),
        result: ok({error: 'nope', payload: null, desc: 'Server error', serverError: true}),
        now: NOW,
    });
    assert.deepEqual(next.service, UNKNOWN_SERVICE);
});

test('adoptShared declines a payload that is not fresher than ours', () => {
    const result = adoptShared({
        state: state({fetchedAt: NOW}),
        shared: {limits: [], fetchedAt: new Date('2026-08-14T11:00:00Z')},
        now: NOW,
    });
    assert.equal(result, null);
});

test('adoptShared takes a fresher payload and asks for a save and an alert sync', () => {
    const fresher = new Date('2026-08-14T12:05:00Z');
    const {state: next, effects} = adoptShared({
        state: state({fetchedAt: NOW, error: 'boom'}),
        shared: {limits: [{type: 'five_hour', utilization: 10}], fetchedAt: fresher},
        now: NOW,
    });
    assert.deepEqual(next.fetchedAt, fresher);
    assert.equal(next.error, null);
    assert.equal(next.service, null);
    assert.equal(effects.save, true);
    assert.equal(effects.syncAlerts, true);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `TZ=UTC LC_ALL=C node --test test/state.test.js`
Expected: FAIL — `Cannot find module '.../lib/state.js'`.

- [ ] **Step 3: Create the module**

Create `lib/state.js`:

```js
import {quotas} from './model.js';
import {blockReason, nextPollSeconds, rateLimitBlock, RATE_LIMIT} from './policy.js';
import {fresherThan} from './shared-usage.js';

export const UNKNOWN_SERVICE = {status: 'unknown', until: null};

const NO_EFFECTS = {save: false, syncAlerts: false, schedule: 0};

function succeeded(state, result, now) {
    return {
        state: {
            ...state,
            limits: Array.isArray(result.payload?.limits) ? result.payload.limits : [],
            quotas: quotas(result.payload, now),
            error: null,
            service: null,
            block: null,
            rateLimitStreak: 0,
            fetchedAt: now,
            seenExpiry: result.expiresAt ?? state.seenExpiry,
        },
        effects: {save: true, syncAlerts: true, schedule: nextPollSeconds(null)},
    };
}

function blocked(state, result, reason, now) {
    const block = rateLimitBlock(result.retryAfter, now, state.rateLimitStreak);
    return {
        state: {
            ...state,
            rateLimitStreak: state.rateLimitStreak + 1,
            block: {until: block.until, reason},
            error: reason === RATE_LIMIT ? null : result.desc,
            service: null,
        },
        effects: {...NO_EFFECTS, schedule: nextPollSeconds(block.seconds)},
    };
}

function failed(state, result) {
    return {
        state: {
            ...state,
            block: null,
            error: result.desc,
            service: result.serverError ? UNKNOWN_SERVICE : null,
        },
        effects: {...NO_EFFECTS, schedule: nextPollSeconds(result.retryAfter)},
    };
}

export function applyResult({state, result, now}) {
    if (result.error === null)
        return succeeded(state, result, now);
    const reason = blockReason(result);
    return reason === null ? failed(state, result) : blocked(state, result, reason, now);
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
            service: null,
            fetchedAt: shared.fetchedAt,
        },
        effects: {save: true, syncAlerts: true, schedule: 0},
    };
}
```

The WHY comment on `_applyResult`'s `service` line — *"Named before status.claude.com has answered, so the line appears with the first failed poll and is only ever refined, never introduced late"* — moves onto `failed()`.

- [ ] **Step 4: Run the test and watch it pass**

Run: `TZ=UTC LC_ALL=C node --test test/state.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire the Indicator to the reducer**

Add a private pair that reads the state fields into a snapshot and writes a snapshot back, so the field names stay exactly where the harness expects them:

```js
    _snapshot() {
        return {
            limits: this._limits,
            quotas: this._quotas,
            error: this._error,
            service: this._service,
            block: this._block,
            fetchedAt: this._fetchedAt,
            seenExpiry: this._seenExpiry,
            rateLimitStreak: this._rateLimitStreak,
        };
    }

    _adopt(state) {
        this._limits = state.limits;
        this._quotas = state.quotas;
        this._error = state.error;
        this._service = state.service;
        this._block = state.block;
        this._fetchedAt = state.fetchedAt;
        this._seenExpiry = state.seenExpiry;
        this._rateLimitStreak = state.rateLimitStreak;
    }

    _perform(effects, now) {
        if (effects.save)
            this._saveCache();
        if (effects.syncAlerts)
            this._syncAlerts(now);
        if (effects.schedule > 0)
            this._scheduleNext(effects.schedule);
    }
```

`_applyResult(result)` becomes a three-liner over `applyResult`, and `_adoptShared(now)` keeps its attempt-record append — that is IO, not a decision — and returns early when `adoptShared` answers `null`.

`UNKNOWN_SERVICE` is deleted from `extension.js` and imported from `lib/state.js`; `_refreshServiceStatus` keeps using it.

- [ ] **Step 6: Verify units, lint and the full e2e**

Run: `npm test && npm run lint && npm run e2e`
Expected: 364 unit tests (355 + 9) pass, lint silent, e2e green.

The e2e runs whole here because `$IND._applyResult` is called directly by the harness — the rate-limit and service scenarios exercise exactly the branches this task moved.

- [ ] **Step 7: Commit**

```bash
git add lib/state.js test/state.test.js extension.js
git commit -S -m "refactor(state): make the result reducer a tested pure function

Thirty lines of rate-limit, block-reason and streak branching had no
shell dependency and no test could reach them. The reducer decides and
returns effects; the Indicator performs them and still owns the fields."
```

---

### Task 5: `ui/` — the two widgets

**Files:**
- Create: `ui/pace-bar.js`, `ui/quota-block.js`
- Modify: `extension.js:44-148` (remove `displayItem`, `PaceBar`, `QuotaBlock`), `.oxlintrc.json:15`, `tools/i18n.sh:19`

**Interfaces:**
- Consumes: `barClass`, `quotaClass` from `lib/style.js` (Task 2)
- Produces:
  - `ui/pace-bar.js` — default export `PaceBar`, a registered `BarLevel` subclass with `setPace(ratio: number|null)`
  - `ui/quota-block.js` — named exports `QuotaBlock` (registered `St.BoxLayout`, `update({quota, now, scheme, locale, percentLocale})`) and `displayItem() → PopupMenu.PopupBaseMenuItem`

This is the first task that creates `ui/`, so it also teaches the two tools that scan source paths about the new directory. Miss either and the failure is silent: `oxlint` stops applying the GJS globals (so `logError` reads as undefined only once something there uses it), and `xgettext` stops seeing the msgids (so the string ships in English with no warning — `npm run i18n:check` does not catch an empty `msgstr`).

- [ ] **Step 1: Teach oxlint about `ui/`**

In `.oxlintrc.json`, extend the GJS override's file glob:

```json
      "files": ["extension.js", "prefs.js", "lib/*.js", "ui/*.js"],
```

- [ ] **Step 2: Teach xgettext about `ui/`**

In `tools/i18n.sh`, extend the extraction file list at line 19:

```bash
        extension.js prefs.js lib/*.js ui/*.js)
```

- [ ] **Step 3: Create `ui/pace-bar.js`**

Move the `PaceBar` class verbatim, including its use of `TICK_OVERHANG`, which moves with it as a module constant:

```js
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';

import {tickRects} from '../lib/bar.js';

const TICK_OVERHANG = 2;

export default GObject.registerClass(
class PaceBar extends BarLevel {
    // …body unchanged from extension.js:79-114…
});
```

- [ ] **Step 4: Create `ui/quota-block.js`**

Move `QuotaBlock` and `displayItem`, plus the `CAPTION_OPACITY` constant `QuotaBlock` reads. `CAPTION_OPACITY` is also used by `extension.js`'s `_refreshLabel` and by `_renderActions`, so export it from here rather than duplicating the literal:

```js
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {captionLine, percentLine} from '../lib/format.js';
import {barClass, quotaClass} from '../lib/style.js';

import PaceBar from './pace-bar.js';

export const CAPTION_OPACITY = 180;

// The insensitive pseudo-class the shipped theme paints at 50% alpha is what a
// non-reactive item gets, and every child label inherits it.
export function displayItem() {
    // …body unchanged from extension.js:47-55…
}

export const QuotaBlock = GObject.registerClass(
class QuotaBlock extends St.BoxLayout {
    // …body unchanged from extension.js:119-147…
});
```

- [ ] **Step 5: Point `extension.js` at the new modules**

Delete `displayItem`, `PaceBar`, `QuotaBlock`, `CAPTION_OPACITY` and `TICK_OVERHANG` from `extension.js` and import what remains in use:

```js
import {CAPTION_OPACITY, displayItem, QuotaBlock} from './ui/quota-block.js';
```

`extension.js` no longer imports `BarLevel`, `tickRects`, `barClass` or `captionLine`. Let `oxlint`'s `no-unused-vars` name the leftovers rather than pruning by eye.

- [ ] **Step 6: Verify the catalog did not lose a string**

Run: `npm run i18n && git diff --stat po/`
Expected: `po/claude-quota.pot` and `po/fr.po` show **location-line changes only** — no `msgid` removed, no `msgstr` emptied. Confirm with:

```bash
git diff po/ | grep -E '^[-+]msg' || echo 'no msgid or msgstr changed'
```

Expected: `no msgid or msgstr changed`. Any line here means a path was missed in Step 2 — fix that before continuing, because the check that would normally catch it cannot.

- [ ] **Step 7: Verify units, lint and the full e2e**

Run: `npm test && npm run lint && npm run i18n:check && npm run e2e`
Expected: 364 unit tests pass, lint silent, i18n check silent, e2e green in both themes.

- [ ] **Step 8: Commit**

```bash
git add ui/pace-bar.js ui/quota-block.js extension.js .oxlintrc.json tools/i18n.sh po/
git commit -S -m "refactor(ui): give the two widgets their own modules

Opens ui/ for shell-bound code and teaches oxlint and xgettext to scan
it — xgettext silently, since i18n:check cannot see a msgid that was
never extracted."
```

---

### Task 6: `ui/popup-body.js` and `ui/panel-fit.js`

**Files:**
- Create: `ui/popup-body.js`, `ui/panel-fit.js`
- Modify: `extension.js` (constructor, `_render`, `_onDestroy`), `tools/e2e.sh`, `tools/lib/capture.sh`, `tools/lib/indicator.sh`

**Interfaces:**
- Consumes: `popupView`, `panelView` from `lib/view.js` (Task 3); `QuotaBlock`, `displayItem`, `CAPTION_OPACITY` from `ui/quota-block.js` (Task 5)
- Produces:
  - `ui/popup-body.js` — `PopupBody` class taking `{onRefresh, onOpenPrefs}`, exposing `items: PopupMenu.PopupBaseMenuItem[]` for the caller to add to the menu, and `update({view, quotas, now, scheme, locale, percentLocale})`
  - `ui/panel-fit.js` — `PanelStrip` class taking `{container, box, icon}`, exposing `update({cells, issueLast, scheme})`, `fit()`, `destroy()`

`PanelStrip.update` takes the cell descriptors `panelView` already produced, not the raw quotas — the Indicator calls `panelView` once in `_render()` and hands the result down. `scheme` is passed because the icon's brand colour is set from it.

`PopupBody` owns `_body`, `_bodyBox`, `_metaBox`, `_refreshLabel`, `_refreshButton`, `_message`, `_messageBox`, `_messageLabel`, `_messageSeparator`, `_blockBox`, `_blocks`, `_hiddenNoteItem`, `_hiddenNoteBox`, `_hiddenNote`, `_hiddenNoteButton`, `_issueItem`, and the spinner. `PanelStrip` owns `_cells`, `_issueLast`, `_fitLaterId`, `_panelSignals` and the budget measurement.

The harness re-paths in this task. `$IND._body` becomes `$IND._popup._body`, `$IND._panelCells` becomes `$IND._panel._cells`, and so on. Re-path every probe; weaken none.

- [ ] **Step 1: List every probe that will move**

Run:

```bash
grep -nhoE '\$\{?IND\}?\._[a-zA-Z]+' tools/e2e.sh tools/lib/capture.sh tools/lib/indicator.sh \
  | sort | uniq -c | sort -rn
```

Write the list down. It is the checklist for Step 5, and the count before must equal the count after.

- [ ] **Step 2: Create `ui/popup-body.js`**

Move the popup actor construction out of `Indicator._init` verbatim into `PopupBody._init`, keeping every `style_class`, `clutter_text` setting and `connect` exactly as it is. The refresh button's handler becomes `() => this._onRefresh()`; the hidden-note button's becomes `() => this._onOpenPrefs()`.

`update({view, quotas, now, scheme, locale, percentLocale})` performs, in this order, what `_renderActions`, `_renderBlocks`, `_renderHiddenNote` and `_renderMessage` do today — reading only from `view` and the quota list, never recomputing a decision. `_issueFits()` and the spinner move here unchanged.

- [ ] **Step 3: Create `ui/panel-fit.js`**

Move `panelScheme`, `_panelSeparator`, `_renderPanel`, `_panelKeepOrder`, `_showPanelCells`, `_panelNaturalWidth`, `_centerOffset`, `_panelBudget`, `_fitPanel`, `_queueFit` and `_watchPanelSpace` into `PanelStrip`, dropping the `_panel` prefix where it now only repeats the class name: `_keepOrder`, `_showCells`, `_naturalWidth`, `_budget`, `fit()`, `_queueFit()`. `destroy()` disconnects the panel signals and removes the pending later.

Every WHY comment travels with its method — the centre-offset subtraction, the "empty box is still a child" note, the first-render-has-no-stage note, and the incident-emoji ordering note.

- [ ] **Step 4: Rewire the Indicator**

`Indicator._init` builds the icon and the panel box, constructs `this._popup = new PopupBody({onRefresh: () => this._refresh('manual'), onOpenPrefs: () => { this.menu.close(); this._openPrefs?.(); }})`, adds `this._popup.items` to the menu, and constructs `this._panel = new PanelStrip({container: this.container, box: this._panelQuotas})`.

`_render()` becomes the orchestration the spec describes: derive the view model, hand it to `this._popup.update(…)` and `this._panel.update(…)`. `_onDestroy` calls `this._popup.destroy()` and `this._panel.destroy()` in place of the per-actor teardown it does today.

- [ ] **Step 5: Re-path every probe from Step 1**

Update `tools/e2e.sh`, `tools/lib/capture.sh` and `tools/lib/indicator.sh`. Then re-run the Step 1 command and confirm the total probe count is unchanged and every path resolves.

- [ ] **Step 6: Verify units, lint, shellcheck and the full e2e**

Run: `npm test && npm run lint && shellcheck -x tools/*.sh tools/lib/*.sh && npm run e2e && npm run a11y`
Expected: 364 unit tests pass, lint and shellcheck silent, e2e green in both themes with no `control` line on stderr, a11y zero findings.

A `control …` line here is the signal that a re-pathed probe now reads something that cannot vary — the assertion went dead in the move. Fix the assertion; never the control.

- [ ] **Step 7: Commit**

```bash
git add ui/popup-body.js ui/panel-fit.js extension.js tools/e2e.sh tools/lib/capture.sh tools/lib/indicator.sh
git commit -S -m "refactor(ui): split the popup body and the panel strip out

Both own their actors and take one update() over the view model, the
shape QuotaBlock already used. The e2e probes move with them."
```

---

### Task 7: `ui/store.js`, `ui/alerts.js`, `ui/poller.js`

**Files:**
- Create: `ui/store.js`, `ui/alerts.js`, `ui/poller.js`
- Modify: `extension.js`, `tools/e2e.sh`, `tools/lib/capture.sh`, `tools/lib/indicator.sh`

**Interfaces:**
- Consumes: `applyResult`, `adoptShared`, `UNKNOWN_SERVICE` from `lib/state.js` (Task 4)
- Produces:
  - `ui/store.js` — `Store` with `load() → {limits, fetchedAt, fired} | null`, `save({limits, fetchedAt, fired})`, `appendAttempt(record)`, `attemptsPath()`
  - `ui/alerts.js` — `Alerts` taking `{iconPath, onActivate}`, with `sync({quotas, fired, thresholds, now, locale, percentLocale}) → {fired, changed: boolean}`, `refresh(...)`, `destroy()`
  - `ui/poller.js` — `Poller` taking `{onResult, onServiceStatus, onCredentials}`, with `refresh(trigger)`, `schedule(seconds)`, `destroy()`

Split from Task 6 deliberately: three collaborators in one commit would put the whole fetch path, the whole notification path and the whole persistence path behind a single e2e run.

- [ ] **Step 1: Create `ui/store.js` and rewire `_loadCache`/`_saveCache`/`_appendAttempt`**

Move `_cachePath`, `_attemptsPath`, `_loadCache`'s file half, `_saveCache`, `_readAttempts` and `_appendAttempt`. The `deserialize`/`serialize` calls travel with them; the *decision* of what to do with a loaded cache stays on the Indicator, because it sets state fields the harness reads.

- [ ] **Step 2: Verify and commit the store**

Run: `npm test && npm run lint && npm run e2e -- --group=state`
Expected: green, no `control` line.

```bash
git add ui/store.js extension.js tools/e2e.sh tools/lib/indicator.sh
git commit -S -m "refactor(ui): move the cache and attempts IO to a store"
```

- [ ] **Step 3: Create `ui/alerts.js` and rewire the notification path**

Move `_notifySource`, `_postAlert`, `_withdrawAlert`, `_rewrite`, `_refreshAlerts`, `_trackAlertRefresh`, `_armAlertRefresh`, `_stopAlertRefresh` and the `URGENCY` map. `_syncAlerts` stays on the Indicator as the caller that assembles inputs and persists `fired` — `Alerts.sync` returns the new `fired` plus whether anything changed, and the Indicator decides whether to save.

The two WHY comments here are load-bearing and travel verbatim: the `Source` destroying itself with its last notification, and the `datetime` re-stamp that makes a refreshed notification read "Just now" forever.

- [ ] **Step 4: Verify and commit the alerts**

Run: `npm test && npm run lint && npm run e2e -- --group=notify`
Expected: the notify group green, including the assertion that `_source` goes `null` after the last alert is withdrawn — re-pathed to wherever the source now lives.

```bash
git add ui/alerts.js extension.js tools/e2e.sh tools/lib/indicator.sh
git commit -S -m "refactor(ui): move the notification lifecycle to an alerts module"
```

- [ ] **Step 5: Create `ui/poller.js` and rewire the fetch path**

Move `_scheduleNext`, `_fetchCycle`, `_fetchResult`, `_refreshServiceStatus`, `_recordAttempt`, `_markSent`, `_watchCredentials`, `_settleCredentials`, `_credentialExpiry`, `_onCredentialsWritten`, the `UsageClient`/`StatusClient` instances, the cancellable and `CREDENTIALS_SETTLE_SECONDS`. `_refresh(trigger)` stays on the Indicator: it reads and writes state fields the harness drives directly.

- [ ] **Step 6: Verify the whole thing**

Run: `npm test && npm run lint && shellcheck -x tools/*.sh tools/lib/*.sh && npm run e2e && npm run a11y`
Expected: 364 unit tests pass, everything else silent or green.

- [ ] **Step 7: Confirm the shell spent nothing**

Run: `wc -l ~/.cache/claude-quota/attempts.jsonl` before and after the e2e run.
Expected: unchanged. A nested session must never reach the endpoint; a moved line count means the refactor reintroduced a real fetch.

- [ ] **Step 8: Check the size target and commit**

Run: `wc -l extension.js ui/*.js lib/*.js`
Expected: `extension.js` at 300 lines or fewer. Report the number either way — a miss is worth naming, not quietly accepting.

```bash
git add ui/poller.js extension.js tools/e2e.sh tools/lib/capture.sh tools/lib/indicator.sh
git commit -S -m "refactor(ui): move the fetch cycle and credential watch to a poller

extension.js is construction, wiring, render orchestration and teardown."
```

---

### Task 8: The coverage gate

**Files:**
- Create: `tools/coverage-census.js`, `test/coverage-census.test.js`
- Modify: `package.json:5-17`, `.github/workflows/ci.yml`, `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `npm run coverage`, and `census(lcov: string, modules: string[], exempt: string[]) → string[]` returning the module paths absent from the report

Thresholds alone cannot catch this repo's actual gap. **A module that no test imports does not appear in the coverage report at all, so it satisfies every threshold.** That is exactly the state `extension.js` was in. The gate is therefore two checks: Node's thresholds over `lib/**`, and a census that every `lib/*.js` appears in the report.

- [ ] **Step 1: Write the failing test for the census**

Create `test/coverage-census.test.js`:

```js
import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {census} from '../tools/coverage-census.js';

const LCOV = ['SF:lib/model.js', 'end_of_record', 'SF:lib/policy.js', 'end_of_record'].join('\n');

test('census is silent when every module appears in the report', () => {
    assert.deepEqual(census(LCOV, ['lib/model.js', 'lib/policy.js'], []), []);
});

test('census names a module the report never mentions', () => {
    assert.deepEqual(census(LCOV, ['lib/model.js', 'lib/orphan.js'], []), ['lib/orphan.js']);
});

test('census forgives a module named as exempt', () => {
    assert.deepEqual(census(LCOV, ['lib/model.js', 'lib/usage.js'], ['lib/usage.js']), []);
});

test('census tolerates absolute paths in the report', () => {
    const absolute = 'SF:/home/x/claude-quota/lib/model.js\nend_of_record';
    assert.deepEqual(census(absolute, ['lib/model.js'], []), []);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `TZ=UTC LC_ALL=C node --test test/coverage-census.test.js`
Expected: FAIL — `Cannot find module '.../tools/coverage-census.js'`.

- [ ] **Step 3: Write the census**

Create `tools/coverage-census.js`:

```js
import {readdirSync, readFileSync} from 'node:fs';

const EXEMPT = ['lib/usage.js'];

export function census(lcov, modules, exempt) {
    const covered = new Set(lcov.split('\n')
        .filter(line => line.startsWith('SF:'))
        .map(line => line.slice(3).replace(/^.*?(?=lib\/)/, '')));
    return modules.filter(module => !covered.has(module) && !exempt.includes(module));
}

function main() {
    const modules = readdirSync('lib')
        .filter(name => name.endsWith('.js'))
        .map(name => `lib/${name}`);
    const missing = census(readFileSync('coverage/lcov.info', 'utf8'), modules, EXEMPT);
    if (missing.length === 0)
        return;
    console.error(`no test imports: ${missing.join(', ')}`);
    console.error('every lib module must be reachable from the suite, or named exempt here');
    process.exit(1);
}

if (process.argv[1]?.endsWith('coverage-census.js'))
    main();
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `TZ=UTC LC_ALL=C node --test test/coverage-census.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the npm script**

In `package.json`, after `"test"`:

```json
    "coverage": "TZ=UTC LC_ALL=C node --test --experimental-test-coverage --test-coverage-include='lib/**' --test-coverage-lines=100 --test-coverage-branches=95 --test-coverage-functions=100 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=coverage/lcov.info && node tools/coverage-census.js",
```

Add `coverage/` to `.gitignore`.

- [ ] **Step 6: Run it and read the real numbers**

Run: `npm run coverage`
Expected: pass. The measured baseline before this branch was 100.00 lines / 96.75 branches / 99.13 functions across `lib/` and `tools/lib/`; scoped to `lib/**` and with the new modules from Tasks 2-4 it should be at or above that. If a threshold fails, report the actual figure — do not lower the threshold to meet it without saying so.

- [ ] **Step 7: Prove the census can fail**

```bash
printf 'export function orphan() {\n    return 1;\n}\n' > lib/__census-probe.js
npm run coverage; echo "exit=$?"
rm lib/__census-probe.js
```

Expected: `no test imports: lib/__census-probe.js` and a non-zero exit. A census that has never fired is not known to be a check. Record the observed output in the commit message.

- [ ] **Step 8: Add the CI step**

In `.github/workflows/ci.yml`, after the `test` step:

```yaml
      - name: coverage
        run: docker exec "$C" npm run coverage
```

- [ ] **Step 9: Verify and commit**

Run: `npm test && npm run lint && npm run coverage`
Expected: all green.

```bash
git add tools/coverage-census.js test/coverage-census.test.js package.json .gitignore .github/workflows/ci.yml
git commit -S -m "test: gate coverage on thresholds and on reachability

A module no test imports is absent from the report and passes every
threshold, which is how extension.js went uncovered. The census fails on
any lib module missing from the report; verified by adding one."
```

---

### Task 9: The architecture map

**Files:**
- Create: `docs/architecture.md`
- Modify: `AGENTS.md`, `README.md` (§ Development), `docs/development.md`

**Interfaces:**
- Consumes: the module set as it stands after Task 7
- Produces: documentation only

Written last, against the real tree rather than the plan's intent. Read the files before describing them.

- [ ] **Step 1: Write `docs/architecture.md`**

Four sections, no more:

1. **The three layers** — `lib/` pure and dual-imported, `ui/` shell-bound, `extension.js` wiring. State the `gi://` rule and name `lib/usage.js` as the exception.
2. **Module map** — one table row per module: what it owns, what it depends on, whether it is unit-tested or e2e-covered.
3. **The render path** — state → `lib/view.js` → view model → widgets, and the one-way rule.
4. **Where to add X** — a table: a new quota field, a new user-facing string, a new setting, a new panel state, a new e2e scenario. Each row names the files in the order they are touched.

Do not restate rules `AGENTS.md` already carries. Point at them.

- [ ] **Step 2: Index it from `AGENTS.md`**

One line, in the shape the file already uses, naming the trigger that should make an agent open it — not a summary of its contents.

- [ ] **Step 3: Document `npm run coverage`**

`README.md` § Development gains the script alongside `npm test`. `docs/development.md` gains a short subsection explaining the census and why thresholds alone would not catch a missing module.

- [ ] **Step 4: Verify every path the docs name actually exists**

```bash
grep -ohE '(lib|ui|tools|test|docs)/[a-z-]+\.(js|md|sh)' docs/architecture.md \
  | sort -u | while read -r f; do [ -e "$f" ] || echo "MISSING: $f"; done
```

Expected: no output. A doc that names a file which does not exist is worse than no doc.

- [ ] **Step 5: Final full verification**

Run: `npm test && npm run lint && npm run coverage && npm run i18n:check && shellcheck -x tools/*.sh tools/lib/*.sh && npm run e2e && npm run a11y`
Expected: all green. Report the unit test count, the coverage figures and the e2e result.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md AGENTS.md README.md docs/development.md
git commit -S -m "docs: map the module layout for agents

AGENTS.md keeps the index; the map carries the detail, per the tiering
rule the rest of this setup uses."
```

- [ ] **Step 7: Re-validate CI on both forges**

```bash
git push github chore/project-hardening
gh workflow run ci.yml --repo e7d/gnome-claude-quota --ref chore/project-hardening
```

Forgejo returns 2026-08-15. Once it is up, push the branch to `origin` and confirm the same workflow passes there with the `login` and cache steps active. **The branch is not finished until both forges have run it** — the whole point of Task 1 was that one green forge proves only half the claim.

---

## Notes for the executor

- `npm run e2e` takes minutes. While iterating inside a task, narrow it: `npm run e2e -- --group=state --dark-only --scenario=loading`. Run it whole at each task's end.
- Two concurrent `npm run e2e` runs are refused by a `flock`. If one hangs, kill the nested shell **by pid** — matching `gnome-shell` by name kills the user's desktop.
- After anything that starts a shell, confirm the host survived: `sha256sum ~/.config/dconf/user` and the length of `gsettings get org.gnome.shell enabled-extensions`.
- GNOME caches extension modules for the life of a shell process. A disable/enable cycle re-runs the *old* code; only a fresh nested shell loads an edit.
- `git commit -S` needs a cached GPG passphrase. If it prompts and cannot, stage the files and hand the commit to the user rather than dropping the signature.
