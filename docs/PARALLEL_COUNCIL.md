# Parallel and Council Responses

Parallel and Council are browser-local response modes layered on the same genuine
ticket, station, verifier, and inference paths as ordinary Chat.

## Modes

- `Chat` is the default and sends one request to one selected model.
- `Parallel` is an explicit opt-in and sends the same prepared conversation to a
  primary and secondary model concurrently.
- `Council review` is optional within Parallel. After the first-stage requests
  settle, a separately selected synthesis model receives the canonical chat
  context plus the anonymous first-stage responses and writes one review.

Parallel is session-scoped. A new chat always starts in Chat mode unless the
user explicitly enables Parallel in that empty composer; remembered lane model
choices do not enable extra requests by themselves.

The persisted session uses `responseMode`, `councilConfig`, and lane-scoped
`councilAccess` entries for `primary`, `secondary`, and `synthesis`. Existing
sessions without these fields normalize to ordinary Chat.

`councilConfig.outputMode` is `parallel` for two first-stage answers and
`synthesis` when Council review is enabled. The earlier `council` output value
is accepted only as a legacy import and normalizes to `synthesis`.

## Access and ticket safety

Every OpenRouter lane obtains access through the same fail-closed verified
acquisition operation as ordinary Chat. The child key remains provisional until
the verifier returns explicit `verified`; pending, unverified, rejected,
malformed, timeout, and network-error results are never stored as lane access.

A lane key is reusable only for its recorded model when it is verified,
unexpired, and not associated with a banned station. Switching back to Chat may
restore the verified primary lane only. Secondary and synthesis keys never
become primary implicitly.

Before redemption, the controller checks that the wallet covers every lane that
needs fresh access. Issuance is still not transactional across independent
station/verifier calls: if one lane succeeds and a later lane fails, the earlier
bounded key and spent ticket cannot automatically be undone.

## Privacy boundaries

Memory retrieval runs once before fan-out. Both first-stage lanes receive the
same approved one-shot prompt, while synthesis receives canonical context and
the first-stage answers without injecting memory a second time.

Inference remains direct from the browser to the provider. oa-org, station,
and verifier never receive prompts or responses. Activity logs retain only
model/lane/status metadata; the logger sink redacts request content, response
content, credentials, and tickets.

Parallel/Council sharing includes transcript and mode configuration, but never
lane credentials or the ticket wallet.
