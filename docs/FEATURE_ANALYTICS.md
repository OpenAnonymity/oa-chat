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
extraction, backfill, import/export, composer toggles, and other buttons are not
instrumented in this first version. Counts are feature uses, not exact unique
users. A started/completed gap is not proof of failure: cancellation, navigation,
privacy settings, and blocked analytics can also cause it.

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
