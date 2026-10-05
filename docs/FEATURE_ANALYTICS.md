# Feature usage analytics

The commercial web app reports a fixed vocabulary of feature events through the
existing Fathom site. The standalone app and desktop compositions have no reporter
by default. `services/featureUsage.js` has no network or storage access; the
commercial startup explicitly installs the build-time loader's reporter.

## Count definitions

| Fathom event | Counted when |
| --- | --- |
| Memory enabled / disabled | The global Save memories setting changes and is persisted; loading saved settings does not count. |
| Memory panel opened | The panel successfully opens; an already-open panel does not count again. |
| Memory retrieval started | A retrieval operation begins after obtaining access. |
| Memory retrieval completed | Retrieval returns without throwing or being cancelled/disabled. Includes normal no-new-memory results; does not imply approval or attachment to a sent prompt. |
| Tab Tab started | The scrubber runs on an eligible, nonempty draft, from either the keyboard or button. |
| Tab Tab completed | A successful result still belongs to the same draft and chat. Includes no-change results; does not imply the draft was sent. |
| Parallel run started | First-stage fan-out begins after access is acquired. Counts once per turn, including a full-turn regeneration, not once per lane or internal retry. |
| Parallel run completed | Every first-stage lane returns a nonempty successful response and the turn is not cancelled. |
| Council review started | Synthesis begins after its access is acquired. |
| Council review completed | Synthesis returns a nonempty response without cancellation. Can follow partially successful first-stage responses. |

Council also generates the applicable Parallel events. Do not sum these as
independent people or conversations. Per-lane regeneration, automatic memory
extraction, backfill, import/export, and unlisted controls are not
instrumented. Counts are feature uses, not exact unique
users. A started/completed gap is not proof of failure: cancellation, navigation,
privacy settings, and blocked analytics can also cause it.

## Settings changes

`Settings changed` counts each explicit change of a covered setting once, after
its existing update succeeds. A second event classifies that same action:
`Settings: <setting> - away from default`, `back to default`, or (for theme and
reasoning effort) `between custom choices`. Do not sum the total event and its
breakdowns together. These are action counts, not a census of current settings,
unique people, or a first-ever customization/retention metric.

| Setting label | Built-in default |
| --- | --- |
| Memory saving | Off |
| Memory in replies | Off |
| Memory auto include | Off |
| Parallel mode | Off (Chat) |
| Council review | Off |
| Web search | On |
| Reasoning effort | Medium |
| Theme | System |

The baseline is the shipped built-in default, not a person's saved preference.
Leaving a default can happen repeatedly. Switching dark to light counts as
between custom choices; switching either to System counts as back to default.
For Parallel/Council, comparison uses the current conversation or pending new
chat's mode. Memory auto include also counts the explicit “Always include” choice.
Existing Memory enabled/disabled events overlap Memory saving changes.

Reloads, importing settings, switching conversations, cross-tab synchronization,
system theme changes, same-choice clicks, unsupported actions and failed writes
are not new setting changes. Council automatically enabling Parallel and Memory
saving disabling use-in-replies do not generate extra setting-change events.
Opening the Memory panel's implicit enable is excluded. Theme counts the applied
choice; its existing storage layer is best-effort, so this is not a durability
metric. Other settings (including model selections) are outside this scope.

In Fathom, trend `Settings changed` by date for overall change frequency, then
compare the per-setting direction rows to see which defaults people leave or
restore. Sum the direction rows for a setting to get its total changes. Fathom's
pageview-based conversion percentage is not a percentage of people who changed a
default. No new identifier, per-user history or initial-state survey is added.
These rows appear only after a release containing these hooks and a first event;
there is no historical backfill. Privacy blocking and the bounded startup queue
can undercount or make totals and breakdowns differ.

## Privacy and delivery

Only an allowlisted string code reaches the host, and only its fixed event name
reaches `fathom.trackEvent`. There are no additional event properties, values,
model names, prompts, responses, memory paths/contents, account IDs, conversation
IDs, keys, tickets, or credentials. Analytics errors cannot break a feature.

This is aggregate product analytics, not an anonymous transport protocol: Fathom
still receives normal network metadata and event timing alongside its existing
page/referrer/browser metadata. No account-to-key join is added. See the commercial
privacy page for the user-facing disclosure.

The existing exact hostname allowlist keeps production and staging in separate
Fathom sites; previews and localhost send nothing. Global Privacy Control and Do
Not Track disable both the loader and feature events, with another check before
each event. Up to 32 fixed codes may wait in memory for the script to load; script
failure clears them. There is no persistent queue, retry, unload handler, or
additional request endpoint. Blocked scripts and privacy choices mean undercounts.

After deployment, events appear in the existing Fathom Events section once they
are triggered. Historical feature use cannot be reconstructed. Local tests use a
fake tracker and never submit analytics. The deployment must include both the
updated oa-chat source and commercial adapter/loader; no server change is needed.


## Daily summary events (October 5 addition)

`Default changed` is an additional aggregate event emitted once for each covered
setting move away from its built-in default. It follows `Settings changed` and
precedes the per-setting direction event. Back-to-default and between-custom
moves do not emit it. Its daily unique completions deduplicate visitors across
all covered settings; never sum unique counts from individual settings.

`App active` is reserved for optional host integration. The commercial host
reports deliberate interaction with covered chat controls, or a successful
settings change, and coalesces activity per tab UTC day. Standalone compositions
still have no reporter and do not send it. It is not a page-load or account event.

Daily summary ratios use Settings changed uniques / App active uniques, Default
changed uniques / App active uniques, and Settings changed totals / its uniques.
Multi-day summaries sum daily uniques as visitor-days rather than claiming a
unique-person count over the range. These are observed activity estimates;
privacy choices, network/browser changes, older tabs and delivery failures can
bias them. The commercial report documents coverage and never joins identities.
