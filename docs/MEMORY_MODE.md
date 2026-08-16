# Memory Mode

This document describes the root `oa-chat` memory-mode integration that reuses
`nanomem` as a git submodule while keeping the app-side code thin.

## Scope

- Root `oa-chat` now has an independent Memory book toggle beside the
  Chat/Parallel response-mode slider.
- Memory mode only brings in the `augment_query` flow; it can be combined with
  either single-model Chat or Parallel/Council turns.
- Before a send or regeneration can redeem either key, the client checks the
  combined fresh-ticket budget for Memory and the selected model response(s).
  If the wallet is short, neither path spends a ticket and an on-screen alert
  explains the Memory and model portions of the requirement.
- The global Memory feature switch can disable Memory across live retrieval,
  post-turn extraction, editor/backfill/import/export entry points, and key
  redemption.
- Root `oa-chat` now also exposes the memory filesystem panel shell from
  `memory-chat` via `Cmd/Ctrl+Shift+M`.
- The root panel is storage-first, with one backfill path:
  - file browsing/editing is supported
  - OMF export/import is supported
  - `Backfill` processes local `oa-chat` sessions into memory through
    `nanomem.importData(...)`
- The actual memory data continues to live in IndexedDB (`oa-memory-fs`) through
  `nanomem`'s browser backend.

## Architecture

```
chat/app.js
  -> chat/services/memoryBridge.js
  -> chat/nanomem/browser.js
  -> nanomem/src/browser.js
```

Important boundaries:

- `chat/app.js` never imports `nanomem/src/...` directly.
- The app only talks to `nanomem` through `chat/services/memoryBridge.js`.
- `memoryBridge.js` only imports `createMemoryBank` from the stable browser
  entrypoint lazily inside active retrieval, extraction, and import operations.
  It must not statically import `chat/nanomem/browser.js`, because the global
  Memory feature switch is expected to prevent nanomem module evaluation when
  Memory is off.
- Prompt construction, tool definitions, and final `[[user_data]]` stripping
  live behind the `nanomem` browser seam, not in the chat controller.
- `augment_query` is now a real executed tool inside `nanomem`, not just a
  terminal structured-output marker from the outer retrieval loop.
- The outer retrieval loop does not draft the final prompt. It only calls
  `augment_query(user_query, memory_files)` with the original query and the
  minimal relevant file paths. A dedicated prompt-crafter call inside
  `nanomem` writes the final minimized review prompt directly.
- Local-chat backfill also stays behind that seam:
  - the panel normalizes existing `oa-chat` sessions into `{ title, messages, updatedAt }`
  - `nanomem.importData(...)` owns format normalization + `ingest(...)` orchestration
  - the app only tracks which sessions were already backfilled

## Submodule Delivery

- `nanomem` is a tracked git submodule at repo root.
- `chat/nanomem` is a tracked symlink to `../nanomem` so dev-server imports
  resolve from the browser-visible `chat/` root.
- Dev now hard-requires that submodule too:
  - `npm run dev` runs the same `git submodule update --init nanomem` prep
    before starting the static server
  - if `nanomem` is missing, dev should fail before serving instead of leaving
    the browser to hit `GET /nanomem/browser.js 404`
- Production builds treat `nanomem` as a hard requirement:
  - `npm run build` runs `git submodule update --init nanomem`
  - `scripts/build.mjs` fails early with a clear error if the submodule is still
    missing
  - the build copies the submodule into `dist/nanomem` and removes its `.git`

## Browser-Safe Entry

`nanomem/browser.js` now points to `nanomem/src/browser.js`, not `src/index.js`.

Reason:

- `src/index.js` still exposes the filesystem backend, which pulls `node:*`
  imports into the bundle graph.
- The browser entry mirrors `createMemoryBank()` but only allows `ram` and
  `indexeddb` storage. This keeps the root chat bundle browser-safe.

If `nanomem` changes internal layout later, the browser entrypoint is the only
contract the app should rely on.

## Confidential Retrieval Path

- Root `oa-chat` currently uses Tinfoil through the plain OpenAI-compatible HTTPS
  client, not the Tinfoil SDK path.
- Concretely, `chat/services/memoryBridge.js` forces the memory bank config to:
  - `baseUrl: https://inference.tinfoil.sh/v1`
  - `provider: 'openai'`
- `nanomem` still supports the SDK-backed Tinfoil transport for other callers,
  but the root app is intentionally not using it right now.
- The bridge requests confidential keys with `CONFIDENTIAL_KEY_TICKETS` (currently
  1) and passes the active memory abort signal through the redemption request.
- The key is cached on the session as `memoryKey` / `memoryKeyInfo`.
- The cache uses the same 60-second grace-window pattern as scrubber-key
  expiry checks.
- On retrieval auth failures (`401` / `403`), the bridge invalidates the cached
  memory key on the session so the next attempt can redeem a fresh one.

This keeps memory-reading traffic on the confidential path instead of the
regular frontier-model key path.

## Request Flow

When memory mode is enabled and the outgoing user message has text:

1. The app creates a local-only assistant status message with an agent trace.
2. `nanomem` runs the `augment_query` retrieval loop against local memory.
   - The memory agent receives recent current-session conversation text, not just
     the latest user turn.
   - The source is all non-local-only messages in the current session.
   - `nanomem` trims that transcript before sending it to the retrieval and prompt-crafter
     passes, but it now trims by conversation turns rather than a raw tail slice.
   - Long assistant replies are clipped first so earlier user turns are less likely to
     disappear from the retrieval context.
   - After a memory prompt is approved or auto-included, root stores the delivered
     `[[user_data]]` context on the session in `session.memoryRetrievedContext`.
     Later memory-mode turns call `nanomem.augmentQueryAdaptive(...)` with that
     previously delivered context, so follow-ups can reuse what is already in the
     chat, retrieve only missing memory, and keep prompt crafting inside `nanomem`.
   - Denied/skipped memory prompts are not added to `memoryRetrievedContext`.
   - If adaptive retrieval returns `skipped: true` because previously retrieved
     context already covers the follow-up, root does not create another memory
     prompt, but it sets a one-shot API override from the already-approved
     context so the frontier model still receives it. Skips for `No new relevant
     memory found` / `No new memory context needed` send the plain prompt.
   - Adaptive turns that need more information receive a review prompt from
     `nanomem` built from only the newly retrieved context and show the number of
     newly retrieved memory files.
   - `nanomem@24871d9` adds an adaptive no-op precheck for follow-ups that are
     obviously answerable from previously approved context. Ambiguous,
     recommendation/planning, or under-covered follow-ups should retrieve; if an
     adaptive skip is partial/low confidence before a targeted retrieval,
     `nanomem` falls back to keyword search rather than letting root reuse
     incomplete context.
   - Current `nanomem` retrieval emits `search_memory(...)` tool calls for
     keyword lookup. Keep `retrieve_file` labels only as a legacy trace fallback
     for older locally stored status messages.
   - Retrieval and adaptive retrieval may also return sufficiency metadata
     (`retrievalConfidence`, `coverage`, `missingVariables`, `retrievalReason`,
     `uncertainFacts`). Root normalizes these into `memoryRetrievalAssessment`
     on the local Memory Agent message and `ciPromptDraft`. The UI only surfaces
     confidence as a small badge in the revised prompt header when the retrieval
     result explicitly includes confidence metadata; fallback defaults stay
     internal. Coverage and missing/uncertain details remain internal metadata.
     These fields are informational only and do not change
     include/skip/auto-include behavior.
   - First-turn `augmentQuery(...)` successful prompt results still do not carry
     explicit retrieval confidence from `nanomem`; adaptive results do. Keep the
     prompt header confidence quiet on first-turn prompts unless that contract
     changes.
3. The local status message shows tool/phase trace and a summary of retrieved
   files.
   - Tool rows now appear immediately when the LLM emits the tool call, and the
     same row is updated in place when the executor finishes.
4. In augment mode, the outer `nanomem` retrieval loop only identifies the
   relevant memory files and then calls the real `augment_query` tool with:
   - `user_query`: the original user message
   - `memory_files`: the minimal relevant memory file paths
   - If nothing relevant is found, `memory_files` is allowed to be empty. That is
     treated as a normal no-memory path, not an executor error.
5. The `augment_query` executor performs a dedicated confidential prompt-crafter
   call inside `nanomem` with strong minimization guidance modeled on
   `memory-chat`'s CI crafter. It returns:
   - `reviewPrompt`: exact review text
   - `apiPrompt`: final stripped payload for the frontier model
   - `files`: the selected memory files used to craft the prompt
   - the root app adapts that into `ciPromptDraft.fullPrompt` plus optional
     `ciPromptDraft.editedFullPrompt`
   - If the crafter produces no `[[user_data]]` tags, `nanomem` treats that as
     a no-memory outcome and falls back to the normal send path.
   - The inner prompt-crafter call does not force a `max_tokens` parameter.
   - When the provider supports streaming, that inner crafter call only emits
     coarse live phase updates into the memory-agent trace while `augment_query`
     stays shown as the active running tool.
   - Raw inner prompt-crafter chain-of-thought is intentionally not shown in the
     visible trace. The goal is progress visibility, not a second full reasoning
     transcript inside the tool row.
   - If the model returns empty content, invalid JSON, or no `task`, `nanomem`
     retries that crafter step up to 3 total attempts before failing.
6. The user explicitly approves or skips the prompt in-chat.
7. If approved, the app stores the one-shot override in `_lastApiContent`.
8. If the approved prompt contains new memory context, the app appends that
   context to `session.memoryRetrievedContext` for later adaptive retrieval.
9. `processMessagesWithFiles()` swaps only the last user message payload with
   that override for the real frontier-model request.
10. The override is cleared after the send/regenerate flow finishes.

Parallel/Council sessions use the same one-shot flow. Root runs memory
augmentation once before `councilController.runSendTurn(...)` or
`runRegenerateTurn(...)`, then each Stage 1 lane calls
`processMessagesWithFiles()` and receives the same approved last-user override.
Do not add retrieval inside `councilController`: there should be no per-lane
memory key redemption and no lane-specific retrieved context. Council synthesis
uses the canonical chat context and Stage 1 responses only; it must not receive
the memory override a second time.

If retrieval finds nothing, tickets are unavailable, or retrieval fails, the app
falls back to a normal send without memory context.

Important scope rule: the `augment_query` memory agent in the chat send loop is
read-only. It never writes during the retrieval/approval path before a model
request is sent. Memory writes happen through separate ingestion/storage paths.

Current write paths in root `oa-chat`:

- Live post-turn extraction runs after successful `sendMessage()` and
  `regenerateResponse()` completions only when the global memory feature is
  enabled. It normalizes the full current session and calls
  `memoryBridge.ingestMessages(...)`. This remains independent of the
  chat-vs-memory mode toggle when the feature itself is on.
- Manual `Backfill` scans IndexedDB sessions newest-first and imports eligible
  conversations through `nanomem.importData(...)`, skipping sessions whose
  `updatedAt` is not newer than `session.memoryProcessedAt`.
- OMF import and memory-panel edits write directly to storage. They are explicit
  storage mutations, not chat-session extraction.

Important minimization rule: the crafter is allowed to ignore retrieved memory
that is not actually needed. Reading a file does not automatically justify
forwarding its details into the final prompt.

## UI Notes

- The global memory feature switch is persisted in IndexedDB setting
  `memoryFeatureEnabled` and defaults on for existing users. When it is off,
  the app forces `memoryMode` false, skips live post-turn extraction, skips
  memory retrieval, aborts active memory retrieval/extraction work, blocks the
  memory editor/backfill/import/export entry points, and disables only the
  Memory book toggle beside the Chat/Parallel slider. The Chat/Parallel slider
  remains interactive while Memory is globally off. Confidential memory-key
  redemption is passed the same abort signal, and returned keys are not stored
  if Memory is disabled
  during redemption. Memory-editor saves, imports, clean-up, and folder
  mutations also use an operation generation guard so stale local operations do
  not complete their UI path after the feature is turned off. The memory bridge,
  storage singleton, and OMF importer lazy-load `nanomem`; app startup and
  disabled settings/editor controls must not evaluate the nanomem browser
  module.
- The Memory book toggle is global and persisted in IndexedDB setting
  `memoryMode`, but it cannot enable auto-attach while `memoryFeatureEnabled`
  is false.
- A single book click toggles auto-attach. A quick double-click opens the memory
  filesystem panel and leaves auto-attach enabled, so the next single click can
  turn it off.
- Memory mode also has two persisted privacy settings in IndexedDB:
  - `memoryAutoInclude`: shown in settings as `Always attach retrieval`;
    automatically approve memory prompts without waiting for the per-message
    buttons
  - `memoryAgentModel`: the confidential model used for retrieval and
    backfill/import flows
- Retrieval state is shown as a local-only assistant message, not a modal wizard.
- Successful assistant responses now also trigger a non-blocking post-turn
  extraction pass for the current session through `nanomem.ingest(...)` when the
  global memory feature is enabled, regardless of whether the current mode is
  chat or memory.
- This mirrors `memory-chat`'s background extractor behavior, but stays behind
  the root app's `memoryBridge.js` seam.
- Live post-turn extraction reprocesses the whole normalized session each time.
  `memoryProcessedAt` is still updated on success, but that timestamp is only
  used by manual backfill; live dedupe is only the per-session in-flight guard.
- The local assistant status message is explicitly a `memory agent`:
  - title renders as `Memory Agent`
  - icon is the inline book glyph from `memory-chat`
  - the timestamp is rendered without hover-fade transitions so it does not
    flash during trace refreshes
  - status copy should stay one line. Prompt details belong in the revised
    prompt preview, not in the summary text. Current non-preview summaries use
    compact forms such as `No added memory. Sending original prompt.`,
    `No new retrieval. Using previously approved memory.`, and
    `Memory context was not added this time. Sending without it.`
  - retrieval failures keep that generic one-line summary, but now also render a
    compact `Note:` row from structured `memoryRetrievalFailure` metadata. The
    default chat surface only shows the short title, not the longer detail.
    User-facing note copy should stay calm and avoid raw diagnostic wording.
    The classifier is intentionally allowlisted and must not expose raw
    exception strings, provider response bodies, prompts, memory contents, URLs
    containing secrets, or API keys.
- Prompt preview/edit uses the same tagged prompt editor pattern as `memory-chat`:
  - `[[user_data]]...[[/user_data]]` spans render as highlighted user-data marks
  - edits persist into `ciPromptDraft.editedFullPrompt`
  - approval strips those tags before populating `_lastApiContent`
- Pending memory prompts now expose 4 actions in-chat:
  - `Include memory`
  - `Always include` (turns on auto-include and approves the current prompt)
  - `Skip`
  - `Edit prompt`
- Approved prompts stay previewable directly in the local status message. The approved
  state intentionally omits a separate prompt button because the revised prompt is
  already visible and no longer editable.
- When auto-include is on, memory retrieval still renders the local `memory agent`
  summary message, but it immediately marks the prompt approved and continues the
  send flow without waiting on the buttons.
- In Parallel/Council, that local `memory agent` row appears once above the
  two-lane response card. It is not a third response lane and does not add
  another model picker.
- Regeneration clears prior local-only memory status messages after the last user
  turn before rerunning memory mode, so the chat does not accumulate stale
  retrieval summaries.
- Resending a user prompt prunes approved memory context linked to that user
  turn and later user turns before rerunning memory retrieval. On a first-turn
  resend this clears all reusable session memory context, so the rerun does not
  show an approved-memory reuse status from the same prompt's previous attempt.
- The memory filesystem panel uses the same modal/tree/editor shell as
  `memory-chat` and opens with `Cmd/Ctrl+Shift+M`.
- The settings menu also exposes a dedicated `Memory` row under `Data Controls`.
  - `Export` uses the same OMF exporter as the memory panel header.
  - `Import` opens the memory panel and routes the chosen file into the same OMF
    preview/merge flow as the header import button.
- The settings menu exposes memory controls in a dedicated `Memory` section.
  The global `Memory feature` switch appears first; `Always attach retrieval`,
  the memory agent model, and memory import/export controls sit beneath it as
  flat subordinate rows without a nested vertical rule. Turning the global
  switch off disables those subordinate controls, forces the bottom chat/memory
  slider back to Chat, and changes the Memory icon hover copy to
  `Memory is off in settings`.
- The panel's `Export` / `Import` buttons now match `memory-chat`, but the
  actual OMF logic lives in `nanomem`:
  - `Export` writes Open Memory Format (`.omf.json`) through `memoryBank.exportOmf()`
  - `Import` validates the OMF document, shows a preview of new vs duplicate memories,
    offers an `Include archived memories` checkbox, and merges into existing files
    through `memoryBank.previewOmfImport()` / `memoryBank.importOmf()`
- `Clean expired` is deterministic local maintenance. It calls
  `memoryBank.pruneExpired()`, archives bullets whose `expires_at` has passed,
  refreshes the file tree/selected file, and does not require tickets or an LLM
  key.
- `Backfill` now means local-chat ingestion, not raw memory-file import:
  - it scans local IndexedDB chat sessions
  - processes the newest eligible chats first (`updatedAt` / `createdAt` descending)
  - skips sessions whose `updatedAt` is not newer than `memoryProcessedAt`
  - skips the currently streaming session
  - excludes local-only `memory agent` status messages from the import input
  - uses the currently selected `memoryAgentModel`
  - uses the same confidential key flow as memory retrieval, so it currently
    needs 1 available inference ticket
  - transient confidential-model transport failures are retried inside `nanomem`
    before the chat is marked failed
  - the header `Backfill` button turns into a stop control while import is running
  - closing the memory panel no longer stops that run; backfill continues in the
    background and the panel can be reopened later to inspect/stop it
  - stopping the run only leaves the currently interrupted chat unmarked; chats
    that already completed still keep their `memoryProcessedAt` marker, so the
    user can resume later and continue from the remaining eligible chats
  - root now persists `memoryProcessedAt` as each item completes, not only at the
    end of the whole run, so restarting backfill immediately skips chats that
    already finished before the stop
  - root now redeems confidential memory keys item-by-item as needed during the
    run. If a key expires mid-backfill and enough tickets remain, the app
    invalidates that key, requests a fresh one, and retries the same chat once
    before giving up
  - exhausted failures still leave that chat eligible for the next backfill run
    because `memoryProcessedAt` is only written after a non-error result
- Live post-turn extraction uses the same normalized message filtering as backfill:
  local-only messages are excluded, `memory agent` messages are excluded, and
  restored scrubber text is preferred when available.

## Known Gaps

- Pre-ingestion granularity is still coarse. Root live extraction triggers after
  successful assistant completions, while `nanomem` has no semantic pre-gate, no
  ingest-side decision/progress event, and reports a no-write tool loop as
  `status: 'processed'` with `writeCalls: 0`. Keep semantic "is this worth
  remembering?" policy in `nanomem`; keep session/UI dedupe in root `oa-chat`.
- Retrieval cancellation now uses the active chat stream `AbortController`.
  - The app passes the input stop signal through `memoryBridge.augmentQuery(...)`
    / `augmentQueryAdaptive(...)` into `nanomem`.
  - `nanomem` forwards that `AbortSignal` through retrieval tool loops,
    adaptive no-op checks, direct answer rendering, and the inner
    `augment_query` prompt-crafter request/retry sleep.
  - The status message is updated to `Memory retrieval cancelled.` and the
    normal frontier-model send is not started after a stop.
- Root backfill is still intentionally simpler than `memory-chat`'s old extractor path:
  - progress is only reflected through the `Backfill` / stop button state + toast summary
  - there is still no separate queue modal or per-item retry UI
