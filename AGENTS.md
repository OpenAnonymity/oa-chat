# Repository Guidelines

## Privacy Model (read this first for audits)

Before exploring the codebase, read [docs/PRIVACY_MODEL.md](docs/PRIVACY_MODEL.md) for
the full unlinkability model and threat analysis. The core guarantee: **no party can link
a user's identity to their inference activity, even if any OA component is malicious.**
The org backend being closed-source does not affect this -- blinding runs client-side and
no OA system sees prompts or responses. See also the blog post:
[Unlinkable Inference as a User Privacy Architecture](https://openanonymity.ai/blog/unlinkable-inference/).

## Agent Workflow (read docs before code)

For ongoing web-app work, agents should follow this order:

1. Read `docs/PRIVACY_MODEL.md`, then scan the relevant files in `docs/` to understand
   the current product and feature context before opening implementation files. If the
   task touches UI/UX, read [docs/APP_STATE.md](docs/APP_STATE.md) first and then any
   related feature doc under `docs/`.
2. Explore the code paths that implement the affected behavior, then make the change.
3. After meaningful implementation or investigation work, update the relevant doc in
   `docs/` and add any non-obvious learnings, UI nuances, state coupling, persistence
   details, or follow-up notes to [docs/APP_STATE.md](docs/APP_STATE.md) so future
   agents can pick up the state cleanly.
4. Before marking a non-trivial coding task as done, spin up a fresh subagent to
   review the final diff adversarially for bugs, privacy regressions, missed tests,
   UI/UX regressions, and maintainability issues. Treat that review as part of the
   same turn: fix valid findings, rerun the subagent review after material fixes, and
   iterate back and forth until the fresh review agent approves the final diff. If
   approval is blocked by residual risk, finish only after that risk is explicitly
   accepted and reported by the main agent (or by the user when it requires a
   product/behavior decision).

If no existing doc in `docs/` is a good fit for the new learning, create one and link it
from [docs/APP_STATE.md](docs/APP_STATE.md).

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
- `zkapi/`: Optional private-payment mode (built in only when `OA_ZKAPI_NETWORK` is set); see [docs/ZKAPI_PAYMENTS.md](docs/ZKAPI_PAYMENTS.md).
  - `boot.js`: Payment boot called by `startup.js`; picks the protocol version from the local wallet, loads that SDK build, installs the deposit guard and watcher. Never throws; failure means ticket-only plus one toast.
  - `versioning/`: Multi-version support (registry model, protocol-family adapters, read-only holdings probe and selection, switch protocol, deposit guard, watcher, state/copy, the exit-refusal reader, the give-up verdict, the read-only payment history of the other versions, sponsored withdrawals (`sponsored.mjs`, `sponsoredFees.mjs`), `WIRED`, and the `zkapiClient.oaVersioning` facade). SDK-free by rule. The version registry is `deployments/zkapi/registry.json`; its build side is `scripts/zkapiRegistry.mjs`, `zkapiBuild.mjs`, `zkapiFacadePlugin.mjs` and `zkapi-registry-cli.mjs`. Version 2's host behaviors (service pause, settling-chat disclosure, credited payouts, exit kit, device and near-expiry notices, withdrawal recheck, other deployments' records) are implemented in the components and services listed in the guide; the row stays `pending`. Sponsored (gasless, ERC-4337) withdrawals are implemented too and dormant until a reviewed profile pins a paymaster and relay: the page reaches the relay only through the generated route `<proxyPath>_bundler` and only after the person chose to pay the fee from the withdrawal, and the Send Ethereum signer judges each operation where it would leave the browser (`services/sponsoredOperation.mjs`; guide section 11.7). A `concession-v1` profile pins the proof setup `mpc-1` or the single-party `dev`, accepted alike on both networks by owner decision and reported rather than blocked (see Security below). Read [docs/ZKAPI_VERSIONING.md](docs/ZKAPI_VERSIONING.md) before changing any of it.
- `vendor/privacypass-ts.js`: Bundled `@cloudflare/privacypass-ts` (Apache-2.0, pure JS) for blind signature operations.
- `docs/APP_STATE.md`: Living handoff doc for current web-app state, subtle UI behaviors, and implementation learnings that may not be obvious from code alone.
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
- Persisted data goes through `chatDB` in `db.js`; follow existing object store patterns and keep transactions minimal and readable. The only exception is the small set of zkAPI version keys in `sessionStorage`/`localStorage` (see Notes & Shortcuts): boot reads them before `chatDB` opens, and none is synced.
- Keep code small and modular; avoid duplicating functionality already encapsulated in components/services.

## Testing Guidelines
`npm test` runs the automated unit suites (`scripts/run-unit-tests.mjs`; `pretest` applies the zkAPI SDK patches). There is no automated UI or end-to-end harness, and this repository has no CI configuration, so nothing runs `npm test` or any check for you: run them before merging. Manually verify:
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
- zkAPI payments and versions: the automated suites are `test/zkapi/` and `test/architecture/` ([docs/ZKAPI_VERSIONING.md](docs/ZKAPI_VERSIONING.md) section 13 maps each file to what it pins; the runner runs the architecture group first and does not run `test/zkapi/` if it fails). The four vm-evaluated sources (`AccountModal.js`, `WelcomePanel.js`, `WalletMethodControls.js`, `services/walletMethod.mjs`) must not gain imports or free identifiers; they reach version context only through `zkapiClient.oaVersioning?.`. `AccountModal.js` and `WelcomePanel.js` each write out the same five facade helpers (`zkapiVmSourceCopies.test.js` fails when they differ), and four tests parse sources with `acorn`, a pinned devDependency. For a registry change also run, by hand, `node scripts/zkapi-registry-cli.mjs check --base origin/main` (nothing runs it automatically) and build both networks with `OA_ZKAPI_NETWORK=<net> OA_ZKAPI_DEPLOYMENT=fresh-20260930`. With a second live version, manually check: a fresh profile lands on the deposit target; a profile holding an older note stays on its version with deposits closed and the upgrade steps; a started deposit can still be finished; nothing signs, withdraws, gives up a balance, creates an exit kit or reloads without a click. For a protocol-version change also check by hand in a real browser, since Web Locks, BroadcastChannel and the downloads are only exercised over fakes in tests: a withdrawal while a chat is settling shows the bound and the choice; the exit kit dialog creates, then saves in a fresh click, and nothing about it is stored; the other versions' Payment history rows are text with no action but Open version; giving up a dust balance needs the checkbox and leaves the slot empty after Reload.

## Commit & Pull Request Guidelines
Existing commits use short, present-tense descriptions (e.g. “changes in UI, activity, latex fix”). Follow that tone, keep the first line under ~70 characters, and group related changes together. Pull requests should include: a concise summary of the user-facing impact, screenshots or gifs for UI updates, notes on manual testing performed, and references to any related issues or discussions.

For non-trivial product or UI changes, update the relevant file in `docs/` as part of the
same change so the next agent inherits the latest behavior, constraints, and lessons.

## API Keys & Security
- Keys/tokens are ephemeral and acquired unlinkably via ticket redemption (`services/ticketClient.js` + Privacy Pass). Do not hard-code keys.
- Active access data lives in session state; legacy access data may exist in LocalStorage (`oa_access_key_data`). Inference tickets are stored in LocalStorage (`inference_tickets`) and can be exported via `services/fileUtils.js`.
- Network proxy traffic uses libcurl.js/mbedTLS to tunnel TLS over WebSocket; fallback to direct requests requires explicit user confirmation.
- Do not log secrets. When instrumenting requests, route through `services/networkLogger.js` and rely on `sanitizeHeaders` (Authorization masking).
- zkAPI wallet holdings (note ids, deployment ids, phases), the other versions' payment history rows, held refusals, and exit-kit text and passphrases are memory-only: never log them, put them in a URL, send them through `networkLogger`, or persist them (history rows are projected through an allowlist of public fields and never include note secrets, plans, journals or proofs; a foreign row carries no action). Version selection is a function of the local wallet and a validated one-shot hint only; no URL, hash, or network answer may choose a build. Provider-visible request headers are rebuilt from an allowlist in `zkapi/api.js` so versions look identical to the inference provider. The host writes the shared wallet database in two places only, each under the SDK's wallet lock on a fresh read: the guarded discard of an unused deposit draft, and the user-confirmed give-up of a zero or dust balance (through the SDK's own archive transaction). The app's own code never logs or stores a sponsored withdrawal's operation (the SDK journals its own in the wallet database, and the history reader never reads the signed bodies); the operation is sent only through the generated relay route after an explicit choice. Never clear site data to get past a check.
- The proof setup of a version 2 (`concession-v1`) deployment is `mpc-1` (multi-party ceremony) or `dev` (single party). Whoever holds a `dev` vault's toxic waste can forge proofs: mint balance, defeat an honest exit and take deposits, and a vault on those keys cannot be switched to `mpc-1` (that is a new vault and a user migration, a further registry version). The host accepts both by one rule on both networks and reports `dev` (a build warning, `proofSetup` in `build.json`, registry check warnings) without blocking it; the SDK package's own build accepts `dev` for mainnet since upstream commit `4b955d9` (branch `v0.2`), and an older pin that still refuses it is passed on in its own words, never bypassed. Do not add a second switch for it, do not read the profile's `allow_dev_setup`, and do not describe a `dev` deployment as ceremony-backed ([docs/ZKAPI_VERSIONING.md](docs/ZKAPI_VERSIONING.md), "Single-party development proof setup: known limitation").
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
- zkAPI version keys (read before `chatDB` opens; never synced; ids, enums and a stage only, always inside try/catch): `sessionStorage` `oa-zkapi-version-switch` (one-shot hint for the next boot) and `oa-zkapi-version-switch-log` (loop guard: switch and discard timestamps), `localStorage` `oa-zkapi-upgrade-v1` (guided-upgrade intent, expires after 45 days) and `oa-zkapi-upgrade-reminder-v1` (last reminder tier per version). The existing `oa-zkapi-running-modal` and `oa-zkapi-welcome-modal` entries gain a `{network, versionId}` stamp on multi-version builds. The version-2 behaviors added no key; the SDK's own `zkapi-exit-rpc-url` is never read or written by this app. Details and lifetimes: [docs/ZKAPI_VERSIONING.md](docs/ZKAPI_VERSIONING.md) section 8.
