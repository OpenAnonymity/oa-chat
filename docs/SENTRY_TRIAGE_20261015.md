# Sentry triage — October 15, 2026

## Scope and deployed versions

Reviewed all eight unresolved OA Chat groups in the 14-day Sentry feed through
Chrome. Read existing investigation evidence and mapped saved release bundles.
No issue statuses, Sentry settings, accounts or live services were changed.

Public build manifests checked on October 15:

- Production host `chat.openanonymity.ai`: commercial
  `d3a6ede2ac55f4c0f8592fab355871e4e1f196b1`, client
  `e6f5530057c5451dd26544a59cb208bba7bb6e48`; built October 14, 17:54 PDT.
- Staging host `staging.openanonymity.ai`: commercial
  `32806e2d47163bcc70f0c88383b1899cc9a54670`, client
  `54f6b1bf6d2d6828a8015433171d7e52e51d3d3f`.

The original isolated investigation branch starts at the production client revision.
That original branch excludes the request-timing experiment. The historical staging
handoff described below preserves staging's experiment and must never be promoted
to production. The later production candidate selectively applies the repairs to
the production base, excluding the experiment. No deployment was made by the
original investigation.

## Runtime groups

### OA-CHAT-2: several failures share a group

<https://fpl-pbc.sentry.io/issues/7789033141/>

The distribution showed 2,514 staging and 103 production events. Explicitly
selecting latest production still showed event `b168dde2`, timestamp
2026-10-14T18:58:07.263Z (October 14, 11:58 PDT), release `48f1c048bd9f`.
This predates the current production build. An unresolved group is not proof
of recurrence in the current release. No newer production event was displayed.

Earlier saved evidence maps a different stack in this group to RightPanel
automatically disabling the relay after a failure while requests remain active.
The deployed client now leaves the preference untouched in handleProxyChange;
the active-request guard and explicit fallback policy remain. The deployed
vendor also includes session/timer cleanup repairs. See RELAY_LIFECYCLE.md.

The latest production stack is separate: saved `chunk-JP2YMPPC.js` columns
591840, 587100 and 778963 identify the version read in TLSSecurityModal.render,
modal.open, and the Security Details button. The vendor's `version` getter
executes native `_get_version`, string decoding, free and JSON parsing. Optional
chaining does not protect against that getter throwing. The exact historic
native failure is not available in the sanitized event.

A new regression executes the real vendored get_version function with a failing
native call and the actual modal renderer. It fails on the deployed source.
The local repair catches only the optional version read and displays Unknown;
the connection information and close controls still render. A subsequent render
can show the version after recovery. This fixes the display failure, not the
underlying native runtime or relay. Absent/unloaded libraries remain supported.

### OA-CHAT-3: phone panel handoff already repaired in deployed source

<https://fpl-pbc.sentry.io/issues/7790842519/>

Two production events were observed, last seen two days before this review.
The saved bundle's columns 695847 and 695212 map to updatePanelVisibility and
toggle; app bundle column 718285 maps to the toolbar button. RightPanel called
hideSidebar through a facade that did not expose it. The deployed client exposes
hideSidebar in COMPONENT_APP_KEYS. The actual-facade twenty-handoff regression
passes. Real iPhone/Safari acceptance is not established by that fixture.

## Handled requests and sync

These categories are intentionally lossy and deduplicated per page. They do
not establish user counts, request failure rates, or ultimate turn failure.

| Issue | Observed events | Interpretation and next step |
| --- | --- | --- |
| [OA-CHAT-6](https://fpl-pbc.sentry.io/issues/7793076972/) | 2 production, 1 staging | HTTP 401 at the inference access boundary. This is access/key acquisition, not evidence of an expired account login. Ticket redemption can also yield 401; inspect safe failure code/phase during controlled reproduction before changing recovery. |
| [OA-CHAT-5](https://fpl-pbc.sentry.io/issues/7792800320/) | 1 staging, 1 production-desktop (`0.1.39`) | Provider-stream numeric code 504, distinct from HTTP 504. No evidence that generic replay or a client timeout increase repairs the provider. Keep existing retry/credit semantics. |
| [OA-CHAT-7](https://fpl-pbc.sentry.io/issues/7793713949/) | 2 staging | Completion status is a 4xx outside the exact-status allowlist. The code/message were discarded; the exact status/model/endpoint cannot be recovered from these events. |
| [OA-CHAT-4](https://fpl-pbc.sentry.io/issues/7792624017/) | 2 staging | Generic unexpected completion errors from earlier releases. Later provider categories cannot retrospectively classify them. |
| [OA-CHAT-8](https://fpl-pbc.sentry.io/issues/7795092841/) | 1 staging | Network reason, stage merge. The merge label covers the whole _doSync operation, including pull and push, so it does not prove a merge-algorithm failure or data loss. Existing code catches it, returns success:false and notifies sync_error. |
| [OA-CHAT-1](https://fpl-pbc.sentry.io/issues/7788791825/) | 3 total | Synthetic sentry-setup-check stack; verification traffic rather than a product defect. |

No speculative changes to credentials, ticket redemption, provider retries or
sync data were made. The subsequent sync status repair is described below.
Existing request instrumentation and the staging-only
latency experiment are unchanged. Hosted geography remains visible in sampled
events; the separate admin-owned Sentry scrubbing follow-up in SENTRY.md still
requires verification and is not repaired by this patch.

## Follow-up: sync status failure handling

The requested repair pass reproduced an additional existing defect in both the
production baseline and inspected staging source: HTTP/network failures returned
false from hasRemoteChanges, causing syncIfNeeded to report up-to-date. A missing
or invalid last_sync field could even update lastSyncTime and lastSyncResult as
though the check succeeded. Status fetches also had no bounded body deadline.

The local repair gives unknown status its own null result and an unsuccessful
syncIfNeeded result. It retains the last confirmed sync time, surfaces sync_error,
and validates the server contract (null for no uploads, otherwise a nonnegative
safe integer timestamp). It uses the existing single-attempt, five-second
background request policy, covering headers and body. Old-generation results and
errors cannot overwrite replacement-account state. No upload, merge, encryption,
redemption or inference retry policy changed. This is not claimed as the cause
of OA-CHAT-8's historical merge-stage event.

Regressions reproduce network errors, HTTP rejection, missing/invalid timestamps,
valid empty and nonempty statuses, credential replacement, and a stalled body.
The four false-success cases fail on the previous implementation.

## Validation

- New native-version failure regression: fails before the patch, passes after.
- 77 focused tests pass bundled with esbuild and the repository runner's serial,
  shared-process settings: version rendering, modal opening/lifecycle, phone
  handoff, relay lifecycle, shared sessions, panel updates, sync status and
  credentials, startup sync, ticket consumption/invalidation, body deadlines and
  request diagnostics. The new status tests also pass directly under Node.
- The initial independent review approved the TLS patch and independently reran
  all six TLS version/opening/lifecycle tests.
- A fresh review of the combined TLS and sync repair found no actionable defects
  and independently passed 28 tests including credential and account isolation.
- This is a local patch; no public release, real-provider failure reproduction,
  real-device acceptance or Sentry resolution is claimed.

## Historical staging handoff

Prepared against staging client fe46720c and commercial 1b39b445. The staging
patch preserves the existing status diagnostic and all newer staging work. That
base contains the staging-only timing experiment: do not promote this resulting
branch or pin to production. The original isolated repair branch remains separate.

## Isolated production preparation

The production candidate starts at `e6f55300` and selectively applies the TLS and
sync repairs together with the UI and scoped diagnostic fixes. It contains no
request-timing experiment. Its SDK, payment configuration and backend routing
remain at the production baseline. The validation above describes the earlier
repair review; exact production-candidate validation is recorded separately.
Hosted Sentry scrubbing and real-device acceptance remain outstanding.
