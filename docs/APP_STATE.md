# App State and Handoff

This is the living handoff doc for the web app's current state. Use it to capture UI
behavior, coupled state, implementation gotchas, and lessons that are easy to miss when
reading code alone.

## How Agents Should Use This

1. Read this file before changing UI-heavy or stateful parts of the app.
2. Read any more specific doc in `docs/` that matches the feature area you are touching.
3. After meaningful work, update this file or the feature-specific doc with what changed,
   what was learned, and any non-obvious behavior the next agent should know.

If a lesson belongs in a dedicated feature doc, add it there and leave a short pointer in
this file so future agents can find it quickly.

## What To Record

- Subtle UI expectations or interaction rules that are not obvious from reading the code.
- State coupling across components, services, persistence keys, or responsive layouts.
- Known constraints, sharp edges, and regression risks discovered during implementation.
- Follow-up work or unresolved questions that the next agent should evaluate.

Keep entries concise and factual. Prefer short bullets over long narratives.

## Current Notes

- 2026-07-28: Account authentication supports Google and GitHub OAuth in
  addition to passkeys; see [GOOGLE_SIGN_IN.md](GOOGLE_SIGN_IN.md) and
  [GITHUB_SIGN_IN.md](GITHUB_SIGN_IN.md).
  - `accountService.authenticateWithOAuth(provider, ...)` owns the shared popup,
    setup, recovery-unlock, account-mismatch, and local-key restoration flow.
    Provider-specific linked flags plus `lastOAuthProvider` are persisted so a
    locked browser can recover through the most recently used provider.
  - Google requests only `openid`; the org retains only the OpenID Connect
    `sub`. OAuth/access tokens and Google email/profile fields are discarded.
  - `npm run dev` serves static assets and proxies non-static requests to the
    local org on port `8005`. The browser therefore uses its own origin for
    passkey, OAuth, ticket, and sync API calls, avoiding local-network/CORS
    restrictions. OAuth callbacks still come directly from port `8005`, so
    `ORG_AUTH_ORIGIN` remains separate from the local `ORG_API_BASE`.
    The dev server injects a runtime-only proxy marker, so `npm run preview` on
    localhost still uses `https://org.openanonymity.ai`. The callback host is
    canonical `localhost`; requests to the dev server via `127.0.0.1` redirect
    there before the app loads.
  - Provider wrappers such as `authenticateWithGithub(...)` use the shared popup
    flow and the org's HttpOnly refresh cookie. OAuth/access tokens never travel
    through the popup message or app URL.
  - Google or GitHub authenticates the OA account but cannot unlock encrypted
    sync. New or logged-out browsers must enter the five-word recovery code;
    browsers with a persisted local master key restore normally.
  - A passkey-authenticated account can connect one identity per provider.
    OAuth-first accounts can later use the existing account-number/recovery flow
    to add a passkey.
  - Connecting either OAuth provider is an authenticator-enrollment operation
    and requires a fresh passkey step-up; a refresh-restored session is not
    sufficient.
  - Keep `oauthSetupRequired` (new account must save recovery material) distinct
    from `oauthRecoveryRequired` (existing account authenticated, encrypted key
    still locked). The account modal intentionally cannot close during the OAuth
    popup wait or while a new recovery code is unsaved.
  - Opting into Google or GitHub makes the sync account identifiable to the org,
    but does not put identity into blinded ticket redemption or inference
    traffic.
  - Syncable tickets and preferences are still browser-global rather than
    account-namespaced. The OAuth flow refuses an implicit account switch when
    another local account is unlocked, but an explicit logout followed by a
    different account can intentionally carry the browser's existing wallet
    into that account's sync data. Supporting shared-browser multi-user
    isolation requires account-namespaced local sync stores or an explicit
    wallet-transfer step.

- 2026-07-11: OpenRouter `~author/*-latest` aliases normalize in the catalog adapter,
  while provider display/icon metadata resolves through the shared provider registry;
  cached OpenRouter catalog entries also recompute provider metadata from their model
  IDs when used as a network fallback. Legacy UI paths must prefer catalog metadata,
  then resolve model IDs by author or explicit `Provider: Model` prefixes; do not infer
  a company from family keywords such as `llama`, and do not default unresolved names
  to OpenAI. Clean unknown display names keep their initial, while malformed/empty or
  explicitly `Unknown` providers use the generic `A` badge. All runtime provider
  assets are self-hosted. Unknown or missing providers fall back
  to neutral initial badges. Image load failures are handled by one capture-phase
  delegated listener, which swaps the failed image for its neutral initial badge;
  keep this fallback free of inline event handlers for strict-CSP compatibility.
  The image-failure badge uses an explicit dark foreground because known-provider
  consumers retain their white icon-circle background after the image is hidden.

- 2026-07-13: Provider logos hydrate from the local model-catalog cache before a saved
  model choice is rendered. `inferenceService.getCachedModels(...)` delegates to the
  restored session's backend; OpenRouter normalizes cached provider metadata before
  returning it. The result lives in `cachedModelDisplayMetadata`, not `state.models`, so
  stale cache entries cannot influence request-time availability or model selection.
  Session switches refresh this display-only cache for the new backend, and clearing the
  current session restores the default backend's cached metadata.
  Keep the live catalog fetch as a background refresh so saved choices such as `Auto
  Router` never flash an unknown initial while waiting on the network.

- 2026-07-02: Memory retrieval fallback now shows a safe, calm note in-chat.
  - `runMemoryAugmentFlow(...)` still logs the raw exception to the browser
    console as `Memory augment query failed:`, but the persisted local Memory
    Agent message now also carries `memoryRetrievalFailure`.
  - The failure note is classified by `chat/services/memoryRetrievalError.js`
    into safe categories such as auth, network, timeout, service, request,
    storage, runtime, and unknown. User-facing copy should stay calm and avoid
    scary diagnostic wording such as raw HTTP statuses or provider exception
    strings. Do not render raw provider error bodies, prompts, memory file
    contents, URLs with secrets, or API keys in the chat.
  - `MessageTemplates` renders the note as a compact sub-row under the Memory
    Agent status, but only shows the short title by default to keep the chat
    low-noise. The main fallback copy stays one line:
    `Memory context was not added this time. Sending without it.`
  - `buildSharePayload(...)` now routes through `chat/services/sharePayload.js`
    so shared Memory Agent messages preserve this safe reason metadata without
    pulling share-service network side effects into payload tests.
- 2026-06-27: Memory now has a global feature gate.
  - IndexedDB setting `memoryFeatureEnabled` defaults on. When false, app
    initialization and `setMemoryFeatureEnabled(false)` force `memoryMode` false
    and persist that reset so reloads stay in Chat mode.
  - The settings menu has a dedicated `Memory` section. Its first row is the
    global `Memory feature` switch; `Always attach retrieval`, the memory agent
    model, and memory import/export controls are flat rows beneath it rather
    than nested behind a vertical rule, and become disabled when the feature is
    off.
  - `triggerPostTurnMemoryExtraction(...)`, `runPostTurnMemoryExtraction(...)`,
    and `runMemoryAugmentFlow(...)` all check the feature gate before requesting
    confidential memory keys or constructing retrieval/extraction memory banks.
    Disabling the feature increments a memory-work generation, aborts in-flight
    memory retrieval/extraction signals, clears pending memory prompt overrides,
    resolves pending approval prompts as skipped, and closes/aborts memory-editor
    backfill work. The bottom chat/memory slider remains hoverable but locked to
    Chat with `Memory is off in settings` copy on the Memory icon.
    Confidential memory-key redemption now receives those abort signals, and
    returned keys are not stored if the feature is disabled during redemption.
    Memory-editor local storage operations also use an operation generation and
    abort signal so stale saves, imports, maintenance, and folder operations do
    not continue their UI completion path after the global feature flips off.
    `memoryBridge`, `memoryInstances`, and OMF import helpers lazy-load
    `chat/nanomem/browser.js` only inside active memory operations. Importing
    the app shell, constructing `MemoryEditor`, toggling settings, or validating
    disabled controls must not evaluate nanomem while the global feature is off.
    The memory panel/import/export storage bank is also lazy and only constructs
    when the feature is enabled and the user explicitly opens or uses memory
    management.
- 2026-06-03: Inline quick ask is a non-persistent mini-chat for selected
  assistant text.
  - Selecting text inside an assistant `.message-content` shows a compact
    fixed-position `Ask` popover. User-message selections, selections inside the
    quick-ask window, scrubber-restored assistant responses, and collapsed
    selections are ignored.
  - Clicking `Ask` opens a small force-touch-style panel near the selection
    as a body-level fixed overlay with a saved chat-scroll anchor, with a single unsaved user turn,
    `Briefly explain "<selection>" in context.`, and a streamed assistant
    answer. The panel is portaled out of the message container so it paints
    above the composer and message chrome while staying below modal layers, but
    `ChatArea` updates its saved anchor on chat scroll so it still moves with
    the selected response instead of staying pinned to the screen. Clicking
    elsewhere in the chat UI hides the panel without aborting the in-flight
    answer. While the popover or panel is visible, `body.quick-ask-layer-active`
    lowers the composer-specific z-indexes below the quick-ask layer; keep quick
    ask below modal `z-50` surfaces.
  - The panel intentionally has no title/selected-term header; the selected text
    is already represented by the generated user question. Keep the panel shadow
    restrained and reuse the main `.message-user` bubble styling for the quick
    user prompt so it stays visually consistent with normal chat turns. Pending
    labels and reasoning traces reuse the main chat `.pending-response-*` and
    `buildReasoningTrace(...)` formatting rather than custom quick-ask labels.
    The panel has no close control; outside clicks and Escape hide it without
    aborting the request, and reopening the same selected text restores the same
    in-memory quick-ask state. Same-session message rerenders must preserve and
    reconnect the cached quick-ask panel; otherwise key acquisition or storage
    refreshes can leave `this.quickAsk.window` pointing at a detached DOM node
    and make later `Ask` clicks appear to do nothing. Restores should reattach
    the panel without recomputing its position because its saved absolute
    `left/top` are already content-relative and should continue to scroll with
    the message.
  - `ChatApp.inlineQuickAsk(...)` appends the quick question to the sanitized
    current transcript in memory only. It reuses the current session backend,
    scrubber redaction, file-to-API processing, search and reasoning toggles,
    and the current ephemeral access credential when one is active, but it
    resolves inference to the first pinned GPT Instant model instead of the
    session's selected model. If no pinned GPT Instant model is loaded, it falls
    back through the normal pinned default path. For older sessions with a
    missing or expired key, quick ask goes through the same
    `acquireAndSetAccess(...)` ticket redemption path as a normal send with a
    model id override so ticket cost is based on the resolved instant model even
    when catalog display names differ from normalized names, shows the standard
    `Requesting ephemeral key` pending state, and re-checks the panel abort
    before inference begins. Access acquisition is keyed by backend, session,
    and model so callers with different ticket-cost models do not incorrectly
    share a redemption; same-model callers still share via
    `accessAcquisitionInFlight`. Normal send/regenerate call
    `reserveAccessAcquisitionHandoff(...)` before closing the quick-ask panel so
    same-model key requests can survive the handoff. The underlying key request
    receives an abort signal and is cancelled when the last waiter aborts
    outside that handoff window.
  - Quick-ask answers are not written to IndexedDB, do not create sessions, and
    do not update session search/title state. User close only hides the panel and
    lets the request finish in memory. Full `ChatArea.render()` calls abort/reset
    the panel so a quick ask cannot linger across session switches. Starting a
    normal send or regeneration hides any active quick ask before the main
    session stream begins.
- 2026-05-30: Fresh-chat default model follows the pinned model order.
  - `modelConfig.getDefaultModelConfig()` now derives `defaultModelId` and
    `defaultModelName` from the first current pinned model, falling back to the
    local pinned list only before org availability data is cached or fetched.
  - Send-time fallback also walks the pinned model IDs in order, so if the top
    pinned model is unavailable in the loaded catalog the next visible pinned
    model is selected before falling back to the catalog's first model.
  - `ModelPicker` refreshes its default label when pinned-model config updates
    and asks `ChatApp.getDefaultModelName()` for empty-session display, keeping
    the button aligned with the rendered pinned section after models load.
  - Stored preferences matching recent default labels (`GPT-5.1/5.2 Instant`)
    upgrade to the current pinned default; per-session model choices are still
    left intact.
  - When fresh pinned-model data arrives after a stale local cache, the
    availability refresh reruns the stored default preference upgrade and updates
    the no-session pending model if it was still tracking the old default.
    Initial model-catalog load also drains pinned updates that arrived while
    `modelsLoading` was true.
- 2026-05-26: Prompt edit file drag feedback is scoped to the inline editor.
  - While a prompt edit draft is open, file drags highlight the edit prompt card
    and keep the bottom composer drop overlay hidden, matching the drop target.
  - The edit form does not replay its enter animation on attachment add/remove
    refreshes, avoiding a post-drop flash when the attachment list rerenders.
- 2026-05-25: Memory-agent status summaries were shortened.
  - Approved/reused memory sends now use compact copy such as `No new retrieval.
    Using previously approved memory.` instead of spelling out minimized
    personal context or generic sending state.
  - No-memory adaptive sends now say `No added memory. Sending original prompt.`
    so the status row stays easier to scan.
- 2026-05-25: Pulled `nanomem` to `dbdbd4b` on top of latest upstream
  `origin/main` `9dd3581`.
  - Upstream added ingestion prompt/version-log cleanup and temporal wording
    changes. Root still depends on cancellation propagation through
    `memoryBridge`, so the abort-support patch was carried forward on top of
    upstream and verified with `test/engine/retrieveAbort.test.js`.
  - While integrating, `nanomem` version-log mutation paths were adjusted to
    respect stored bullet `v=` metadata as well as existing `_vlog` entries.
    This keeps delete/update/corroboration/compaction entries monotonic for
    memories that already have inline versions but no companion vlog yet.
  - `_vlog/` audit files are now treated as internal storage: they stay readable
    through raw storage/export paths but are excluded from the memory tree,
    search/list surfaces, bullet index, deletion deep scans, and portable
    text/ZIP exports so the agent does not ingest its own audit log. OMF export
    in the browser/IndexedDB app still preserves vlogs under
    `extensions.nanomem.vlogs` for round-trips.
  - Agent-facing memory tools normalize path strings before internal-path
    checks and reject `_tree.md` / `_vlog/` paths across read and write tools,
    including `./_vlog/...` and `work/../_vlog/...` forms.
  - Storage writes canonicalize internal paths before persisting, so OMF vlog
    extension keys like `./_vlog/...` are restored as canonical `_vlog/...`
    records instead of becoming normal memory files.
- 2026-05-25: User prompt edit mode now has an attachment draft.
  - `ChatApp.editDrafts` keeps edited text plus attachment metadata in memory while
    the inline editor is open; IndexedDB is not updated until the user saves.
  - The edit form can add newly validated files and remove existing attachments.
    On save, `message.content` and `message.files` are committed together before
    later turns are truncated and `regenerateResponse()` runs.
  - Empty-text prompts are valid only when at least one attachment remains, matching
    normal send behavior for file-only turns.
  - Edit attachments render inside the same bordered prompt editor surface as the
    textarea and controls. Global file paste routes to the active edit textarea's
    draft instead of the main chat input.
  - Edit-mode file drop routes to the hovered edit prompt card, falling back to
    the focused edit textarea. The attachment count label opens the same file
    picker as the paperclip icon.
- 2026-05-25: Forked conversations preserve generated/manual titles.
  - `ChatApp.forkConversation(...)` now asks `chat/domain/sessionSearch.js` for
    fork title fields instead of rebuilding every fork title from the first user
    message.
  - Source sessions with `titleSource: 'generated'` or `manual` keep that
    visible title plus ` (fork)`. Local fallback titles still derive from the
    first copied user prompt.
  - Forks explicitly set `titleGenerationPending: false`; copied historical
    messages are saved directly and should not restart async title generation.
- 2026-05-21: The left chat sidebar can now be toggled with `Cmd/Ctrl+\`.
  - The shortcut calls the same `showSidebar()` / `hideSidebar()` paths as the
    toolbar buttons, preserving the existing desktop persistence and mobile
    overlay behavior.
  - During the desktop close animation, `data-left-sidebar-closing` keeps the
    main-toolbar expand button hidden until the sidebar width transition ends.
  - The collapse and expand sidebar buttons use real tooltip markup, not
    `[data-tooltip]`, so the shortcut can match the model-picker style with
    separate muted `⌘` and key glyphs.
  - The delete-history sidebar icon uses the shared `[data-tooltip]` hover
    bubble, right-aligned to stay inside the sidebar edge.
  - While `data-left-sidebar-closing` is set, sidebar hover bubbles are
    suppressed so a hovered icon does not leave tooltip feedback during the
    collapse animation.
- 2026-05-18: Memory-mode stop now cancels the active memory retrieval itself.
  - The input stop button's existing chat-stream `AbortController` is threaded
    from `ChatApp.runMemoryAugmentFlow(...)` through `chat/services/memoryBridge.js`
    into `nanomem` `augmentQuery(...)` / `augmentQueryAdaptive(...)`.
  - `nanomem` now accepts optional `{ signal }` on retrieval/augment entrypoints
    and forwards it through the tool loop, adaptive no-op check, direct answer
    rendering, and the inner `augment_query` prompt-crafter request/retry sleep.
  - Aborted retrieval normalizes back to the app's cancelled-error path, persists
    `Memory retrieval cancelled.`, and does not continue into the frontier-model
    send.
- 2026-05-18: Resending a user prompt prunes approved memory context linked to
  the resent turn and any later user turns before regenerating.
  - First-turn resend clears `session.memoryRetrievedContext.entries` because
    there is no earlier approved chat context that should be reused.
  - Later-turn resend keeps entries from earlier user turns, so adaptive memory
    can still reuse context the user already approved before the resend point.
  - The resend action button is blurred and given a stable pressed/busy style
    before the message list rerenders to avoid a transient white focus flash.
- 2026-05-18: Pulled `nanomem` to `24871d9` / `v0.1.3-26-g24871d9`.
  - The latest commit tightens adaptive retrieval: before re-querying memory, it
    runs a small no-op check to skip only obvious already-covered follow-ups.
    If the adaptive agent skips with partial/low coverage before trying a
    targeted retrieval, `nanomem` now falls back to keyword search instead of
    silently reusing incomplete context.
  - `augmentQueryAdaptive(...)` now returns retrieval sufficiency metadata more
    consistently on skipped/no-new-memory paths (`retrievalConfidence`,
    `coverage`, `missingVariables`, `retrievalReason`). Root already normalizes
    these into `memoryRetrievalAssessment`, and the revised-prompt header only
    shows confidence when metadata is explicitly present in the retrieval
    result.
  - First-turn `augmentQuery(...)` still crafts prompts through the
    `augment_query` terminal tool and does not yet forward retrieval confidence
    into successful prompt results. Keep the UI quiet for that path unless
    `nanomem` later adds explicit metadata there.
- 2026-05-17: Pulled `nanomem` to `3510fb2` / package `0.1.3`.
  - The browser seam remains compatible with root `oa-chat`; `src/browser.js`
    still exposes `createMemoryBank`, `stripUserDataTags`, OMF helpers, and
    `augmentQueryAdaptive(...)`. It now also exposes `memoryBank.pruneExpired()`,
    which root uses for deterministic expired-memory cleanup.
  - Retrieval keyword search tool calls are now named `search_memory` instead of
    `retrieve_file`. Keep both labels in `MessageTemplates` so new streaming
    traces render polished names while older persisted traces remain readable.
  - Retrieval results may include sufficiency metadata
    (`retrievalConfidence`, `coverage`, `missingVariables`, `retrievalReason`,
    `uncertainFacts`). Root normalizes this into `memoryRetrievalAssessment` on
    local Memory Agent messages and `ciPromptDraft`. The UI only surfaces
    confidence as a small badge in the revised prompt header when the retrieval
    result explicitly includes confidence metadata; conservative fallback
    defaults stay internal. Coverage and missing/uncertain details remain
    internal metadata.
  - The Memory panel now understands numeric `confidence=0..1` metadata while
    preserving legacy `low` / `medium` / `high` bullets, and exposes a
    deterministic `Clean expired` action backed by `memoryBank.pruneExpired()`.
- 2026-05-10: The first UI-facing app interface seam is in place.
  - `chat/ui/appInterface.js` exposes component-specific facades for
    `ModelPicker` and `Sidebar`.
  - `chat/ui/vanilla/VanillaChatUi.js` now owns concrete component construction;
    `chat/app.js` should not import files from `chat/components/` directly.
  - `ModelPicker` now selects models through `ui.actions.selectModel(...)`
    instead of importing `chatDB`, so UI rewrites can call the same action
    without inheriting persistence details.
  - `Sidebar` still renders the current DOM, but it now receives a sidebar-only
    interface instead of the whole `ChatApp` object.
- 2026-05-10: The vanilla shell now has explicit persistence and backend ports.
  - `app.data` is supplied by `chat/ui/appInterface.js` and is the only path
    shell components should use for message/session/settings persistence.
    `ChatArea`, `ChatInput`, `MessageNavigation`, `RightPanel`,
    `MemoryEditor`, and `ChatHistoryImportModal` no longer import `chatDB`.
  - `app.services` groups ticket, network logger, proxy, and inference gateways
    for the vanilla shell. `RightPanel`, `WelcomePanel`, `ThanksPanel`,
    `ChatInput`, and `MemoryEditor` should call the injected services instead
    of importing those gateways directly.
  - The same service port now also covers verifier attestation, share URLs,
    account state, and sync. `TLSSecurityModal`, `VerifierAttestationModal`,
    `ShareModals`, `AccountModal`, and `MessageTemplates` should be configured
    through the vanilla adapter rather than reading backend modules/globals.
  - The architecture tests in `test/architecture/uiBoundary.test.js` enforce
    the current boundary: `app.js` cannot construct concrete components,
    domain/application modules cannot import UI, shell components cannot import
    `chatDB`, and gateway-heavy shell components cannot import backend gateway
    modules directly.
- 2026-05-06: The frontend architecture refactor has started with tested domain
  seams.
  - See [FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md) for the target
    component map and progress tracker.
  - `chat/app.js` now delegates message API payload shaping, session search/title
    helpers, model-selection helpers, and streaming pending-phase normalization
    to pure modules under `chat/domain/`.
  - Access acquisition now goes through `chat/application/accessController.js`;
    keep UI notifications as injected callbacks so ticket redemption and verifier
    behavior remain testable without DOM dependencies.
  - `npm test` runs unit tests through `scripts/run-unit-tests.mjs`, which
    bundles browser-style ES modules with esbuild and executes Node's built-in
    test runner. This avoids adding a framework test dependency while the app is
    still HTML-first.
- 2026-05-06: `.docx` attachments are supported by local text extraction.
  - `chat/services/fileUtils.js` reads the DOCX ZIP in the browser, inflates
    `word/document.xml` plus headers/footers/notes, and extracts plain text from
    WordprocessingML before inference. The original document still stays in the
    stored attachment `dataUrl` for preview/download.
  - `chat/app.js` persists `file.extractedText` on the user-message file metadata
    for DOCX uploads. `chat/domain/messageContent.js` uses that cached text for
    normal sends, reloads, and regeneration; it does not send the DOCX binary as
    an OpenRouter file part.
  - DOCX parsing requires browser `DecompressionStream('deflate-raw')`; upload
    validation rejects unreadable documents before they enter the draft.
- 2026-05-06: Sending or regenerating a prompt now starts a prompt slide-up effect.
  - `ChatApp.startPromptSlideUpEffect(...)` anchors the active user prompt at roughly 25%
    from the top of `#chat-area`, then keeps `isAutoScrollPaused` true while the response
    streams so long model output does not pull the viewport down.
  - The effect uses a DOM-only `.prompt-scroll-spacer` at the end of `#messages-container`.
    `ChatArea` streaming/append hooks call `updateActivePromptScrollSpacer()` so the spacer
    shrinks as assistant content appears; once output is tall enough, the spacer is hidden.
  - Explicit bottom-following should go through `ChatApp.shouldAutoScrollChat(...)`.
    A live prompt slide-up effect always returns false for non-forced auto-scroll.
    `#chat-area.prompt-slide-active` and `.prompt-scroll-spacer` use `overflow-anchor: none`
    so browser scroll anchoring does not nudge the viewport as the spacer shrinks near the
    bottom of the screen.
  - While the active prompt-slide response is streaming, `updateScrollButtonVisibility()`
    suppresses the scroll-to-bottom button. That button otherwise appears exactly when the
    streamed assistant output reaches the fixed input box and can cause a one-time visual
    flicker at the bottom edge.
  - Once streaming is over, automatic visibility checks may hide the scroll-to-bottom button,
    but they must not clear a visible spacer. The minimally sized spacer often makes the
    anchored prompt technically sit at the scroll container's real bottom; clearing it there
    drops the prompt back down after stream completion. Only clear automatically when the
    spacer is already gone/tiny, or clear explicitly from the scroll-to-bottom button/new
    prompt/session cleanup paths.
  - Final stream cleanup can replace streaming DOM with shorter final markdown/reasoning DOM.
    `ChatArea.finalizeStreamingMessage(...)` and `finalizeReasoningDisplay(...)` must wrap
    those mutations with `captureActivePromptScrollAnchor({ primeRunway: true })` and
    `restoreActivePromptScrollAnchor(...)`; otherwise the browser can clamp `scrollTop`
    before the prompt spacer is recomputed and visually drop the prompt at stream end.
  - Do not persist this spacer in IndexedDB or message records. It is only a viewport runway
    for the current tab. `sessionPromptScrollAnchors` remembers the active prompt per
    session in memory, and `session.promptSlideAnchorMessageId` persists the anchor message
    id so refresh can rehydrate the viewport runway. Switching sessions detaches the DOM
    spacer, and switching back rehydrates it before scroll restoration so an in-flight or
    just-finished response does not snap downward. Reaching the real bottom or clicking the
    scroll-to-bottom button clears the per-session anchor; sending another prompt retargets
    the existing spacer rather than clearing it first.
  - When appending while a prompt-slide spacer is present, insert new message DOM before the
    spacer. Appending after the spacer and then retargeting/removing it causes a visible
    lower-then-slide-up motion on follow-up prompts.
  - Do not detach the old prompt-slide spacer at the start of `switchSession()`. `ChatArea`
    may await IndexedDB before replacing messages, and early detach creates a visible flash
    where the old session drops down. Instead, `ChatArea.render()` calls
    `detachStalePromptSlideUpEffect()` immediately before writing the new session DOM.
  - Stream cancellation must preserve any chunks already received. `chat/api.js` normalizes
    non-Error abort throws before setting `isCancelled`; otherwise a thrown abort string can
    become a generic TypeError and make `ChatApp` replace the partial assistant output.
- 2026-05-04: Sidebar filtering now combines text search, starred-only, quick
  updated-time ranges, and an exact local-date picker.
  - Star state is stored directly on session records as `session.starred` with
    optional `starredAt`; toggling it does not change `updatedAt`, so starring a
    chat does not reorder history.
  - The filter popover lives at the right edge of the sidebar search field. The
    shortcut hint is shifted left to make room for the filter button.
  - Session rows show a separate star affordance on hover/focus so users can
    discover starring without opening the overflow menu. Starred sessions keep
    that star visible. The adjacent overflow menu remains compact.
  - The popover is intentionally compact: a single `Starred only` toggle, one
    `Updated` select, and one exact-date input. Avoid expanding quick ranges
    into a grid of buttons; it makes the sidebar feel like a panel instead of a
    small filter menu.
  - When search, starred-only, or date filtering is active, the sidebar scans
    all session records from IndexedDB so older chats outside the paged sidebar
    are still eligible. Message loading is still avoided unless a text query
    needs lazy `conversationSearchText` backfill.
- 2026-04-30: Memory mode now uses `nanomem.augmentQueryAdaptive(...)` for multi-turn follow-ups.
  - New sessions initialize `session.memoryRetrievedContext = { version: 1, entries: [] }`.
  - A memory context entry is appended only after the user approves the memory prompt or auto-include sends it. Denied/skipped prompts are not reusable context.
  - First memory turns still use `nanomem.augmentQuery(...)`. Once a session has approved memory context, later turns call `augmentQueryAdaptive(query, previouslyRetrievedContext, conversationText)` so adaptive skip decisions and prompt crafting both stay behind the nanomem seam.
  - If adaptive retrieval returns `skipped: true` because previously retrieved context already covers the follow-up, root does not create another review prompt, but it does set a one-shot API override from the already-approved context so the frontier model still receives it. `No new relevant memory found` / `No new memory context needed` skips still send the plain prompt.
  - Turns with newly retrieved `assembledContext` receive a review prompt from nanomem that contains only that new context, and root appends only that new context, so the session context does not duplicate itself every turn.
  - The root app relies on the browser entrypoint exposing `memoryBank.augmentQueryAdaptive(...)`; keep `nanomem/src/browser.js` in parity with `nanomem/src/index.js` when adding new browser-safe APIs.
- 2026-04-27: First-user-message chat titles now get an async model-generated summary.
  - The app still writes an immediate local fallback title from the first user message, then after the session has a valid ephemeral OpenRouter key it requests a short title from `google/gemini-3.1-flash-lite-preview`.
  - Title generation is fire-and-forget and failure-tolerant: a failed title request leaves the local fallback title unchanged and does not block the main chat stream.
  - `session.titleSource` protects user edits. Local automatic titles use `local`, generated titles use `generated`, and sidebar/manual renames use `manual`; async generation only overwrites the unchanged local title it started from.
  - Sidebar search matches the visible title, the legacy first-prompt `session.titleSearchText` for non-manual titles, and the bounded full-conversation `session.conversationSearchText` index.
  - `session.conversationSearchText` is built from non-local user/assistant message text, capped at 12k chars per session and 2k chars per message. Long chats preserve the first searchable message plus the most recent turns, trading complete recall for bounded IndexedDB size and predictable search cost.
  - Sidebar search uses literal/token matching, not arbitrary subsequence matching. Otherwise queries like `meaning` can match characters scattered across `means. In ... GPU`.
  - Existing sessions without `conversationSearchText` are lazily indexed during sidebar search and persisted through `chatDB.updateSessionSearchIndex(...)` without broadcasting a session reload.
  - See [SIDEBAR_SEARCH.md](SIDEBAR_SEARCH.md) for the current search algorithm and cap policy.
  - While a local fallback title is waiting for model generation, `session.titleGenerationPending` applies the sidebar title shimmer. Clear that flag on success, failure, empty-title output, missing/expired access, access-acquisition failure, or manual rename so the temporary-title animation does not persist indefinitely.
- 2026-04-26: Sidebar session titles must use attribute escaping when rendered into input values.
  - First-turn titles are generated from the raw user prompt, so prompts that begin with a double quote can produce titles like `"A CPU TEE ...`.
  - `Sidebar.escapeHtml()` is text-node escaping and is not sufficient inside `value="..."`; use the attribute-safe helper for session title inputs or quoted characters will break the attribute and the browser will show the `Untitled Chat` placeholder.
- 2026-04-26: Chat send now treats OpenRouter 402 credit exhaustion as a recoverable ephemeral-key condition.
  - When a pre-stream inference call fails with a 402 whose provider message mentions credits / affordability / `max_tokens`, `ChatApp.sendMessage()` clears the exhausted session key, shows a toast, redeems a fresh key through the normal inference-ticket flow, advances the pending UI from `Requesting ephemeral key` back to `Waiting for response`, and retries the same turn once.
  - The refresh is intentionally limited to pre-stream failures so an already-started partial assistant response is not discarded or replayed unexpectedly.
- 2026-04-20: Investigated where a future pre-ingestion memory gate should live.
  - Root conversation ingestion currently happens through live post-turn extraction and manual `Backfill`; OMF import and panel edits are explicit storage writes, not chat-session extraction.
  - Live extraction runs after successful `sendMessage()` / `regenerateResponse()` completions while the global memory feature is enabled, re-reads the normalized session, and calls `memoryBridge.ingestMessages(...)` regardless of the chat-vs-memory mode toggle.
  - `memoryProcessedAt` is written after live extraction but only consulted by manual backfill; live dedupe is limited to `memoryExtractionInFlight`.
  - Keep semantic "is this worth remembering?" policy in `nanomem`. Root `oa-chat` should only handle session/UI dedupe such as "did a new user turn appear since the last ingest?"
  - `nanomem` still has no semantic pre-gate or ingest-side progress/decision event, and a no-write tool loop returns `status: 'processed'` with `writeCalls: 0`.
- 2026-04-18: Root memory backfill now runs newest-first and can be stopped mid-run.
  - `chat/components/MemoryEditor.js` now sorts backfill candidates by `updatedAt` / `createdAt` descending before calling `nanomem.importData(...)`, so the freshest chats are processed first.
  - The memory-panel `Backfill` button is now a stop control while the run is active. Clicking it aborts the in-flight confidential import request instead of waiting for the entire batch to finish.
  - Closing the memory panel no longer stops that run. `ChatApp` keeps a single long-lived `MemoryEditor` instance, so the current backfill state/controller stay on that object while the modal is hidden.
  - Abort now threads through `nanomem`'s import loop, ingestion tool loop, and OpenAI-compatible fetch client. This is currently used by root backfill; completed chats still get `memoryProcessedAt`, while the interrupted current chat stays eligible for the next resume run.
  - Root now persists `memoryProcessedAt` on each successful/skipped item completion instead of waiting for the entire backfill call to return. That way, if the user stops and immediately starts backfill again, already-finished chats are skipped on the next candidate scan.
  - Root backfill no longer relies on one confidential key for the whole batch. It now ensures a valid key before each chat import, and if a chat fails with `401` / `403`, it invalidates that key, redeems a fresh one when tickets remain, and retries that same chat once before stopping the run.
- 2026-04-13: Dev startup now hard-requires the `nanomem` submodule, not just production build.
  - `npm run dev` now runs the same submodule init step as build before launching `python3 -m http.server -d chat`.
  - This avoids the misleading browser-side `GET /nanomem/browser.js 404` that happened when `chat/nanomem` still pointed at an uninitialized empty submodule directory.
  - If a local clone does not include submodule contents, dev should now fail immediately at startup and point the user at submodule setup instead of looking like an asset-path bug.
- 2026-04-10: Root `oa-chat` now has a browser-only memory mode wired through the `nanomem` submodule.
  - Read [MEMORY_MODE.md](MEMORY_MODE.md) before touching this path.
  - The app-side contract is `chat/app.js -> chat/services/memoryBridge.js -> chat/nanomem/browser.js`; do not import `nanomem/src/...` from app code.
  - `chat/nanomem` is a tracked symlink and production build now hard-requires the `nanomem` submodule. If the bundle suddenly starts failing on `node:*` imports from `nanomem`, check that the browser entry is still pointing at `nanomem/src/browser.js`, not the generic index.
  - Memory mode is a global toggle persisted in IndexedDB setting `memoryMode`, not a per-session mode.
  - Memory mode now also persists `memoryAutoInclude` and `memoryAgentModel`. The first short-circuits the in-chat approval wait, and the second is used by both live retrieval and memory backfill/import.
  - The retrieval summary is a local-only assistant message with an agent trace and explicit include/skip controls. Regeneration clears older local-only memory status messages after the last user turn before rerunning retrieval.
  - The pending approval row now has `Include memory`, `Always include`, `Skip`, and `Edit prompt`. After memory is approved/sent, the revised prompt remains visible in the local status message, so the approved row only shows the status chip and omits a separate view/edit button. `Always include` is not just a one-shot approve: it flips the global `memoryAutoInclude` setting on and the settings-menu switch should reflect that immediately.
  - Confidential retrieval keys are cached per session on `memoryKey` / `memoryKeyInfo` and must be invalidated on `401` / `403` auth failures.
  - Root `oa-chat` currently does not use that attested SDK path for memory mode. `chat/services/memoryBridge.js` intentionally forces the confidential memory client onto the plain OpenAI-compatible HTTPS path against `https://inference.tinfoil.sh/v1` (`provider: 'openai'`, not `provider: 'tinfoil'`).
  - `nanomem` still supports the SDK-backed, attested Tinfoil transport, but the root app is not opting into it right now.
  - The generic root-app fallback text `Memory context was not added this time. Sending without it.` logs the underlying exception to the browser console as `Memory augment query failed:`. Check that before assuming the failure is in the retrieval prompt itself.
  - Root `oa-chat` now also has the memory filesystem modal shell from `memory-chat`, opened by `Cmd/Ctrl+Shift+M`. Storage editing and local-chat backfill are ported there, but the old `memory-chat` extractor/cancel UI is still not.
  - The settings menu `Data Controls` section now has a dedicated `Memory` row. `Export` uses the same OMF exporter as the memory panel header. `Import` uses a hidden settings-menu file input, then opens the memory panel and hands the selected file into the same OMF preview/merge flow as the panel header import button.
  - The root memory panel now also uses `memory-chat`'s OMF import/export UX, but the actual OMF logic has been moved into `nanomem`. `Export` now goes through `memoryBank.exportOmf()`, and import preview/merge go through `memoryBank.previewOmfImport()` / `memoryBank.importOmf()` instead of app-local format logic.
  - The canonical OMF format doc now lives in [nanomem/docs/omf.md](../nanomem/docs/omf.md). If OMF behavior changes, update that spec in the same change as the implementation.
  - Root `oa-chat` memory backfill is now a real `nanomem` import flow. The `Backfill` button gathers local chat sessions, normalizes them into `{ title, messages, updatedAt }`, and sends them through `nanomem.importData(...)` over the confidential memory key path instead of using a root-app extractor.
  - Backfill progress in root is intentionally light-touch: the header button turns into a stop control while it runs, and completion/stop/error is reported via toast. There is still no separate queue modal.
  - Backfill uses `session.memoryProcessedAt` to skip chats whose `updatedAt` has not changed since the last successful import. If a user reports repeated full re-imports, inspect whether `memoryProcessedAt` is getting saved on the session records.
  - Backfill/import now retries transient confidential-model transport failures inside `nanomem`'s OpenAI-compatible client before an item is marked failed. The current policy is 3 attempts total for network errors plus `408/429/5xx`, with `Retry-After` respected for `429`.
  - Failed backfill items still do not set `memoryProcessedAt`, so even after in-run retries are exhausted they remain eligible for the next manual backfill run.
  - Backfill input must exclude local-only memory-agent status messages (`message.isLocalOnly` / `message.model === 'memory agent'`) and should prefer restored scrubber content when available before falling back to plain message text.
  - The memory agent receives recent in-session conversation text on every run. `chat/app.js` builds it from all non-local-only messages in the current session, then `nanomem` trims it to about 2k chars for outer retrieval and about 3k chars for the inner prompt crafter.
  - That trim is now turn-aware, not a blind tail slice. Long assistant answers are clipped before older user turns, so follow-up retrieval is less likely to lose the previous user question while keeping the most recent turn.
  - Root `oa-chat` now runs background memory extraction after every successful assistant response in both normal chat mode and memory mode. Explicit actions such as `Backfill`, `Import`, or direct memory editing still use the same `nanomem` write path, but the post-turn extractor is no longer gated on the mode toggle.
  - The memory-agent model selector in settings is populated from the confidential model list. The allowed list is currently `kimi-k2-5`, `gpt-oss-120b`, `gpt-oss-safeguard-120b`, `llama3-3-70b`, and `gemma4-31b`. `gemma4-31b` is now the default memory-agent model. `kimi-k2-5` remains allowed and is still the only one marked slow.
  - Root `oa-chat` now mirrors `memory-chat`'s post-response extraction pattern after every successful assistant response while the global memory feature is enabled, regardless of whether the session is currently in chat mode or memory mode. The app kicks off a non-blocking background `nanomem.ingest(...)` run for the current session.
  - That live extraction path uses the same normalized message filter as backfill: local-only messages and `memory agent` status messages are excluded, and scrubber-restored text is preferred over raw stored content when available.
  - The chat controller does not implement a separate extractor. It only orchestrates `ensureMemoryKey(...)` plus `memoryBridge.ingestMessages(...)`; the actual extraction prompt/tools remain inside `nanomem`.
  - Unlike backfill, live post-turn extraction does not skip on `memoryProcessedAt`. This is intentional so regenerations and repeated assistant completions can still re-run extraction if needed. The only dedupe is an in-flight session guard.
  - The memory prompt viewer is no longer the simplified review/API modal. It now uses the same tagged prompt editor/viewer pattern as `memory-chat` (`showTaggedPromptEditor` / `showCiPromptEditor`) and persists edits in `message.ciPromptDraft.editedFullPrompt`.
  - `ciPromptDraft` in root is now a flat prompt shape: `fullPrompt`, optional `editedFullPrompt`, `status`, `linkedUserMessageId`, and `memoryFiles`. `apiPrompt` may still exist as a cached original result, but approval should derive the final send payload from the edited/full prompt via the bridge seam.
  - `nanomem` augment mode now executes `augment_query` as a real tool. The outer retrieval loop only selects files and calls `augment_query(user_query, memory_files)`. A separate prompt-crafter call inside `nanomem` then turns those inputs directly into the final `reviewPrompt`/`apiPrompt`.
  - The inner prompt-crafter prompt is now modeled on `memory-chat`'s later `ciPromptCrafter` flow, not the older "outer retrieval LLM drafts the final prompt" design. The key privacy rule is stronger minimization: names, relationship labels, and locations should be omitted unless the task truly needs them.
  - The crafter should omit generic background facts that only confirm what the current query already makes obvious. Memory should only survive minimization when it changes the answer through real constraints, tradeoffs, personalization, or disambiguation.
  - The inner `augment_query` prompt-crafter no longer sends a forced `max_tokens` cap. It now relies on the provider default and retries empty / invalid / task-less model outputs up to 3 total attempts before surfacing an error.
  - If the final crafted `reviewPrompt` contains no `[[user_data]]` tags, `nanomem` now treats that as "no personal context actually used" and returns a no-memory result instead of surfacing a redundant review prompt.
  - That inner crafter call is now streaming when the provider supports it, but the visible trace only shows coarse phase updates such as prompt-crafting / minimization / finalization. Raw inner prompt-crafter chain-of-thought should not be forwarded into the user-visible memory-agent trace.
  - There is currently no app-imposed timeout on that non-streaming crafter request. If it fails fast, look for transport/model issues or empty-output behavior, not a short client timeout.
  - Because of that change, the memory-agent trace should now show `augment_query(user_query: "...", memory_files: [...])` instead of exposing the already-crafted final prompt in the outer tool-call arguments.
  - `augment_query` is also allowed to finish with `memory_files: []` when nothing relevant exists. That should render as a benign no-memory outcome in the trace, not an executor error.
  - Memory-agent tool rows must render as soon as the LLM emits the tool call, not after executor completion. `nanomem` now emits `started` and `finished` tool events from the tool loop, and `chat/app.js` upserts trace rows by `toolCallId` so the same row transitions directly from a live running state to the final result without an extra inline `working...` / `running...` result line.
  - `nanomem` retrieval now resolves `read_file(...)` through a separator/punctuation-tolerant fallback before declaring `File not found`. This specifically covers model-generated path variants like swapping spaces / `-` / `_`, dropping `./`, or changing slash style.
  - `retrieve_file` path matching now uses the same normalized comparison and skips unreadable/path-only records, so discovery and `read_file` are less likely to disagree on whether a file exists.
  - `nanomem` now canonicalizes resolved memory paths before returning them from retrieval/augment flows. If the model emits a weird-but-resolvable path wrapper like `<|"|personal/family.md<|"|`, the storage layer may still resolve it, but the UI/returned `files` list should now show the real canonical path (`personal/family.md`) instead of the raw malformed tool arg.
  - Augment-mode progress must not blindly claim `augment_query` succeeded. If the executor returns JSON `{ error: ... }`, surface that error text in the Memory Agent trace instead of a fake “crafted augmented prompt…” status.
  - Memory-agent assistant messages are identified by `message.model === 'memory agent'`. The header is intentionally custom: inline book icon, `Memory Agent` label, and a non-hover-fading timestamp to avoid header flash during trace refreshes.
- 2026-03-22: Welcome-panel Turnstile for free preview is now intentionally lazy and single-submit.
  - The Cloudflare script/widget should not load on modal open. Warmup now starts on the first meaningful preview-email edit, not on initial render or invite-code mode.
  - Interactive Turnstile UI remains submit-gated: typing may load/render the invisible widget, but the challenge bubble should only open once the user actually submits the free-preview form.
  - While Turnstile verification is in flight, the welcome access-mode toggle, access input, submit button, and import/invite actions are locked in place. This prevents the validated email snapshot from drifting before `/chat/free_access` is posted.
  - Free-preview submission must use the locally validated email snapshot captured before `requestToken()`, not `this.previewEmail` after async waits.
  - `TurnstileBubble.destroy()` should clean up only its own widget/script DOM. Do not delete `window.turnstile` or globally remove Cloudflare iframes from the page.
- 2026-03-14: Mid-stream message actions are intentionally split between snapshot-safe actions and active-session mutations.
  - Safe actions that should keep working during streaming are copy actions and `forkConversation()`.
  - Assistant/user copy should prefer the live DOM for the actively streaming message because IndexedDB saves lag the UI by design during token streaming.
  - Code-block copy now hooks on `pointerdown` for streaming content so rapid DOM replacement does not eat the click before the handler runs.
  - Streaming code-block updates must patch the existing `.code-block-wrapper` in place; replacing the whole message HTML while the model is still appending code makes the hovered copy button flicker and drops transient copy-feedback state.
  - Forking during streaming must clone a static snapshot of each copied assistant message and clear `streamingPending`, `streamingPhase`, `streamingReasoning`, and `streamingTokens`; otherwise the new session can inherit a fake "still streaming" placeholder.
  - Timeline-mutating actions that intentionally restart generation (`edit`, `resend`, `regenerate`) should interrupt the current stream first, wait for abort cleanup to finish, then apply their normal truncate-and-regenerate behavior.
  - `Edit prompt` is side-effect free until confirm/send. Opening the editor during streaming must not stop the in-flight response; only confirming a non-empty edit should interrupt the stream and regenerate.
- 2026-03-14: The welcome-panel access-mode segmented control must position its indicator with layout-space metrics (`offsetLeft` / `offsetWidth`), not `getBoundingClientRect()`.
  - The welcome dialog is scaled down on narrow/mobile viewports with `transform: scale(...)`.
  - Measuring the active button with `getBoundingClientRect()` inside that transformed dialog returned already-scaled pixels, which made the indicator too narrow and horizontally offset only on mobile.
  - `WelcomePanel` now resyncs that indicator via `ResizeObserver` so late font/layout settling does not leave the selected pill misaligned.
- 2026-03-12: Inline citation styling must not run as a global regex over rendered HTML.
  - Replacing `[\d+]` across the full HTML string corrupted code blocks when code contained array indexing like `choices?.[0]`.
  - The breakage was especially severe because the same pattern appeared inside the code block copy button's `data-code` attribute, which malformed the header DOM and produced bogus code-block titles.
  - `addInlineCitationMarkers()` now traverses DOM text nodes and skips `pre`, `code`, `a`, `button`, and other non-prose containers so only real prose markers become clickable citations.
- 2026-03-12: Fenced code block headers should only use the first token from the Markdown info string.
  - `marked` exposes the full fence info string, not just the language token.
  - The custom renderer now trims to the first non-whitespace token and escapes it before using it in the visible label or `language-*` class, which avoids titles/classes ballooning when extra fence metadata or malformed text appears.
- 2026-03-08: Established this file as the canonical handoff log for ongoing web-app
  state. Future agents should read it before UI-heavy work and update it after learning
  something that is not obvious from the code alone.
- 2026-03-09: Assistant streaming/pending UI now has an explicit two-phase placeholder
  model coordinated across `chat/app.js`, `chat/api.js`, `chat/components/ChatArea.js`,
  `chat/components/MessageTemplates.js`, and `chat/services/networkLogRenderer.js`.
  The phases are:
  - `requesting-key`: The session is actively redeeming tickets for a fresh access token.
  - `waiting-response`: The access token is ready and the app is waiting for reasoning or
    response output to begin.
- 2026-03-09: Pending copy is semantic, not purely cosmetic.
  - Show `Requesting ephemeral key` only when the session actually needs a new or renewed
    access token (`!getAccessToken(session)` or `isAccessExpired(session)`).
  - If the session already has a valid access token, start directly at `Waiting for response`.
  - If the session starts without access, flip to `Waiting for response` when key redemption
    succeeds, at the same boundary that produces the `Ephemeral access key granted` activity.
    Do not wait for the first streamed token, because some providers emit reasoning or answer
    tokens immediately and otherwise make key acquisition look slower than it was.
- 2026-03-09: `Response stream open` in the activity timeline intentionally means
  "HTTP/SSE stream established", not "visible output rendered". Keep this separate from the
  pending placeholder semantics in chat: the label should already be `Waiting for response`
  once access is granted, so the later stream-open event must not visually reset the shimmer.
- 2026-03-09: Avoid DOM replacement during pending-state phase changes.
  - Updating the standalone placeholder by replacing the whole node caused visible header
    flashes and restarted the shimmer.
  - `updateTypingIndicator()` now mutates the existing label in place and no-ops if the
    phase is unchanged.
  - The first real assistant message must replace the existing pending placeholder in place
    via `ChatArea.appendMessage()` rather than removing the placeholder and appending a new
    node, otherwise the header visibly repaints.
- 2026-03-09: Bottom-of-viewport spacing is easy to regress in the assistant pending flow.
  - The standalone placeholder and the streamed assistant message must reserve the same
    bottom footprint as a reasoning-only assistant message.
  - `typingWrapper` was trimmed to match the assistant wrapper, and the pending states now
    include the same invisible action-row spacer used by reasoning-only messages.
  - If you tweak pending copy/layout again, compare three cases at the bottom of the screen:
    `Requesting ephemeral key`, `Waiting for response`, and reasoning-trace-only streaming.
- 2026-03-09: Assistant toolbar buttons (copy/regenerate/fork) are intentionally hidden
  while a response is still in reasoning-only streaming and no actual output tokens/images
  exist yet.
  - The buttons are not reliably actionable during pure reasoning streaming anyway.
  - A placeholder row is kept in the layout to avoid a jump when the buttons appear once
    actual output content starts.
  - Any stream-time DOM insertion that adds text/images before final re-render must target
    the shared action-row anchor, not only the real toolbar row. Otherwise the placeholder
    stays above the new content and creates a temporary gap between the reasoning trace and
    the streaming answer until completion.
- 2026-03-09: Pending shimmer styling is intentionally distinct from the reasoning-trace
  shimmer.
  - Pending labels use a dimmer muted-gray shimmer so they read as pre-output status, not
    as actual reasoning content.
  - Both `Requesting ephemeral key` and `Waiting for response` share the same shimmer effect.
- 2026-03-09: Production build cache-busting matters for pending-state UI correctness.
  - JS entry bundles were already hash-versioned, but `index.html` also references shared
    local CSS/vendor assets that can otherwise remain stale in browser cache.
  - `scripts/build.mjs` now appends the current build hash as `?v=<hash>` to local
    `link[href]` and `script[src]` references in `dist/index.html` so fresh JS does not run
    against stale shared CSS.
  - If users report "the pending UI looks wrong only in one browser" after deploy, inspect
    the built `index.html` first and confirm the versioned asset refs are present.
- 2026-03-14: Android background-streaming support now lives at the transport seam in
  `chat/api.js`, not in the chat controller.
  - `oa-chat` still builds the OpenRouter request body and still parses SSE lines into
    reasoning/content/image/token updates.
  - On Android WebView only, `chat/services/androidNativeInferenceTransport.js` can hand the
    live HTTP/SSE call to native code and poll buffered raw SSE lines back into the existing
    parser.
  - This keeps pending/reasoning/content UI behavior aligned with web/desktop because the
    parser and message-update path remain in JS.
- 2026-03-14: Launcher resume matters for Android background streams.
  - The native transport alone is not enough if the Android shell force-reloads the page on
    launcher re-entry.
  - `MainActivity` now preserves the current page when a `singleTask` launcher intent has no
    deep-link URL, so the in-flight JS promise/state survive Home -> launcher reopen.
