# Inference reliability review — 2026-09-21

Reviewed the local `oa-commercial` checkout at `82965ee`, using its pinned
`oa-chat` revision `a38e534`. The user's reported symptom is an indefinite
“Waiting for response” after “Response stream created,” especially with many
pictures or a long conversation. This is a source review with synthetic failure
reproductions, not a diagnosis of a captured production incident or a deployment
certification. The findings below describe the original revision; the local
implementation now addresses them as documented in [Inference reliability](INFERENCE_RELIABILITY.md).
Line references in this historical review refer to the original revision.

## Findings, in priority order

### 1. P1: Inference has no connection or stream-idle deadline

`chat/api.js:1402–1411` explicitly sets `timeoutMs: 0`.
`chat/services/inference/sseStream.js:19–21` awaits `reader.read()` without a
deadline. There is no independent request watchdog higher in the ordinary chat
path. A provider or relay that leaves the response open without producing more
bytes can keep the send promise pending indefinitely. Retrying does not help
while that promise remains pending.

`chat/api.js:925–930` sends processing comments only to the console. The UI gets
neither heartbeat timestamps nor a distinction between waiting for the first
token and waiting on a silent connection. `networkLogRenderer.js:291–293` labels
any successful HTTP response “Response stream created”; this is not evidence
that inference is progressing.

Reproduction: emit a processing comment and keep the readable stream open.
The real API remains pending during the bounded observation, with its fetch
configuration confirmed as zero timeout. Inspection establishes that no later
app timer will turn that silence into an error; the test does not wait forever.

Remedy: separate connection, first-output and idle deadlines; record last
transport activity separately from last model output. Preserve partial output
on timeout and offer an explicit retry. Use honest states such as “Provider
connected; waiting for first output,” “No data received for N seconds,” and
“Connection timed out; progress unknown.” Silence alone cannot identify whether
the user's internet or the provider is responsible. Heartbeats must not count
as model output or allow endless waiting with no actionable status.

### 2. P1: Empty or prematurely ended streams are accepted as success

`sseStream.js:21` accepts EOF unconditionally; `api.js:1431–1433` immediately
finalizes. No validation requires a provider terminal event, finish reason, or
usable output. `api.js:940–945` also logs malformed JSON and silently discards
it, allowing a protocol failure to end as an apparently successful empty answer.

Reproductions through the actual `OpenRouterAPI`: a partial text delta followed
by EOF resolves with `finishReason: null`; an empty HTTP 200 also resolves;
malformed JSON followed by EOF does the same. These do not enter the existing
interrupted-response/error path. `app.js:8023–8060` instead saves the result and
announces “Response complete.” The empty path also leaves the message object's
`streamingPending` flag true because only output callbacks clear it.

Remedy: track protocol completion explicitly, distinguish empty output from
successful completion, and propagate malformed/truncated streams as errors.
Clear pending flags on every terminal path and preserve any received content.
Allow valid protocol variants deliberately rather than treating arbitrary EOF
as completion. Actual socket errors already reject; this finding concerns
clean EOF without a semantic completion event and silently discarded events.

### 3. P2: Long and image-heavy conversations have no aggregate input guard

`chat/services/fileUtils.js:197` limits each file to 10 MB, while
`chat/app.js:11066–11084` accepts an unrestricted number of valid files.
`chat/domain/messageContent.js:63–125` rebuilds every historical user message
with all of its attachments. The two-image cap at line 58 applies to previously
generated assistant images, not user uploads. There is no model-context or
total-request-size validation before the inference POST.

Reproduction: a follow-up with no new attachment includes all 20 synthetic user
images from the conversation. This replay is expected for conversational image
context, but its unbounded size is a deployment risk. Large requests can exceed
provider context/payload limits or create substantial browser memory and upload
work. The same request body is serialized, parsed, and serialized again in
`api.js:1309–1312` and `api.js:132–137`. The specific threshold and whether this
caused the user's incident remain unverified.

Remedy: validate aggregate bytes, image count and estimated model context before
spending/requesting access; show a useful explanation when limits are exceeded.
Provide an explicit way to start a shorter chat or remove older attachments.
Avoid silently dropping conversational context.

### 4. P2: The outer retry loop retries permanent request failures

`chat/app.js:7811–7821` excludes only 401/402 and a few message strings from its
generic retry rule. Normal 400, 403, 404, 413 and 422 failures pass it. The lower
fetch helper correctly avoids retrying those statuses, but the outer send loop
retries the entire inference request anyway (`app.js:8132–8142`). Oversized or
invalid input can therefore be uploaded three times unchanged before the error
is shown. Transient failures can multiply the lower three attempts by the
outer three attempts, producing up to nine HTTP attempts without access refresh.

Reproduction: evaluate the exact predicate extracted from the source against
those five permanent HTTP statuses; all return true. No live requests needed.

Remedy: one explicit retry policy across both layers; reject permanent failures
immediately, cap total attempts and elapsed time, and expose retry progress.

### 5. P2: Retried responses leak proxy busy state

`chat/services/fetchRetry.js:178–189` starts another attempt without consuming or
canceling the prior response body. `networkProxy.js:586–628` keeps requests
active until their tracked body finishes or is canceled. Unread bodies can stay
backpressured, preventing cleanup even when the underlying HTTP body is small
and has already been delivered.

Reproduction: two 503 responses containing `{}` followed by a consumed 200
response leave `activeRequestCount === 2`. Canceling those abandoned bodies
returns it to zero. `networkProxy.js:437–438` then explains the user impact:
disabling the proxy is blocked while requests appear active. TLS verification
is similarly guarded. This can require a reload after an otherwise successful
retry sequence.

Remedy: cancel each discarded response body before retrying, with cleanup that
cannot indefinitely delay cancellation/recovery. Direct cancellation, source
errors, and normal EOF all cleaned up correctly in Node 24 during this review;
the confirmed finding is abandoned retry bodies, not all stream cancellations.

## Validation and limits

- `node --test test/*.test.js` from `oa-commercial`: **439 passed**.
- Existing `test/zkapi/streaming.test.cjs`: **14 passed** with the model-pricing
  module initialized using a synthetic local fixture before the suite. The
  unmodified standalone invocation had 8 passes and 6 failures because that
  dependency attempted network access before reaching the stream assertions.
  The fixture run validates parser behavior, not live pricing availability.
- [Reproduction script](INFERENCE_RELIABILITY_REPRO.mjs): exercises the checked-in
  parser, input preparation, retry predicate and proxy tracker with synthetic
  data and no provider traffic. The original defect assertions have now been converted to regression tests
  expecting rejection/cleanup. The script runs that suite without live traffic.
- No live provider requests, real credentials, billing changes, production
  deployment, browser stress test, or end-to-end visual test was performed.
- This focused review does not audit every org/station/billing path. Fixes must
  ship through the commercial app's pinned public submodule; changing another
  standalone `oa-chat` checkout alone does not change this deployment.

The strongest source-level explanation for the reported endless waiting is
finding 1. Findings 2–5 are additional confirmed handling gaps or input risks;
production evidence is needed to determine which triggered a particular hang.
