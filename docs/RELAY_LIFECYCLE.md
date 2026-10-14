# Relay lifecycle repairs — 2026-10-14

Based on staged client `a7ecdc6d397f435b890d5e61840802ae9787689e`.
These changes are local until a commercial release pins and deploys them.

## Failures and repairs

- The vendored libcurl.js 0.7.1 `CurlSession.close_now` freed its native multi
  handle without stopping its polling interval. Later ticks accessed freed or
  null WASM state. Shutdown now stops polling immediately and guards queued
  ticks. Closing is idempotent and refuses new requests.
- Shutdown removed requests from the same array it iterated, skipping handles.
  It now iterates a snapshot. Removal checks ownership before native cleanup,
  so queued removals cannot free a request twice. Late cancellation during or
  after close leaves cleanup with the close operation.
- Chrome in the release run ignores the newer `TransformStream` transformer
  `cancel` callback (Node 24 supports it; `abort` is not a transformer callback).
  Actual deployed-code browser fixtures showed error/cancel leaving two requests
  active instead of one. `pipeTo` settlement now provides a compatibility fallback,
  while `flush` and `cancel` retain prompt release on supported runtimes, including
  slow source cleanup. One guard prevents double decrement; cancellation still
  propagates upstream. See the [Streams Standard](https://streams.spec.whatwg.org/#ts-constructor).
- `RightPanel` failure notifications no longer call `updateSettings` to turn
  the relay off. That could reject while another response was active and also
  persisted a privacy preference change. Failure presentation leaves the user's
  relay setting intact; existing explicit fallback consent is unchanged.
- The restricted component facade now includes `hideSidebar`, required by the
  real phone rail handoff. Narrow desktop windows intentionally allow two rails:
  phone mode also requires touch, coarse pointer and a phone-size screen, and
  excludes Electron. Width-only Chrome testing is not phone coverage.

The build adds a content hash to the lazy libcurl script URL. Because this
vendor asset is copied separately from bundled application code, an app bundle
hash alone did not invalidate its browser cache. Recheck this patch and its
tests when updating libcurl; do not overwrite the local lifecycle repair.

## Verification and limits

`libcurlSessionLifecycle.test.js` executes the actual vendored class with
native-allocation guards. The original four regression cases all fail against
the deployed vendor source and pass after the repair. Coverage includes timer
shutdown, queued ticks/removals, all-handle cleanup, repeated close and late
cancellation. Proxy tests exercise complete/error/cancel bodies while another
request remains active. Phone tests use the production component facade and
twenty handoffs; real Safari/Home Screen remains a release gate.

Full test and browser evidence is recorded with the release repair handoff.
These automated results are not a completed live robustness protocol.

The live Gemini failure at 17:51:35 UTC entered through a provider SSE error
event. Fixing relay cleanup does not prove that upstream failure is repaired.
No automatic inference or ticket-redemption replay has been introduced. The
original 520 also remains unexplained. Keep live success/recovery and fault
injection evidence separate from root-cause evidence.

## Required follow-up on the deployed candidate

Repeat protocol R07 with failure during another active reply, Stop before
headers, cancelled/erroring bodies and a following successful request. Add a
30-cycle relay close/reinitialize soak; require no WASM exceptions, orphaned
timers, retained active counts, automatic relay-off preference or silent direct
fallback. Check both the initial and cached-page load use the new vendor hash.

For R08, use actual phone conditions and the component facade, then real iPhone
Safari/Home Screen. Record narrow desktop behavior separately. R09 still needs
new-send/edit/Retry and multi-lane failure/recovery coverage; a third successful
attempt must not hide the preceding failures. R10 must inspect hosted privacy
metadata as well as the outbound SDK envelope; see [Sentry](SENTRY.md).
