# Repository Guidelines

## Project Structure & Module Organization
The app runs entirely in the browser and is organized as ES modules:

- `index.html`: Boots the app and pre-applies theme/right-panel visibility to avoid FOUC.
  - Uses `<base href="/chat/">` to resolve all relative paths for deployment flexibility.
  - Loads CDNs: Tailwind, Marked, KaTeX (+ auto-render), Highlight.js, libcurl.js (lazy for proxy), and Vercel analytics.
  - Prerenders the empty state via `components/MessageTemplates.js`, then loads `db.js` and `app.js`.
- `app.js`: Main controller (`ChatApp`).
  - Orchestrates state (sessions/models/streaming), DOM refs, component lifecycle, keyboard shortcuts, reliable auto-scroll, and session/message CRUD via `chatDB`.
  - Handles file uploads + multimodal conversion, search toggle/wide mode persistence, delete-history modal, PDF export, and link-preview/citation enrichment.
  - Streams completions with token updates, reasoning traces, and citations; initializes the network proxy and station verifier.
- `api.js`: OpenRouter client.
  - Fetches models (with categorization + display name overrides), sends and streams chat completions (SSE), supports multimodal content, reasoning traces, and web-search citations.
  - Routes requests through `services/networkProxy.js` with fallback confirmation; logs requests via `services/networkLogger.js`. Provides offline fallbacks.
- `db.js`: IndexedDB (`ChatDatabase`) for persistent local data.
  - Stores `sessions`, `messages`, and `settings` (model config, search toggle, verifier broadcast cache). A `networkLogs` store exists but persistence is disabled (logs are memory-only this release). Exposes a `chatDB` singleton on `window`.
- `components/`:
  - `Sidebar.js`: Renders/grouped sessions, search UI, and session actions.
  - `ChatArea.js`: Renders message list, LaTeX, incremental streaming updates, reasoning traces, citations, and empty-state with export.
  - `ChatInput.js`: Textarea autosize, send/stop controls, settings menu, theme controls, search toggle persistence, and input UX.
  - `ModelPicker.js`: Modal with fuzzy search, pinned/blocked model section, session/pending model selection.
  - `MessageTemplates.js`: Pure HTML builders for user/assistant bubbles, reasoning trace UI, citations/link previews, typing indicator, empty state, and provider icon integration.
  - `MessageNavigation.js`: Vertical mini-timeline of assistant messages with arrow-key navigation and previews.
  - `RightPanel.js`: Ticket + API key panel, proxy controls + TLS security, activity timeline (memory-only logs), and responsive visibility.
  - `FloatingPanel.js`: Lightweight activity bubble (feature currently disabled by default).
  - `ProxyInfoModal.js`: Explains the inference proxy and encrypted relay flow.
  - `TLSSecurityModal.js`: Displays TLS/libcurl integrity info and live proxy connection details.
- `services/`:
  - `networkProxy.js`: Encrypted WebSocket proxy using libcurl.js/mbedTLS, TLS inspection, settings persistence, and fallback-to-direct handling.
  - `verifier.js`: Station verification broadcast polling, staleness tracking, and cached verifier data in IndexedDB.
  - `modelConfig.js`: Pinned/blocked model config and display-name overrides persisted in IndexedDB.
  - `reasoningParser.js`: Normalizes reasoning traces for streaming/final rendering.
  - `urlMetadata.js`: Fetches/caches URL metadata for citations and inline link previews.
  - `pdfExport.js`: HTML-to-PDF export (lazy-loads html2pdf.js).
  - `networkLogger.js`: In-memory log aggregator with session tagging and safe header masking.
  - `networkLogRenderer.js`: Shared description/icon/formatting helpers for logs and minimal views.
  - `apiKeyStore.js`: LocalStorage-backed key store (`openrouter_api_key_data`) with change events.
  - `fileUtils.js`: Validation (10MB cap), type detection, base64, multimodal conversion, and local export of chats/tickets.
  - `privacyPass.js`: Privacy Pass/cryptographic helpers (WASM-backed) for ticket flows.
  - `station.js`: Ticket lifecycle and API key issuance (`alphaRegister`, `requestApiKey`), integrates with Privacy Pass artifacts and proxy fallback.
  - `providerIcons.js`: Maps provider names to icons under `img/`.
  - `themeManager.js`: System/light/dark preference management with pre-hydration application.
- `wasm/`: WebAssembly artifacts for inference ticket/Privacy Pass operations (`oa_inference_ticket.js` + `.wasm`).
- `styles.css`: Design tokens synced with Tailwind config, prose formatting, reasoning/citation styles, proxy modals, message navigation styling, scroll behaviors, wide mode, and responsive states.
- `img/`: Provider and app icons.
- `README.md`: Legacy, not the source of truth for architecture; see this file.

## Build, Test, and Development Commands
No bundler is required. For local development, serve from the repo root:
```bash
python3 -m http.server 8080
# visit http://localhost:8080/chat
```
The app uses a `<base href="/chat/">` tag to resolve all relative asset paths, so always access via `/chat` path. Keep the tab's devtools open; console warnings often highlight integration issues early.

## Coding Style & Naming Conventions
- ES modules, 4-space indentation, trailing semicolons.
- Prefer `const`/`let`; class components in PascalCase; methods/helpers in camelCase.
- Use relative paths for all assets (resolved via `<base href="/chat/">` in `index.html`). Never hardcode `/chat/` in asset URLs.
- Reuse Tailwind utility patterns established in `index.html`; put tweaks in `styles.css` with concise rationale.
- Persisted data goes through `chatDB` in `db.js`; follow existing object store patterns and keep transactions minimal and readable.
- Keep code small and modular; avoid duplicating functionality already encapsulated in components/services.

## Testing Guidelines
There is no automated test harness yet. Manually verify:
- Sessions: create/switch/delete; titles auto-generate on first user message; `updatedAt` ordering in `Sidebar`; delete history modal.
- Messages: Markdown + LaTeX rendering (block/inline); streaming updates; token counts finalize; reasoning trace streaming/final rendering; citations + inline link previews; reliable auto-scroll.
- Model selection: modal open/close, fuzzy search, pinned/blocked section, selection for both pending (no session yet) and active session.
- Input: send/stop behavior, autosize, file upload previews (image/pdf/audio/text), error toasts for invalid files, undo file paste, search toggle persistence.
- PDF export: export current session to PDF and confirm styles render.
- Right panel: ticket registration, ticket visualization, key request, expiry countdown, renew/remove, proxy toggle + TLS security modal, fallback confirmation, and activity timeline updates.
- Network logging: entries appear with safe header masking; memory-only (fresh each tab).
- Theme & layout: system/light/dark selection persists and applies pre-hydration; highlight.js theme sync; wide mode toggle persistence; right panel visibility persistence.
- IndexedDB: sessions/messages/settings integrity through reloads; model config and verifier broadcast cache; ensure no uncaught console errors.
- WASM-backed flows (tickets/privacy) and proxy: exercise both success and error paths; show clear UI feedback and recover gracefully.

## Commit & Pull Request Guidelines
Existing commits use short, present-tense descriptions (e.g. “changes in UI, activity, latex fix”). Follow that tone, keep the first line under ~70 characters, and group related changes together. Pull requests should include: a concise summary of the user-facing impact, screenshots or gifs for UI updates, notes on manual testing performed, and references to any related issues or discussions.

## API Keys & Security
- Keys are ephemeral and acquired anonymously via ticket redemption (`services/station.js` + Privacy Pass). Do not hard-code keys.
- Active key data lives in session state and in LocalStorage (`openrouter_api_key_data`) via `services/apiKeyStore.js`. Inference tickets are stored in LocalStorage (`inference_tickets`) and can be exported via `services/fileUtils.js`.
- Network proxy traffic uses libcurl.js/mbedTLS to tunnel TLS over WebSocket; fallback to direct requests requires explicit user confirmation.
- Do not log secrets. When instrumenting requests, route through `services/networkLogger.js` and rely on `sanitizeHeaders` (Authorization masking).
- All prompts/responses are sent directly from the browser to OpenRouter using the user’s ephemeral key; Open Anonymity infrastructure only handles ticketing and key issuance.
- When adding providers/integrations, funnel credentials through the existing key store and document any required manual steps in the PR.

## Notes & Shortcuts
- Keyboard shortcuts:
  - ⌘/ new chat, ⌘K model picker, ⌘⇧F focus session search, Esc closes modals/menus.
  - ⌘⇧C copy latest assistant markdown (temporarily disabled), ⌘⇧⌫ clear chat (temporarily disabled).
- Right panel visibility is persisted in `localStorage` (`oa-right-panel-visible`); theme preference in `localStorage` (`oa-theme-preference`); wide mode in `localStorage` (`oa-wide-mode`); proxy settings in `localStorage` (`oa-network-proxy-settings`).
- Network logs are memory-only (tab-scoped) in this release to keep storage small and predictable.
