# Staging-only request timing experiment

This experiment is restricted to controlled staging test traffic. Its source,
configuration, database, service and oa-chat revision must NEVER be promoted to
production, even disabled. Do not merge main wholesale into prod while this
experiment is on main. The experiment-free UI baselines are commercial
`b0813bd0b17208014fffeb50d982a0658b424d62` and oa-chat
`4eaf6bc8e71af13591c9110d0e2449d307276993`. Select a separately reviewed candidate
without the experiment for any production release. The experiment branch is
`experiment/staging-request-timing-20261015` in all three repositories.

## Measurement contract

Each accepted Send or Regenerate starts a monotonic clock. Each Parallel model
and optional synthesis gets its own record from that shared start. Completion,
terminal failure and cancellation freeze that lane independently. Credit retries
remain one record. A turn rejected before resolving a catalog model has no record;
resolved but unsent models have outcome `not_sent`. Helper title/Memory requests
are not separate records. Unknown milestones remain null, never zero.

- `preparation_ms`: elapsed until first access acquisition, or provider dispatch
  when access is reused. Includes local scheduling and preparation.
- `access_ms`: duration spent acquiring access, accumulated across retries. For
  zkAPI this wraps the SDK call and can include verification and wallet waiting.
- `verification_ms`: explicit verification span or SDK verifying/ready progress;
  null when not exposed. It can overlap access; do not sum these durations.
- `provider_dispatch_ms`: elapsed until the first transport fetch invocation.
  Includes neither a claim of server receipt nor a server-side trace.
- `response_headers_ms`: elapsed until the transport's open callback.
- `first_reasoning_ms`: elapsed until first nonempty reasoning callback (including
  a withheld-reasoning signal). Transport buffering can delay this callback.
- `first_answer_ms`: elapsed until first non-whitespace answer-text callback;
  this is the primary time-to-first-response measure. Image-only output has null.
- `first_visible_answer_ms`: optional conservative DOM acknowledgement after a
  text callback, only for the selected foreground chat with visible in-viewport
  content. NOT browser paint timing. It may remain null during a fade, offscreen
  rendering, or after switching back without another chunk.
- `elapsed_ms`: elapsed until that lane's inference settles. This does not include
  all later persistence/UI bookkeeping. All values round to 10ms and cap at 1h.

Model is a public catalog ID, release is the full commercial Git SHA, platform is
web, mode is ticket/zkapi, key is new/reused/unknown. SDK-managed acquisition is
unknown unless explicitly observed. No prompt, answer, reasoning, account ID,
chat ID, request ID, credential, URL or absolute client timestamp is in a record.
The collector allowlists model IDs. Its receipt timestamp is stored only for
rate limiting and expiry, not exposed in results. This is NOT anonymous or
unlinkable telemetry: direct collection exposes transport metadata to staging.
Existing Sentry diagnostics are unchanged.

## Enable only after the separate collector is ready

1. Deploy the isolated oa-org `experiments/request_timing` service on org-staging
   following its README. It is not imported by the ordinary org app. Production
   org has no new route, service, migration or database.
2. Set `OA_STAGING_REQUEST_TIMING=true` only on Vercel `oa-staging-main`, retaining
   exact `STAGING_FRONTEND_ORIGIN=https://staging.openanonymity.ai` and
   `OA_STAGING_ORG_ORIGIN=https://org-staging.openanonymity.ai`. The build derives
   the release from `VERCEL_GIT_COMMIT_SHA`. Never put either test/admin token in
   a Vercel variable or client bundle.
3. In a controlled test tab on staging, set the session opt-in with the separate
   capture token (the prompt avoids placing it in console history), then reload:

   ```js
   sessionStorage.setItem('oa-staging-request-timing', JSON.stringify({
     token: prompt('Staging timing capture token'), expiresAt: Date.now() + 15*60*1000
   })); location.reload();
   ```

   Stop by removing that sessionStorage key and reloading. It expires after 15
   minutes; other tabs are not automatically enabled. GPC/DNT and desktop bridge
   contexts disable collection. Closing the tab removes the session setting.
4. Open `https://org-staging.openanonymity.ai/experiments/request-timing` and enter
   the distinct admin token. Results group by release/model/mode/key/lane/outcome.
   Each metric shows observed sample count and nearest-rank p50/p95. Compare
   completed requests separately from failures. CSV contains projected rows only.

The uploader sends after turn cleanup without awaiting it, omits cookies/referrer,
rejects redirects, aborts after 5 seconds, retries nothing, caps 100 rows per page
and eight pending sends. Failures cannot reject a chat reply. Telemetry can be
lost on tab close or expiry and is not a population-level production measurement.

## Release boundaries and validation

Default/off artifacts replace the recorder with inert stubs and exclude the
uploader. The enabled build requires exact staging destinations. Builds on prod
refs/PR bases and actual Vercel production-target builds reject this source even
with collection disabled. A main-CI production-*artifact test* may run with
collection off to verify exclusion; this does not authorize production promotion.
Documentation and source review remain mandatory because build guards cannot
prevent somebody copying files into a different release system.

`npm run check:release` checks client/commercial suites and default, ordinary
staging, enabled experimental staging, and production artifact exclusion. Org
has its own tests. Before live acceptance, compare traces for new/reused keys,
reasoning-first/answer-first replies, Parallel, retry/failure, Stop and hidden
chats. Inspect egress and confirm only opted-in test traffic arrives. Local
synthetic records establish wiring, not accuracy against live provider traffic.
Rollback: remove tester opt-in and staging build flag; stop the separate collector
and remove only its proxy location. Do not delete or alter the ordinary org DB.
