# Memory Mode

This document describes the root `oa-chat` memory-mode integration that reuses
`nanomem` as a git submodule while keeping the app-side code thin.

## Scope

- Root `oa-chat` now has a global 2-mode slider: normal chat vs. memory mode.
- Memory mode only brings in the `augment_query` flow.
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
  entrypoint.
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
- The bridge requests confidential keys from `ticketClient.requestConfidentialApiKey(2)`.
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
8. `processMessagesWithFiles()` swaps only the last user message payload with
   that override for the real frontier-model request.
9. The override is cleared after the send/regenerate flow finishes.

If retrieval finds nothing, tickets are unavailable, or retrieval fails, the app
falls back to a normal send without memory context.

Important scope rule: the memory agent in the chat send loop is read-only. It
does not write back to memory after each turn. Memory writing/extraction is only
triggered by explicit actions like `Backfill`, `Import`, or manual edits in the
memory panel.

Important minimization rule: the crafter is allowed to ignore retrieved memory
that is not actually needed. Reading a file does not automatically justify
forwarding its details into the final prompt.

## UI Notes

- The chat/memory slider is global and persisted in IndexedDB setting `memoryMode`.
- Memory mode also has two persisted privacy settings in IndexedDB:
  - `memoryAutoInclude`: automatically approve memory prompts without waiting
    for the per-message buttons
  - `memoryAgentModel`: the confidential model used for retrieval and
    backfill/import flows
- Retrieval state is shown as a local-only assistant message, not a modal wizard.
- When memory mode is on, successful assistant responses also trigger a non-blocking
  post-turn extraction pass for the current session through `nanomem.ingest(...)`.
  This mirrors `memory-chat`'s background extractor behavior, but stays behind the
  root app's `memoryBridge.js` seam.
- The local assistant status message is explicitly a `memory agent`:
  - title renders as `Memory Agent`
  - icon is the inline book glyph from `memory-chat`
  - the timestamp is rendered without hover-fade transitions so it does not
    flash during trace refreshes
- Prompt preview/edit uses the same tagged prompt editor pattern as `memory-chat`:
  - `[[user_data]]...[[/user_data]]` spans render as highlighted user-data marks
  - edits persist into `ciPromptDraft.editedFullPrompt`
  - approval strips those tags before populating `_lastApiContent`
- Pending memory prompts now expose 4 actions in-chat:
  - `Include memory`
  - `Always include` (turns on auto-include and approves the current prompt)
  - `Skip`
  - `View prompt`
- Approved prompts stay previewable from the local status message.
- When auto-include is on, memory retrieval still renders the local `memory agent`
  summary message, but it immediately marks the prompt approved and continues the
  send flow without waiting on the buttons.
- Regeneration clears prior local-only memory status messages after the last user
  turn before rerunning memory mode, so the chat does not accumulate stale
  retrieval summaries.
- The memory filesystem panel uses the same modal/tree/editor shell as
  `memory-chat` and opens with `Cmd/Ctrl+Shift+M`.
- The settings menu also exposes a dedicated `Memory` row under `Data Controls`.
  - `Export` uses the same OMF exporter as the memory panel header.
  - `Import` opens the memory panel and routes the chosen file into the same OMF
    preview/merge flow as the header import button.
- The panel's `Export` / `Import` buttons now match `memory-chat`, but the
  actual OMF logic lives in `nanomem`:
  - `Export` writes Open Memory Format (`.omf.json`) through `memoryBank.exportOmf()`
  - `Import` validates the OMF document, shows a preview of new vs duplicate memories,
    offers an `Include archived memories` checkbox, and merges into existing files
    through `memoryBank.previewOmfImport()` / `memoryBank.importOmf()`
- `Backfill` now means local-chat ingestion, not raw memory-file import:
  - it scans local IndexedDB chat sessions
  - skips sessions whose `updatedAt` is not newer than `memoryProcessedAt`
  - skips the currently streaming session
  - excludes local-only `memory agent` status messages from the import input
  - uses the currently selected `memoryAgentModel`
  - uses the same confidential key flow as memory retrieval, so it still needs
    2 available inference tickets
  - transient confidential-model transport failures are retried inside `nanomem`
    before the chat is marked failed
  - exhausted failures still leave that chat eligible for the next backfill run
    because `memoryProcessedAt` is only written after a non-error result
- Live post-turn extraction uses the same normalized message filtering as backfill:
  local-only messages are excluded, `memory agent` messages are excluded, and
  restored scrubber text is preferred when available.

## Known Gaps

- Retrieval cancellation is still partial:
  - the app aborts approval waiting and post-retrieval continuation
  - `nanomem`'s OpenAI-compatible fetch path still does not forward `AbortSignal`
    into `fetch`, so an in-flight confidential retrieval request itself is not
    cancelled yet
- Root backfill is intentionally simpler than `memory-chat`'s old extractor path:
  - there is no cancel button yet
  - progress is only reflected through the `Backfill` button state + toast summary
