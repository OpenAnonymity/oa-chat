# Zero data retention (ZDR)

Staging feature, 2026-11-05. A switch at the top of the model picker restricts
every OpenRouter request to providers with a zero data retention policy.

## Behavior

- **Shield.** Each model with at least one eligible provider shows a green
  shield (`--color-status-success`), whether or not the switch is on. Hovering it
  reads "Supports zero data retention".
- **Switch on.** Models without an eligible provider stay listed but are dimmed,
  read "No zero data retention providers", cannot be clicked, and are skipped
  by the arrow keys and Enter. The composer model button shows the shield only
  while ZDR is actually enforced; a selected model without ZDR shows "· not ZDR".
- **Info tooltip** uses the existing `data-info-tooltip` component:
  "OA Chat is anonymous, but model providers may still log your prompts. Turn
  this on to send prompts to providers with zero data retention policies."
- **Setting.** Stored as chat setting `zeroDataRetention` (chatDB, not synced).
  Default off.

## Enforcement (`chat/services/zeroDataRetention.js`)

- **Eligible providers** come from OpenRouter's public list
  `GET https://openrouter.ai/api/v1/endpoints/zdr`, fetched at startup like the
  model catalog (proxy bypassed, public data), kept in memory only. An endpoint
  counts only when it states `safety_retention: false`. A missing or different
  value is treated as retention, so a format change hides models rather than
  admitting a retaining endpoint. The provider identifier is the endpoint `tag`
  before any `/` (for example `amazon-bedrock`), falling back to the display name.
- **Every request.** `OpenRouterAPI.prepareRequestBody` applies the restriction
  last, after product adapters (tickets and zkAPI), so no adapter can drop it.
  The body gets `provider: { zdr: true, data_collection: 'deny', only: [...] }`;
  an existing `only` list is narrowed, never widened, and fallback `models` are
  removed. `provider.zdr` alone is not enough: OpenRouter still admits "Safety
  Retention" endpoints when account or guardrail settings allow them, and there
  is no request field that excludes those; `only` does.
- **Fail closed.** With the switch on, a request whose model has no eligible
  provider, or that is prepared before the list loaded, throws
  `ZdrUnavailableError` before anything is sent.
- **Before tickets.** `app.sendMessage`, `regenerateResponse` and
  `regenerateCouncilLane` call `checkZeroDataRetentionForSend` before any ticket
  or key is used. It checks the primary model and, in Council mode, every member
  and the synthesis model. Only the `openrouter` and `zkapi` backends are
  checked; local and enclave backends never reach OpenRouter.
- **Chat titles.** Title generation sends the first message to
  `TITLE_SUMMARY_MODEL_ID` (Gemini Flash Lite, which has no strict-ZDR provider).
  With the switch on and no eligible provider for the title model,
  `generateSessionTitle` returns '' without acquiring access, so the local title
  is kept.

## Not covered (open decisions)

- **Web search** (`:online`) still sends the search query to OpenRouter's search
  provider, and **PDF parsing** (`file-parser` plugin, `mistral-ocr`) still sends
  the file to its parser. Their retention is separate from model ZDR.
- **Regenerate** checks the session model; when the last user message used a
  different model, only the request-layer check applies (after key acquisition).
- **IP address.** Without the relay, the provider sees the browser's IP for
  direct requests. The tooltip's "OA Chat is anonymous" refers to account
  identity.

## Verify on staging

The ZDR list format was not reachable from the build environment; parsing
follows the OpenRouter docs and is defensive. On staging, confirm that shields
appear, that a ZDR send succeeds and the network log shows the expected
`provider.only`, and that the key's tier guardrail does not reject the
restricted request.
