# Quota notifications — design

**Date:** 2026-08-14
**Status:** designed

## Problem

The extension shows a quota climbing but never says anything about it. A user who is not looking at
the top bar reaches 100% without warning, and the only signal that anything was coming was a colour
they did not see. The panel already carries a severity — `warning`, `critical`, `normal`, straight
from the endpoint — so the information exists; nothing acts on it.

Acting on it is not a rendering change. A notification is a side effect with a lifetime of its own:
it has to fire once and not once per poll, survive a shell restart without re-firing, and stop being
true when the quota window rolls over. That is state, and state that outlives the process has to be
persisted and has to be testable.

## Scope

Notifications for every quota the popup shows, gated on thresholds the user owns, with the GSettings
keys the future settings panel will bind to — but no preferences UI. The settings panel is its own
TODO item covering display, localization and notifications together; landing its schema now means
that ticket builds widgets over keys that already work, rather than schema and UI and plumbing at
once.

Out of scope: the preferences window, any notification for service status or rate limiting (those
already have a line in the popup), and sound.

## Decisions taken before design

Each of these was a real fork, and the reasoning matters more than the outcome:

- **Own percentage thresholds, not the endpoint's `severity`.** The server's severity is free and
  always agrees with the colour on screen, but it leaves nothing to configure and hands Anthropic the
  decision about when a user is interrupted. Thresholds are the thing the settings panel is specified
  to expose, so they are the thing the notification reads.
- **Every quota shown, not the session alone.** The TODO line names the session quota, but reaching
  95% on the weekly with no warning is precisely the failure the feature exists to prevent, and a
  user living in one model exhausts a model-scoped quota first.
- **Once per threshold per window, re-arming when the percentage drops.** A session window rolls, so
  a percentage genuinely can fall; a level that could never re-arm would go silent for the rest of a
  window it no longer describes.
- **Warning is `NORMAL` urgency, critical is `HIGH`.** `HIGH` stays in the tray and shows over a
  fullscreen window; `CRITICAL` never auto-dismisses at all, which is a rude thing to do about a
  number that resets on its own within hours.

## What the shell actually provides

Read from `ui/messageTray.js` and `ui/messageList.js`, extracted from `libshell-18.so` on GNOME Shell
50.4 — not from documentation:

- `Notification.destroy(reason)` (`messageTray.js:494`) with `NotificationDestroyedReason.EXPIRED = 1`
  (`:48`). Withdrawing a notification we posted is therefore possible for `HIGH` exactly as for
  `NORMAL`: hold the handle, destroy it, and it leaves both the banner and the tray.
- `Source` **destroys itself when its last notification is removed** (`_onNotificationDestroy`,
  `:578`). A cached source reference goes stale with no error, which is why the shell's own
  `getSystemSource()` (`:1322`) re-creates lazily and nulls its reference on the source's `destroy`.
  This design does the same.
- `Notification` carries `title`, `body`, `gicon`, `urgency`, `is-transient`, and emits `activated`
  and `destroy` (`:630`–`:698`). `MessageList.Source` carries `title` and an `icon` of type
  `Gio.Icon`, so the source can show the extension's own icon.

Per the tree's standing rule, none of this is trusted until asserted back from a running shell; the
e2e group below is where that happens.

## Identity

A scoped limit's `kind` is not unique. The committed fixture holds `kind: "weekly_scoped"` with
`scope.model.display_name: "Fable"`, so two model-scoped quotas would share one `kind` and collide
into a single alert. `lib/model.js` is the only module holding the raw limit, so it gains a `key`
field composed of `kind` and the model's id — falling back to the display name when the id is
`null`, as it is in the fixture. Nothing else reads `key`; the panel is unaffected.

## The state machine

`lib/notify.js`, pure, no `gi://`, importable by `node --test` like every `lib/` module but
`usage.js`. One entry point:

```js
alertPlan({quotas, fired, thresholds, now, locale, percentLocale}) → {post, withdraw, fired}
```

`thresholds` is a list of `{level, percent, enabled}` for `warning` and `critical`.

`fired` is the persisted bookkeeping: `{"<quotaKey>|<level>": {window: "<resetsAt ISO>"}}`, meaning
*this level has already fired for this window*. It is deliberately separate from the live
notification handles, because a user dismissing a banner must not re-arm the level — dismissal
destroys the handle, and if that were the only record the next poll would post again.

For each quota, for each enabled level:

| Condition | Result |
| --- | --- |
| entry exists and its `window` differs from the quota's `resetsAt` | withdraw, drop the entry — the window rolled, so the level re-arms |
| quota expired, or `percent` not finite | withdraw, drop the entry |
| `percent >= threshold` and no entry | post, write the entry |
| `percent <= threshold - HYSTERESIS` and an entry exists | withdraw, drop the entry |
| between `threshold - HYSTERESIS` and `threshold`, entry exists | nothing: no re-post, the notification stays |
| level disabled | withdraw, drop the entry |

And once, before any of those, over the entries rather than over the quotas: **an entry
whose quota is not in the list at all is withdrawn and dropped**. `lib/model.js` drops any
non-`ALWAYS_VISIBLE` limit at `percent === 0`, which is exactly what a model-scoped weekly
quota becomes when its window resets — so without this pass a critical alert for Opus at
94% would sit in the tray, and its entry on disk, until the user next touched Opus. Session
and Weekly are always visible and never reach it. An **empty** quota list is data that has
not arrived rather than a payload holding no quotas, so it prunes nothing: `_quotas` is `[]`
until the first load, and pruning there would drop every entry and withdraw nothing real.

`HYSTERESIS` is 2 points. Without it a quota sitting on the boundary re-posts on every poll; with it
the number has to come back down meaningfully before the level can fire again.

**Critical supersedes warning's banner.** A single refresh moving 60% → 95% fires both levels, which
is what "once per threshold" means and preserves the early ping on a gradual climb. But two banners
about one quota, one reading 78% and one 95%, is noise, so posting critical withdraws the warning's
*notification* while leaving its *fired entry* in place. One message per quota on screen, no ping
lost.

`post` and `withdraw` carry keys and rendered text, so `extension.js` translates a diff and decides
nothing. The text is composed inside `lib/notify.js` from the `lib/format.js` helpers, which means
`alertPlan` also takes the two locales the indicator already resolves (`_locale` for times,
`_percentLocale` for numbers) — the same pair `_render()` passes to every popup row.

## Settings

`schemas/org.gnome.shell.extensions.claude-quota.gschema.xml`:

| Key | Type | Default |
| --- | --- | --- |
| `notify-warning-enabled` | `b` | `true` |
| `notify-warning-percent` | `i`, range 1–100 | `75` |
| `notify-critical-enabled` | `b` | `true` |
| `notify-critical-percent` | `i`, range 1–100 | `90` |

`metadata.json` gains `settings-schema`, and `schemas/gschemas.compiled` is committed for the same
reason `locale/**/*.mo` is: the checkout is what a user installs, and there is no build step.

`enable()` passes `this.getSettings()` to the indicator as `_prefs`. The existing `_settings` is
`St.Settings` and keeps its name; a collision there would silently break the colour-scheme watch.

All four keys are watched, so lowering a threshold below the live percentage posts immediately and
disabling a level withdraws its notification. No cross-validation: warning above critical is a
coherent thing to ask for, and both levels simply fire.

## Wiring

`_source` is lazy and nulled on the source's `destroy`. `_alerts` maps alert key to live
`Notification`, and each notification's own `destroy` deletes its entry, so a dismissal never leaves
a dead handle. Warning posts at `Urgency.NORMAL`, critical at `Urgency.HIGH`, both with the extension
icon as `gicon` and `isTransient: false` so they persist in the tray. `activated` opens the quota
popup, which is the one useful thing to do about the news.

`_syncAlerts(now)` runs from `_applyResult`, `_adoptShared`, the cache load, every settings
change, and unconditionally from `_refresh` — every path on which the **plan** can change,
which is a larger set than the paths on which `_quotas` can. `now` is an input too, and
expiry derives from it, so a poll that ends early — data still fresh, a rate-limit block
armed, the request floor holding — is still a poll on which a window can have rolled over.
Without the `_refresh` call the popup row reads `-` while the tray goes on shouting a
percentage that stopped being true. It costs nothing on an ordinary poll: the plan comes
back empty and `_syncAlerts` only writes the cache when there is a diff to write.

`disable()` destroys the source, and with it every live notification. `fired` stays on disk, so
re-enabling is silent.

## Wording

Title: `format(_('{name} at {percent}'), …)` — *Session (5h) at 90 %*. Body: the existing
`captionLine()` — *1h 30m left · 14:30* — except where it returns `-`, which is a
placeholder holding a table column open and nonsense as a whole notification body, so a
quota with no reset time gets no body at all. One new msgid.

The TODO sketches *"Your session quota 'Claude' is at 90% (1h 30m left before reset)"*. Composing
that sentence is the mistake `lib/format.js:40` documents: the trailing word lives inside each plural
branch because French agrees it with whichever unit leads, so a duration cannot be concatenated with
a shared following word and still be translatable. Reusing `captionLine` also means the notification
and the popup say the same thing about the same quota, which is worth more than matching the TODO's
phrasing literally.

## Persistence

`lib/cache.js` goes to version 2, carrying `fired` alongside `limits` and `fetchedAt`. A version-1
file is accepted as legacy with `fired: {}` rather than rejected, so no cached first paint is lost on
upgrade; version 3 and anything malformed are still rejected. Each `fired` entry is validated as well
as the container, and one that is not an object carrying a string `window` is dropped: the cache load
runs from `_init` with nothing catching a throw, so a single malformed entry would otherwise stop the
extension enabling at all.

The startup path is then correct by construction: the cache load calls `alertPlan`, which finds a
fired entry whose window still matches and posts nothing. A quota already acknowledged does not ping
again at every login.

## Testing

Unit tests carry the substance, because the substance is a pure function.

`test/notify.test.js` drives `alertPlan` with fabricated clocks: one case per row of the table, plus
both levels crossed in a single jump with the warning superseded; a window roll that both re-arms and
withdraws; a drop to `threshold - 1` leaving the notification up and un-rearmed; a drop past the
hysteresis withdrawing it; a disabled level withdrawing and dropping its entry; and the restart case
— replaying a `fired` state whose window still matches must yield an empty `post`, which answers "does
it re-ping every login" as a test rather than as a logout.

`test/cache.test.js` gains version-2 round-trip, version-1 accepted as legacy, malformed rejected.
`test/model.test.js` gains `key`, including two `weekly_scoped` limits with different models proving
the keys do not collide.

One new msgid means `npm run i18n`, the French translation, and `npm run i18n:check`.

**e2e, new `notify` group, assertions only.** A banner is a shell overlay and the harness's tile
frames the indicator, so there is nothing honest to screenshot. Scenarios set `i._quotas` as the
existing ones do, call `i._syncAlerts()`, and assert over the live source through `Eval`: notification
count, title, urgency. Expected wording is resolved from the catalog rather than hardcoded English,
per `a6389b9`. Threshold changes are exercised by writing through `i._prefs` in the nested session,
which both posts immediately and proves the settings path is connected. Every assertion gets its
inverted control run, which the harness demands on every run anyway.

## What this design does not claim

The nested shell spends no requests and every scenario is fabricated, so e2e proves the wiring, not
the endpoint. `HIGH` urgency appearing over a fullscreen window is the shell's behaviour, evidenced
by its source above and not by a test of ours. And the withdrawal path depends on a `Source` that
self-destructs when emptied — the one shell behaviour here most likely to change under us, so the
e2e group asserts the source is alive before it asserts anything about its notifications.
