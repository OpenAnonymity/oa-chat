# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

oa-fastchat is a browser-based chat client that communicates directly with inference backends (OpenRouter by default) using ephemeral, anonymous access credentials via the Open Anonymity network. Development is HTML-first; production builds are bundled with esbuild.

## Development Commands

```bash
# Local development server (from repo root)
npm run dev
# Visit http://localhost:8080/chat
```

The app uses `<base href="/chat/">` to resolve all relative paths — always access via the `/chat` path. Keep devtools open; console warnings highlight integration issues early.

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

**WebAssembly (`wasm/`):**
- Privacy Pass/ticket cryptographic operations

**Local Assets:**
- `chat/vendor/`: Marked, KaTeX (+ fonts), Highlight.js, libcurl.js, hash-wasm, html2pdf
- `chat/fonts/`: self-hosted Google Fonts (`fonts.css` + WOFF2 files, managed via `scripts/sync-fonts.mjs`)

## Code Style

- ES modules with 4-space indentation, trailing semicolons
- PascalCase for classes, camelCase for functions/methods
- Use relative paths for assets (resolved via `<base href="/chat/">`) — never hardcode `/chat/`
- Tailwind utilities from `tailwind.generated.css`; custom tweaks in `styles.css` with rationale
- All persisted data flows through `chatDB`; keep transactions minimal

## Key Patterns

**Data Storage:**
- IndexedDB: sessions, messages, settings (via `db.js`)
- localStorage: theme (`oa-theme-preference`), wide mode (`oa-wide-mode`), panel visibility (`oa-right-panel-visible`), proxy settings (`oa-network-proxy-settings`)
- Network logs are memory-only (tab-scoped)

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

No automated test harness. Manual verification checklist:
- Sessions: create/switch/delete, title auto-generation, ordering
- Messages: Markdown + LaTeX rendering, streaming, token counts, reasoning traces, citations
- Model picker: fuzzy search, pinned/blocked models
- Right panel: ticket registration, key request, expiry countdown, proxy toggle, TLS security
- Themes: system/light/dark persistence with pre-hydration
- WASM flows: exercise success and error paths

## Authoritative Documentation

See `AGENTS.md` for comprehensive architecture details, testing guidelines, and security notes.
