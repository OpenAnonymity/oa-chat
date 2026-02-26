# Repository Guidelines

## Privacy Model (read this first for audits)

Before exploring the codebase, read [docs/PRIVACY_MODEL.md](docs/PRIVACY_MODEL.md) for
the full unlinkability model and threat analysis. The core guarantee: **no party can link
a user's identity to their inference activity, even if any OA component is malicious.**
The org backend being closed-source does not affect this -- blinding runs client-side and
no OA system sees prompts or responses. See also the blog post:
[Unlinkable Inference as a User Privacy Architecture](https://openanonymity.ai/blog/unlinkable-inference/).

## Project Structure & Module Organization
The app runs entirely in the browser and is organized as ES modules:

- `index.html`: Boots the app and pre-applies theme/right-panel visibility to avoid FOUC.
  - Uses `<base href="/">` to resolve all relative paths.
  - Loads local vendor assets: Marked, KaTeX (+ auto-render + fonts), Highlight.js, libcurl.js (lazy for proxy), hash-wasm, and html2pdf.
  - Uses a precompiled Tailwind stylesheet (`tailwind.generated.css`).
  - Prerenders the empty state via `prelude.js`, then loads `app.js`.
- `app.js`: Main controller (`ChatApp`).
  - Orchestrates state (sessions/models/streaming), DOM refs, component lifecycle, keyboard shortcuts, reliable auto-scroll, and session/message CRUD via `chatDB`.
  - Handles file uploads + multimodal conversion, search toggle/wide mode persistence, delete-history modal, PDF export, and link-preview/citation enrichment.
  - Streams completions with token updates, reasoning traces, and citations; initializes the network proxy and station verifier via the inference backend abstraction.
- `api.js`: OpenRouter client used by the inference backend layer.
  - Fetches models (with categorization + display name overrides), sends and streams chat completions (SSE), supports multimodal content, reasoning traces, and web-search citations.
  - Routes requests through `services/networkProxy.js` with fallback confirmation; logs requests via `services/networkLogger.js`. Provides offline fallbacks.
- `db.js`: IndexedDB (`ChatDatabase`) for persistent local data.
  - Stores `sessions`, `messages`, and `settings` (search/reasoning toggles, verifier broadcast cache). A `networkLogs` store exists but persistence is disabled (logs are memory-only this release). Exposes a `chatDB` singleton for module imports and legacy globals.
- `components/`:
  - `Sidebar.js`: Renders/grouped sessions, search UI, and session actions.
  - `ChatArea.js`: Renders message list, LaTeX, incremental streaming updates, reasoning traces, citations, and empty-state with export.
  - `ChatInput.js`: Textarea autosize, send/stop controls, settings menu, theme controls, search toggle persistence, and input UX.
  - `ModelPicker.js`: Modal with fuzzy search, pinned/disabled model section, session/pending model selection.
  - `MessageTemplates.js`: Pure HTML builders for user/assistant bubbles, reasoning trace UI, citations/link previews, typing indicator, empty state, and provider icon integration.
  - `MessageNavigation.js`: Vertical mini-timeline of assistant messages with arrow-key navigation and previews.
  - `RightPanel.js`: Ticket + API key panel, proxy controls + TLS security, activity timeline (memory-only logs), and responsive visibility.
  - `FloatingPanel.js`: Lightweight activity bubble (feature currently disabled by default).
  - `ProxyInfoModal.js`: Explains the network proxy and encrypted relay flow.
  - `TLSSecurityModal.js`: Displays TLS/libcurl integrity info and live proxy connection details.
- `services/`:
  - `inference/`: Backend abstraction for access issuance, inference calls, TLS capture hints, and sharing metadata.
    - `inferenceService.js`: Registry + adapter to route access/streaming/verification based on session backend.
    - `backends/openRouterBackend.js`: OpenRouter implementation (default backend).
    - `backends/enclaveStationBackend.js`: Stub for enclaved station session-based backend.
    - `backends/providerDirectBackend.js`: Stub for provider-direct ephemeral token backend.
    - `transportHints.js`: TLS capture configuration for `networkProxy`.
  - `networkProxy.js`: Encrypted WebSocket proxy using libcurl.js/mbedTLS, TLS inspection, settings persistence, and fallback-to-direct handling.
  - `verifier.js`: Station verification broadcast polling, staleness tracking, and cached verifier data in IndexedDB.
  - `modelConfig.js`: Pinned/disabled model availability from org API (with localStorage cache) plus display-name overrides.
  - `reasoningParser.js`: Normalizes reasoning traces for streaming/final rendering.
  - `urlMetadata.js`: Fetches/caches URL metadata for citations and inline link previews.
  - `pdfExport.js`: HTML-to-PDF export (lazy-loads html2pdf.js).
  - `networkLogger.js`: In-memory log aggregator with session tagging and safe header masking.
  - `networkLogRenderer.js`: Shared description/icon/formatting helpers for logs and minimal views.
  - `apiKeyStore.js`: LocalStorage-backed legacy access store (`oa_access_key_data`).
  - `fileUtils.js`: Validation (10MB cap), type detection, base64, multimodal conversion, and local export of chats/tickets.
  - `privacyPass.js`: Privacy Pass/cryptographic helpers (pure JS via @cloudflare/privacypass-ts) for ticket flows.
  - `ticketClient.js`: Ticket lifecycle and access issuance (`alphaRegister`, `requestApiKey`), integrates with Privacy Pass artifacts and proxy fallback.
  - `providerIcons.js`: Maps provider names to icons under `img/`.
  - `themeManager.js`: System/light/dark preference management with pre-hydration application.
- `vendor/privacypass-ts.js`: Bundled `@cloudflare/privacypass-ts` (Apache-2.0, pure JS) for blind signature operations.
- `styles.css`: Design tokens synced with Tailwind config, prose formatting, reasoning/citation styles, proxy modals, message navigation styling, scroll behaviors, wide mode, and responsive states.
- `tailwind.config.js`: Tailwind CLI configuration (root).
- `tailwind.input.css` / `tailwind.generated.css`: Tailwind build input/output.
- `vendor/`: Self-hosted third-party JS/CSS (Marked, KaTeX, Highlight.js, libcurl.js, hash-wasm, html2pdf).
- `fonts/`: Self-hosted Google Fonts (`fonts.css` + WOFF2 files). Managed by `scripts/sync-fonts.mjs`.
- `img/`: Provider and app icons.
- `README.md`: Project overview and quick-start guide.

## Build, Test, and Development Commands
The app is still HTML-first for development, but production builds are bundled with esbuild and minified with terser.

Local development (no build step required):
```bash
npm run dev
# visit http://localhost:8080
```

Production build + local preview:
```bash
npm run build      # outputs dist with hashed bundles
npm run preview    # serve dist on http://localhost:8080
```

The app uses a `<base href="/">` tag to resolve all relative asset paths. Keep the tab's devtools open; console warnings often highlight integration issues early.

Tailwind and font helper commands:
```bash
npm run tailwind:build   # build chat/tailwind.generated.css
npm run tailwind:watch   # rebuild Tailwind on file changes
npm run fonts:sync       # sync Google Fonts into chat/fonts (optional URL arg)
```

## Coding Style & Naming Conventions
- ES modules, 4-space indentation, trailing semicolons.
- Prefer `const`/`let`; class components in PascalCase; methods/helpers in camelCase.
- Use relative paths for all assets (resolved via `<base href="/">` in `index.html`). Never hardcode absolute paths in asset URLs.
- Reuse Tailwind utility patterns established in `index.html`; put tweaks in `styles.css` with concise rationale.
- Update `tailwind.generated.css` via `npm run tailwind:build` after changes to Tailwind config or classes.
- Manage Google Fonts via `npm run fonts:sync` instead of manual edits in `chat/fonts`.
- Persisted data goes through `chatDB` in `db.js`; follow existing object store patterns and keep transactions minimal and readable.
- Keep code small and modular; avoid duplicating functionality already encapsulated in components/services.

## Testing Guidelines
There is no automated test harness yet. Manually verify:
- Sessions: create/switch/delete; titles auto-generate on first user message; `updatedAt` ordering in `Sidebar`; delete history modal.
- Messages: Markdown + LaTeX rendering (block/inline); streaming updates; token counts finalize; reasoning trace streaming/final rendering; citations + inline link previews; reliable auto-scroll.
- Model selection: modal open/close, fuzzy search, pinned/disabled section, selection for both pending (no session yet) and active session.
- Input: send/stop behavior, autosize, file upload previews (image/pdf/audio/text), error toasts for invalid files, undo file paste, search toggle persistence.
- PDF export: export current session to PDF and confirm styles render.
- Right panel: ticket registration, ticket visualization, key request, expiry countdown, renew/remove, proxy toggle + TLS security modal, fallback confirmation, and activity timeline updates.
- Network logging: entries appear with safe header masking; memory-only (fresh each tab).
- Theme & layout: system/light/dark selection persists and applies pre-hydration; highlight.js theme sync; wide mode toggle persistence; right panel visibility persistence.
- IndexedDB: sessions/messages/settings integrity through reloads; verifier broadcast cache and settings toggles; ensure no uncaught console errors.
- Ticket/privacy flows and proxy: exercise both success and error paths; show clear UI feedback and recover gracefully.

## Commit & Pull Request Guidelines
Existing commits use short, present-tense descriptions (e.g. “changes in UI, activity, latex fix”). Follow that tone, keep the first line under ~70 characters, and group related changes together. Pull requests should include: a concise summary of the user-facing impact, screenshots or gifs for UI updates, notes on manual testing performed, and references to any related issues or discussions.

## API Keys & Security
- Keys/tokens are ephemeral and acquired unlinkably via ticket redemption (`services/ticketClient.js` + Privacy Pass). Do not hard-code keys.
- Active access data lives in session state; legacy access data may exist in LocalStorage (`oa_access_key_data`). Inference tickets are stored in LocalStorage (`inference_tickets`) and can be exported via `services/fileUtils.js`.
- Network proxy traffic uses libcurl.js/mbedTLS to tunnel TLS over WebSocket; fallback to direct requests requires explicit user confirmation.
- Do not log secrets. When instrumenting requests, route through `services/networkLogger.js` and rely on `sanitizeHeaders` (Authorization masking).
- All prompts/responses are sent directly from the browser to the selected inference backend using the user’s ephemeral access credential; Open Anonymity infrastructure only handles ticketing and access issuance.
- When adding providers/integrations, implement a backend in `services/inference/backends/`, route through `inferenceService`, and document any required manual steps in the PR.

## Storage Hardening Notes
- The app now requests persistent storage (`navigator.storage.persist`) and stores chats/tickets/preferences in IndexedDB; caches may still use localStorage.
- If you need strict “no third-party script access to data,” self-host all JS/CSS assets and add a CSP that only allows `script-src 'self'` (analytics should be removed or sandboxed).
- Data growth is currently acceptable (5k+ sessions verified); future improvements could include session/message compaction, optional archive buckets, and quota telemetry via `navigator.storage.estimate()`.

## Notes & Shortcuts
- Keyboard shortcuts:
  - ⌘/ new chat, ⌘K model picker, ⌘⇧F focus session search, Esc closes modals/menus.
  - ⌘⇧C copy latest assistant markdown (temporarily disabled), ⌘⇧⌫ clear chat (temporarily disabled).
- Right panel visibility is persisted in `localStorage` (`oa-right-panel-visible`); theme preference in `localStorage` (`oa-theme-preference`); wide mode in `localStorage` (`oa-wide-mode`); proxy settings in `localStorage` (`oa-network-proxy-settings`).
- Network logs are memory-only (tab-scoped) in this release to keep storage small and predictable.
