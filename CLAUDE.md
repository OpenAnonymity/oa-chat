# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

oa-chat is a ChatGPT-like AI chat app that implements unlinkable inference — AI inference where every request is verifiably decoupled from each other, and from your identity. It communicates directly with inference backends (OpenRouter by default) using ephemeral access keys obtained via blind signatures. Everything runs in the browser with no server backend. Development is HTML-first; production builds are bundled with esbuild and minified with terser.

## Workflow Expectations

Before touching implementation, read `docs/PRIVACY_MODEL.md` and the relevant files in
`docs/` to understand the current product state. If the task touches UI or complicated
state transitions, read `docs/APP_STATE.md` first and then any feature-specific doc that
applies.

Only after that should you inspect the code paths you expect to change and implement the
work. When you finish meaningful investigation or implementation, update the relevant
doc in `docs/` and record the non-obvious learnings in `docs/APP_STATE.md` so the next
agent can pick up the state without rediscovering subtle behavior from scratch.

## Development Commands

```bash
# Local development server (from repo root)
npm run dev
# Visit http://localhost:8080
```

The app uses `<base href="/">` to resolve all relative paths. Keep devtools open; console warnings highlight integration issues early.

```bash
# Production build + preview
npm run build
npm run preview

# Tailwind
npm run tailwind:build
npm run tailwind:watch

# Fonts (self-hosted Google Fonts)
npm run fonts:sync
```

## Architecture

**Entry Point Flow:**
- `index.html` → pre-hydrates theme/panel state → loads local vendor assets + precompiled Tailwind CSS → lazy-loads libcurl.js for proxy → runs `prelude.js` (empty-state render) → boots `app.js`

**Core Files:**
- `app.js`: Main `ChatApp` controller — orchestrates state, components, streaming, keyboard shortcuts, and session/message CRUD via `chatDB`
- `api.js`: OpenRouter client for fetching models and streaming completions
- `db.js`: IndexedDB wrapper (`ChatDatabase`) exported as `chatDB` — stores sessions, messages, settings (also assigned to `window.chatDB` for legacy access)

**Components (`components/`):**
- `Sidebar.js`, `ChatArea.js`, `ChatInput.js`, `ModelPicker.js`, `RightPanel.js`, `MessageTemplates.js`, `MessageNavigation.js`
- Pattern: Event delegation + state sync; components delegate to app, unidirectional data flow

**Services (`services/`):**
- `inference/`: Backend abstraction layer
  - `inferenceService.js`: Registry routing to backends
  - `backends/openRouterBackend.js`: Default implementation
  - `backends/enclaveStationBackend.js`, `providerDirectBackend.js`: Stubs for future backends
- `networkProxy.js`: Encrypted WebSocket proxy via libcurl.js/mbedTLS with TLS inspection
- `ticketClient.js`: Ticket lifecycle and access issuance (Privacy Pass integration)
- `networkLogger.js`: In-memory request logging with header sanitization

**zkAPI Payments (`chat/zkapi/`; built in only when `OA_ZKAPI_NETWORK` is set):**
- `boot.js`: payment boot called by `chat/startup.js`. Chooses the protocol version from the local wallet, loads that SDK build, installs the deposit guard and the watcher. Never throws; on failure the app starts ticket-only with one toast
- `versioning/`: multi-version zkAPI support. `registryModel.mjs` (pure registry model), `adapters/` (one per protocol family), `walletHoldings.mjs` + `versionLoader.mjs` (read-only holdings probe and version selection), `switchProtocol.mjs` (build switches, loop guard, upgrade intent), `depositGuard.mjs`, `versionWatcher.mjs`, `versionState.mjs` / `upgradeFlow.mjs` / `copy.mjs` (state, guided upgrade, words), `exitRefusal.mjs` (the SDK's exit and service refusals, read once), `abandonNote.mjs` (the give-up verdict), `otherVersionHistory.mjs` (read-only payment history of the other versions), `exitKit.mjs`, `serviceBase.mjs` (a deployment's service base URL: an origin, or an origin plus a plain path prefix so two versions can share a hostname), `sponsored.mjs` / `sponsoredFees.mjs` (paying a withdrawal's network fee from the withdrawal: profile rules, the relay route, quote and plan), `wiring.mjs` (`WIRED`) and `index.js` (the runtime facade, attached as `zkapiClient.oaVersioning`). SDK-free by rule: it runs before any SDK build is chosen
- Version UI and services: `components/VersionNotices.js`, `UpgradeView.js`, `BalanceExtras.js`, `ExitChoice.js`, `ExitKitDialog.js`, `AbandonDialog.js`, `RecordExtras.js`, `OtherVersionHistory.js`, `SponsoredFee.js` (the "Network fee" choice); `services/abandonedNote.mjs` (the SDK-bound give-up, loaded on use), `services/sponsoredOperation.mjs` (the signer's independent verifier of a sponsored operation)
- Build side: `deployments/zkapi/registry.json` (the version registry; a row goes live only through its gates), `scripts/zkapiRegistry.mjs`, `zkapiBuild.mjs`, `zkapiFacadePlugin.mjs`, `zkapi-registry-cli.mjs`. Sponsored (gasless, ERC-4337) withdrawals are built in and dormant until a reviewed profile pins a paymaster and a relay: the page reaches the relay only through the generated route `<proxyPath>_bundler`, only after the person chose to pay the fee from the withdrawal, and the Send Ethereum signer judges each operation where it would leave the browser (guide section 11.7). Version 2's ten host behaviors are implemented and listed in `WIRED`, but it stays `pending`: it needs a published SDK revision with a deployed profile for its proof setup, a recovery patch that covers `withdrawal-operation-recheck` (`PATCH_COVERAGE`; the registry check and the build refuse a live row without it) and the operator's finalized manifest. The host accepts the proof setups `mpc-1` and the single-party `dev` by one rule on both networks (owner decision): `dev` is reported (build warning, `build.json` `proofSetup`, registry check warnings), not blocked, and whoever holds its toxic waste can forge proofs, so read the guide's "Single-party development proof setup: known limitation" before touching that rule
- Read `docs/ZKAPI_VERSIONING.md` before changing any of it

**Local Assets:**
- `chat/vendor/`: Marked, KaTeX (+ fonts), Highlight.js, libcurl.js, hash-wasm, html2pdf
- `chat/fonts/`: self-hosted Google Fonts (`fonts.css` + WOFF2 files, managed via `scripts/sync-fonts.mjs`)

**Additional Modules (in development):**
- `embeddings/`: Text embedding service with pluggable backends
- `vector/`: Vector store with IndexedDB backend and Orama integration
- `local_inference/`: Local inference backends (Ollama, vLLM, WebLLM, HTTP OpenAI)

## Code Style

- ES modules with 4-space indentation, trailing semicolons
- PascalCase for classes, camelCase for functions/methods
- Use relative paths for assets (resolved via `<base href="/">`) — never hardcode absolute paths
- Tailwind utilities from `tailwind.generated.css`; custom tweaks in `styles.css` with rationale
- All persisted data flows through `chatDB`; keep transactions minimal. The zkAPI version keys listed under Key Patterns > Data Storage are the documented exception

## Key Patterns

**Data Storage:**
- IndexedDB: sessions, messages, settings (via `db.js`)
- localStorage: theme (`oa-theme-preference`), wide mode (`oa-wide-mode`), panel visibility (`oa-right-panel-visible`), proxy settings (`oa-network-proxy-settings`)
- Network logs are memory-only (tab-scoped)
- zkAPI version keys (documented exception to "persisted data flows through `chatDB`"): they must be readable synchronously before `chatDB` opens, because boot decides which SDK build to load first, and the upgrade intent must survive a new tab. They hold ids, enums and a stage only (no note id, deployment id, amount or address), are never account-synced and are never in `SYNCABLE_PREF_KEYS`. Every read and write is inside try/catch and the UI must render without them:
  - sessionStorage `oa-zkapi-version-switch`: one-shot hint for the next boot (reason, view, preferred version id); deleted when consumed, ignored after 5 minutes
  - sessionStorage `oa-zkapi-version-switch-log`: loop-guard timestamps of build switches and draft discards (60 s window, at most 2 of each); never cleared by consuming a hint
  - localStorage `oa-zkapi-upgrade-v1`: guided-upgrade intent `{network, from, to, stage, since}`; cleared when the upgrade is done or dismissed, expires after 45 days
  - localStorage `oa-zkapi-upgrade-reminder-v1`: last reminder tier shown per `network:versionId` (a per-viewer convenience)
  - sessionStorage `oa-zkapi-running-modal` and `oa-zkapi-welcome-modal` (existing): gain a `{network, versionId}` stamp only on a multi-version build; a mismatching stamp is ignored, an unstamped entry stays valid
- zkAPI wallet database `zkapi-browser-wallet-<lineage>-<network>-v1` is the SDK's, shared by every protocol version; this app's own code only reads it (version-less open that never creates or upgrades; the other versions' payment history is read the same way and kept in memory), plus two guarded writes under the SDK's wallet lock: the automatic discard of an unused deposit draft, and the user-confirmed give-up of a zero or dust balance (through the SDK's own archive transaction; no in-app undo)
- zkAPI exit kits, held refusals, the "kit not saved" flag and foreign history rows are memory only: no new storage key; the kit passphrase and text are never stored or logged

**Access Keys:**
- Ephemeral, acquired via Privacy Pass ticket redemption in `ticketClient.js`
- Never hardcode keys; do not log secrets (use `sanitizeHeaders` in `networkLogger.js`)

**Adding New Backends:**
- Implement in `services/inference/backends/`
- Route through `inferenceService.js`

## Keyboard Shortcuts

- `⌘/` — New chat
- `⌘K` — Model picker
- `⌘⇧F` — Focus session search
- `Esc` — Close modals/menus

## Testing

`npm test` runs the unit suites (`scripts/run-unit-tests.mjs`; its `pretest` applies the zkAPI SDK patches). This repository has no CI configuration: nothing runs the suites or the registry check (`node scripts/zkapi-registry-cli.mjs check --base origin/main`) for you, so run them before merging. zkAPI payment and versioning tests live in `test/zkapi/` (plain Node, `node --test test/zkapi/<file>`) and `test/architecture/`; `docs/ZKAPI_VERSIONING.md` section 13 maps each file to what it pins. Tests that need the real successor SDK skip without it (`ZKAPI_V2_SDK_DIR=<unpacked zkapi repository>` points them at one; the reference is branch `v0.2` at `4b955d9`, read without switching a checkout by `git archive`, see the guide's 11.6); against the unpatched `0.2.0` package exactly one fails by design, the SDK half of the withdrawal recheck. The four vm-evaluated sources (`AccountModal.js`, `WelcomePanel.js`, `WalletMethodControls.js`, `services/walletMethod.mjs`) must not gain imports; they reach version context only through `zkapiClient.oaVersioning?.` (`test/architecture/zkapiVmSources.test.js`). `AccountModal.js` and `WelcomePanel.js` each carry five identical facade helpers because neither may import (`zkapiVmSourceCopies.test.js` compares them). Four tests parse sources with `acorn`, a pinned devDependency. A test that seeds a fixed date and reads it through the real clock fails on that date with no code change: pin `Date.now`.

There is no automated UI harness. Manual verification checklist:
- Sessions: create/switch/delete, title auto-generation, ordering
- Messages: Markdown + LaTeX rendering, streaming, token counts, reasoning traces, citations
- Model picker: fuzzy search, pinned/disabled models
- Right panel: ticket registration, key request, expiry countdown, proxy toggle, TLS security
- Themes: system/light/dark persistence with pre-hydration
- WASM flows: exercise success and error paths

## Authoritative Documentation

See `AGENTS.md` for comprehensive architecture details, testing guidelines, and security notes.
See `docs/APP_STATE.md` for the living handoff log of current UI/state behavior and recent learnings.
