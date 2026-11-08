# Zero data retention (ZDR)

Staging feature, 2026-11-05. A switch at the top of the model picker restricts
every OpenRouter request to providers with a zero data retention policy.

## Behavior

- **Shield.** Each model with at least one eligible provider shows a green
  shield (`--color-status-success`), whether or not the switch is on. Hovering it
  reads "Supports zero data retention".
- **Switch on.** Models without an eligible provider stay listed but are dimmed,
  read "No zero data retention providers", cannot be clicked, and are skipped
  by the arrow keys and Enter. Shields appear only inside the model picker modal,
  never beside the model in the chat bar. A selected model without ZDR shows
  "· not ZDR" in the composer.
- **Info tooltip** uses the existing `data-info-tooltip` component:
  "OA Chat is anonymous, but model providers may still log your prompts. Turn
  this on to send prompts to providers with zero data retention policies."
- **Setting.** Stored as chat setting `zeroDataRetention` (chatDB, not synced).
  Default off for a new installation. The controller configures the preference
  before event handlers can send; preflight awaits restoration. Pending, failed,
  or malformed reads block requests instead of guessing off. A newer toggle
  supersedes a late read. Writes are serialized, and a failed save is reported
  while the chosen policy continues to apply in the current tab.

## Enforcement (`chat/services/zeroDataRetention.js`)

- **Eligible endpoints** come from OpenRouter's public list
  `GET https://openrouter.ai/api/v1/endpoints/zdr`, fetched at startup like the
  model catalog (proxy bypassed, public data), kept in memory only. Every listed
  endpoint for a given model/provider must explicitly state `safety_retention:
  false`; a retaining, missing, malformed, or explicitly non-ZDR row excludes
  that entire group, regardless of row order. Routes retain the full endpoint
  `tag` (for example `amazon-bedrock/us-east-1`), never strip regions/variants,
  and never guess from display names. Unknown models have no eligible route.
  See [OpenRouter routing semantics](https://openrouter.ai/docs/guides/routing/provider-selection#base-slug-matching).
- **Every request.** `OpenRouterAPI.prepareRequestBody` applies the restriction
  last, after product adapters (tickets and zkAPI), so no adapter can drop it.
  The body gets `provider: { zdr: true, data_collection: 'deny', only: [...] }`;
  an existing `only` list is narrowed, never widened, and fallback `models` are
  removed. `provider.zdr` alone is not enough: OpenRouter still admits "Safety
  Retention" endpoints when account or guardrail settings allow them, and there
  is no request field that independently excludes those; the filtered endpoint
  allowlist restricts routing according to the published policies. Existing
  provider allowlists are intersected with the eligible endpoint slugs; an empty
  intersection is refused. Search and PDF plugins remain unchanged.
- **Fail closed.** With the switch on, a request whose model has no eligible
  provider, or that is prepared before the list loaded, throws
  `ZdrUnavailableError` before anything is sent. Synchronous body preparation
  also refuses while the saved preference is unresolved or failed.
- **Before access.** The shared API checks the restored preference and model
  before calling its request-access adapter. The app checks ordinary sends and
  regenerations before session access acquisition. Parallel checks both members;
  Council also checks synthesis. New chats use their pending selections or saved
  Parallel defaults. Checks include CouncilController's resolved lanes, including
  an automatically selected secondary, and its resolved synthesis model.
  The actual created group is checked again before memory or
  inference spending, in case it changed while startup was pending. A refusal
  names the unsupported model and keeps the draft. Quick Ask checks its chosen
  model before runtime preparation or access acquisition.
- **One switch for all lanes.** The same modal picker serves primary, secondary,
  and synthesis selections; its shield/disabled-row behavior applies to each.
  An already selected incompatible model is not silently replaced or dropped.
  Sending the group is refused until that model is replaced or ZDR is turned off.
- **Send/Stop ownership.** A restored off preference bypasses async preflight.
  Pending privacy checks run inside the send's cleanup scope, expose the pending
  state immediately, and check cancellation before starting captured work. A
  failed check or Stop releases only that submission's reservation.
- **Chat titles.** Title generation sends the first message to
  `TITLE_SUMMARY_MODEL_ID` (Gemini Flash Lite, which has no strict-ZDR provider).
  With the switch on and no eligible provider for the title model,
  `generateSessionTitle` returns '' without acquiring access, so the local title
  is kept.

## Scope and remaining limits

- **Web search** (`:online`) still sends the search query to OpenRouter's search
  provider, and **PDF parsing** (`file-parser` plugin, `mistral-ocr`) still sends
  the file to its parser. Their retention is separate from model ZDR.
  User clarification, 2026-11-05: search may remain available with a ZDR base
  model; do not add the proposed switch relabeling or search-retention notices.
- **Regenerate** checks the saved user-message model before memory/import/access
  changes. Full Council checks its actual executing group; a single Parallel lane
  checks its resolved historical model, not unrelated current selections.
- **Retries and relay setup.** The current preference is reapplied on each credit,
  affordability and JSON retry, on every inference HTTP 401 same-request resend
  (the short 1/2/4 s policy and a fresh key's 60 s readiness window; see
  [inference reliability](INFERENCE_RELIABILITY.md)), after relay initialization,
  and before direct fallback. Reduced token caps remain intact and billing adapters run only once.
  A privacy refusal does not mark the relay failed or initiate a fallback.
- **Failed saves.** The picker facade now forwards the approved error toast to
  the application; the current tab's choice remains enforced.
- **IP address.** Without the relay, the provider sees the browser's IP for
  direct requests. The tooltip's "OA Chat is anonymous" refers to account
  identity.

- **Availability.** Restricting endpoints reduces the fallback pool and may
  change price, latency, or availability. A model with no eligible route is
  refused. The list is an in-memory snapshot from OpenRouter, not an independent
  audit of provider retention. Server-side `zdr` still applies, but account-level
  strict ZDR settings remain useful protection against upstream policy changes.

- **Time to first token.** Once the saved setting and catalog are loaded, all
  privacy preflights use memory; checking multiple lanes adds no network round
  trips. A first send can wait for preference/catalog startup. The catalog uses
  the existing retry/timeout policy, so an unavailable list can delay refusal.
  Endpoint restrictions may change upstream latency because the router has fewer
  candidates. No live TTFT comparison has been measured. No timing experiment
  changes or production promotion are part of this work. Existing staging timing
  starts after the initial privacy preflight, so its duration excludes that
  particular startup wait; user-visible send-to-first-token can include it.

## Verification

The public catalog was reachable during review and its format parsed successfully.
Local regression tests cover mixed and conflicting endpoint policies, full slugs,
allowlist intersection, saved on/off preferences, delayed/failed reads, late restore
races, serialized writes, failed saves, pre-access refusal, search/PDF preservation,
and picker-only shields. Related inference/composition/recovery tests also run.
Final validation on 2026-11-05:

- Installed exact locked dependencies with `npm ci --ignore-scripts`; installed
  lock metadata matches `package-lock.json` (no mismatches). `npm test` applies
  the repository's SDK patches before running. Nanomem uses its pinned commit.
- Full `npm test` passes: 2,153 core tests plus 2,699 payment tests, zero failures;
  12 payment tests are skipped by their existing conditions (4,852 passed total).
- All 137 existing runtime ownership tests pass unchanged, with nine additional
  privacy/ownership regressions passing (146 in the focused controller run).
- The prior five failures came from the initial ZDR patch's unconditional Send
  await, not from baseline dependency installation; the known-off fast path and
  guarded cleanup fix them. Stop/duplicate ownership, new/existing automatic
  Parallel lanes, synthesis, and Quick Ask pre-access checks have coverage.
- Independent final review approved. The combined patch applies cleanly to
  base `8aa6e2d9`. A committed staging candidate is being prepared locally;
  no push or deployment has been performed.

Live acceptance by the tier guardrail and zkAPI forwarding remain unverified;
no paid prompt or deployment is part of this local change. Before staging release,
verify the final request restrictions and server acceptance on those paths.

Source artifact: `9c4cd7de` on base `8aa6e2d9`. The claimed `cc7008cf` follow-up
was not in the supplied bundle or patch. These are independent local fixes,
including the user's later UI and model-only ZDR scope choices.
