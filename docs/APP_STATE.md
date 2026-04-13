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

- 2026-04-10: Root `oa-chat` now has a browser-only memory mode wired through the `nanomem` submodule.
  - Read [MEMORY_MODE.md](MEMORY_MODE.md) before touching this path.
  - The app-side contract is `chat/app.js -> chat/services/memoryBridge.js -> chat/nanomem/browser.js`; do not import `nanomem/src/...` from app code.
  - `chat/nanomem` is a tracked symlink and production build now hard-requires the `nanomem` submodule. If the bundle suddenly starts failing on `node:*` imports from `nanomem`, check that the browser entry is still pointing at `nanomem/src/browser.js`, not the generic index.
  - Memory mode is a global toggle persisted in IndexedDB setting `memoryMode`, not a per-session mode.
  - Memory mode now also persists `memoryAutoInclude` and `memoryAgentModel`. The first short-circuits the in-chat approval wait, and the second is used by both live retrieval and memory backfill/import.
  - The retrieval summary is a local-only assistant message with an agent trace and explicit include/skip controls. Regeneration clears older local-only memory status messages after the last user turn before rerunning retrieval.
  - The approval row now has `Include memory`, `Always include`, `Skip`, and `View prompt`. `Always include` is not just a one-shot approve: it flips the global `memoryAutoInclude` setting on and the settings-menu switch should reflect that immediately.
  - Confidential retrieval keys are cached per session on `memoryKey` / `memoryKeyInfo` and must be invalidated on `401` / `403` auth failures.
  - Root `oa-chat` currently does not use that attested SDK path for memory mode. `chat/services/memoryBridge.js` intentionally forces the confidential memory client onto the plain OpenAI-compatible HTTPS path against `https://inference.tinfoil.sh/v1` (`provider: 'openai'`, not `provider: 'tinfoil'`).
  - `nanomem` still supports the SDK-backed, attested Tinfoil transport, but the root app is not opting into it right now.
  - The generic root-app fallback text `Memory retrieval unavailable. Sending without personal context.` now logs the underlying exception to the browser console as `Memory augment query failed:`. Check that before assuming the failure is in the retrieval prompt itself.
  - Root `oa-chat` now also has the memory filesystem modal shell from `memory-chat`, opened by `Cmd/Ctrl+Shift+M`. Storage editing and local-chat backfill are ported there, but the old `memory-chat` extractor/cancel UI is still not.
  - The settings menu `Data Controls` section now has a dedicated `Memory` row. `Export` uses the same OMF exporter as the memory panel header. `Import` uses a hidden settings-menu file input, then opens the memory panel and hands the selected file into the same OMF preview/merge flow as the panel header import button.
  - The root memory panel now also uses `memory-chat`'s OMF import/export UX, but the actual OMF logic has been moved into `nanomem`. `Export` now goes through `memoryBank.exportOmf()`, and import preview/merge go through `memoryBank.previewOmfImport()` / `memoryBank.importOmf()` instead of app-local format logic.
  - The canonical OMF format doc now lives in [nanomem/docs/omf.md](../nanomem/docs/omf.md). If OMF behavior changes, update that spec in the same change as the implementation.
  - Root `oa-chat` memory backfill is now a real `nanomem` import flow. The `Backfill` button gathers local chat sessions, normalizes them into `{ title, messages, updatedAt }`, and sends them through `nanomem.importData(...)` over the confidential memory key path instead of using a root-app extractor.
  - Backfill progress in root is intentionally light-touch: the header button flips to `n/total` while it runs, and completion/error is reported via toast. There is no cancel flow yet.
  - Backfill uses `session.memoryProcessedAt` to skip chats whose `updatedAt` has not changed since the last successful import. If a user reports repeated full re-imports, inspect whether `memoryProcessedAt` is getting saved on the session records.
  - Backfill/import now retries transient confidential-model transport failures inside `nanomem`'s OpenAI-compatible client before an item is marked failed. The current policy is 3 attempts total for network errors plus `408/429/5xx`, with `Retry-After` respected for `429`.
  - Failed backfill items still do not set `memoryProcessedAt`, so even after in-run retries are exhausted they remain eligible for the next manual backfill run.
  - Backfill input must exclude local-only memory-agent status messages (`message.isLocalOnly` / `message.model === 'memory agent'`) and should prefer restored scrubber content when available before falling back to plain message text.
  - The memory agent receives recent in-session conversation text on every run. `chat/app.js` builds it from all non-local-only messages in the current session, then `nanomem` trims it to about 2k chars for outer retrieval and about 3k chars for the inner prompt crafter.
  - That trim is now turn-aware, not a blind tail slice. Long assistant answers are clipped before older user turns, so follow-up retrieval is less likely to lose the previous user question while keeping the most recent turn.
  - Root `oa-chat` now runs background memory extraction after every successful assistant response in both normal chat mode and memory mode. Explicit actions such as `Backfill`, `Import`, or direct memory editing still use the same `nanomem` write path, but the post-turn extractor is no longer gated on the mode toggle.
  - The memory-agent model selector in settings is populated from the confidential model list. The allowed list is currently `kimi-k2-5`, `gpt-oss-120b`, `gpt-oss-safeguard-120b`, `llama3-3-70b`, and `gemma4-31b`. `gemma4-31b` is now the default memory-agent model. `kimi-k2-5` remains allowed and is still the only one marked slow.
  - Root `oa-chat` now mirrors `memory-chat`'s post-response extraction pattern after every successful assistant response, regardless of whether the session is currently in chat mode or memory mode. The app kicks off a non-blocking background `nanomem.ingest(...)` run for the current session.
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
