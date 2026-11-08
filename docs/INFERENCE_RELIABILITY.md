# Inference reliability

Implemented locally for the commercial app's pinned `oa-chat` checkout on
2026-09-21. This is not a production-incident diagnosis or a deployment record.
The [original review](INFERENCE_RELIABILITY_REVIEW.md) records the defects.

## User experience

Normal waiting and streaming remain unchanged. After 45 seconds with no
transport data, an accessible warning appears: “Taking longer than usual. No
data received for 45 seconds; still waiting for a response.” It clears when
data resumes or the request ends. Warnings belong to requests and sessions,
including individual council lanes, and do not leak into another open chat.
A processing heartbeat is transport activity, not proof of provider progress.

Client recovery deadlines in `chat/services/inference/reliability.js`:

| Condition | Deadline |
| --- | --- |
| No response headers | 2 minutes |
| No response data after opening | 3 minutes |
| No model output despite continued transport activity | 10 minutes |

These are OA recovery policies, not claims that the provider has stopped work.
Browser suspension may delay JavaScript timers. Silence cannot identify whether
the network, relay or provider is responsible. Output means content, reasoning
or image activity; heartbeat comments do not reset that clock.

A timed-out, malformed, empty or incomplete response fails visibly. Partial
content/reasoning/images are retained. A partial answer has a separate persisted
error notice and Retry response button. That notice is excluded from model
context. Pre-output errors also persist in the originating chat when another
chat is being viewed. Stop clears streaming state without manufacturing an error.

## Transport and request safeguards

- Race connection setup, stream reads and awaited callbacks against cancellation
  and deadlines, including transports that ignore AbortSignal.
- Cancel late responses and abandoned response bodies. Own the error-body reader
  so timeouts can release it. Do not await broken cancellation promises.
- Require a provider terminal event (`[DONE]`, explicit completion or finish
  reason) and usable answer/reasoning/image output. Reject malformed JSON,
  provider error/incomplete events and EOF without completion evidence.
- Preserve legitimate `finish_reason: length` behavior and the existing Continue
  action. Clean EOF after a finish reason is accepted; DONE need not carry one.
- The outer chat policy owns automatic inference retries; the transport uses one
  attempt. Permanent HTTP failures and started-stream failures do not auto-retry.
  Explicit Retry response uses the existing regeneration flow and may consume
  inference credit like any user-requested generation.
- One exception sits at the OpenRouter `/chat/completions` HTTP boundary
  (`fetchWithOpenRouterCreditRecovery`). Besides its existing 402 budget
  resends, an HTTP 401 resends the identical request (same credential, body
  and request-access lease) up to three times, after 1 s, 2 s and 4 s. No
  output exists yet, so nothing can duplicate. Stop cancels the wait. The
  final 401 is tagged `inferenceAuthRejected` and gets its own copy. 401s
  from access issuance, verifiers, wallets or accounts are not tagged and not
  resent. The budget is per stream call, so outer 5xx/network retries
  multiply it, but it stays bounded.
- A ticket key this tab has just received and verified can be refused (401)
  for roughly its first half-minute and then accepted unchanged. One capture
  showed this; the provider's internals are unknown.
  - **Which keys get a window.** Only keys whose verifier result is
    explicitly `verified`, enrolled in `acquireVerifiedAccess`. Each such key
    gets one absolute 60 s window (`keyReadiness.js`), measured on a
    monotonic clock from when the station returned it. Retries, Retry and
    concurrent calls never restart it.
  - **Inside the window,** the identical request is resent after 1, 2 and
    4 s, then every 5 s. Each resend must still fall before the window end
    and the key's expiry, and this is rechecked immediately before sending.
    The cap is 16 requests. A call that used the window never falls back to
    the short policy. A 2xx or 402 closes the window for later calls. Calls
    already in flight keep the deadline and expiry they snapshotted at their
    first send.
  - **Unchanged:** the key, headers, body, lease and transport. Nothing is
    redeemed, rotated or reported. On staging the one deliberate exception is
    zero data retention: every resend still passes the per-attempt
    `restrictFetchAttempt` check, so a ZDR switch turned on during a backoff
    narrows the resend to eligible endpoints or refuses it before anything is
    sent. A reduced output cap from an earlier 402 survives the resends, and
    billing adapters never rerun.
  - **Title.** For such a key, the automatic title starts only after this
    turn's request is accepted (stream open). Stop or a failed turn leaves no
    title job and no later billable title.
  - **Every other key** keeps the short policy: older, reloaded, restored,
    shared, trusted-station-fallback and private zkAPI keys. Android native
    streaming has no resends.
- Staging integration (2026-11-08): the two production commits above
  (`ca9a0797`, `721cd0ae`) were ported onto staging pin `d58dd6a5`, not merged
  as a production branch. Staging's short provider-retry policy
  (`runWithResend`, 429/5xx), rate-limit details on errors, the
  `provider_dispatch_ms` timing mark (marked once before the first send, so a
  recovered 401 wait counts toward that turn's measured time), ZDR enforcement,
  reduced output caps and ticket usage logging are unchanged. Readiness
  enrollment also sits after staging's `access_ms` timing span.
- Shared HTTP retries cancel discarded transient-error bodies so proxy busy state
  can return to zero.
- Local aggregate guard: 32 MiB request and 32 images across conversation history
  and new attachments. Initial sends validate before acquiring access; the API
  validates again before its request lease and checks final serialized size.
  Estimated text context uses roughly four characters per token when model
  metadata provides a context limit. This is not exact tokenization and does not
  estimate image/PDF token use. Provider limits may be stricter. Context is never
  silently dropped; the error suggests shortening the chat/removing attachments.

No new analytics, external status polling, identity data or prompt logging is
introduced. Health state remains local. These changes cover streaming chat,
including regeneration and council lanes; they do not impose universal deadlines
on every other application service or non-streaming provider call.

## Validation

`npm test` runs the core and native/zkAPI suites. Failure injection lives in
`test/zkapi/inference-reliability.test.cjs`; run it directly or via
`node docs/INFERENCE_RELIABILITY_REPRO.mjs`. It covers silent connections,
uncooperative abort/cancel, late headers, locked error-body cleanup, stalled
callbacks, empty/malformed/truncated streams, valid terminal variants, heartbeats,
Stop, aggregate limits and discarded retry bodies. Streaming fixtures use local
synthetic pricing rather than depending on live pricing availability.

Application ownership tests cover navigation during an error, per-session warning
visibility, clearing on activity and retaining partial failures. Template tests
cover error escaping and the retry affordance. Build and run the commercial
suites from the parent checkout before shipping the changed submodule revision.
No paid live inference or production deployment is part of these checks.

Verified locally: 837 core tests, 218 native/zkAPI tests, 439 commercial unit
tests and 13 commercial build tests passed (1,507 total). The production
commercial build succeeded. A browser fixture importing the real production
renderers/styles verified normal waiting without a warning, silence warning,
warning removal on resumed data, and partial-answer failure with Retry response.
This fixture is not a signed-in end-to-end provider test. Independent adversarial
review approved the final implementation after cleanup/error-persistence fixes.
