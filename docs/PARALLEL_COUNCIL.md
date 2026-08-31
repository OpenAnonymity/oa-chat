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

Parallel is selected explicitly and the latest Chat/Parallel composer choice is
remembered across new chats and newly opened browser tabs/windows. If the user
opens a new view while Parallel is selected, its empty composer starts in
Parallel with the remembered lane models. Switching back to Chat updates that
preference, so later views start in Chat. Merely opening the view never spends
tickets; requests begin only after the user submits a prompt. The preference
uses a versioned setting and is written only by an explicit mode choice, so an
obsolete legacy value or a model change in another tab cannot silently switch
future views into Parallel.

Selecting Parallel keeps the normal transcript width while the user chooses
models. When a turn with multiple models is submitted, the transcript expands
to the same `66rem` maximum used by the manual wide-view control before the
prompt and response lanes appear. This avoids a premature layout jump while
still reserving enough space for two responses. The session remains wide after
the turn so its Parallel transcript stays stable; the existing width control
can collapse it after returning to a single-model layout.

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

For local development only, a lane may instead carry the distinct
`local-loopback-bypass` proof when both the browser and configured oa-org hosts
are exact loopback addresses. That status is never treated as verifier approval,
cannot be shared, does not register the lane with production verifier state, and
becomes unusable outside the loopback environment.

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
