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
