## `oa-fastchat`

A minimal, fast chat client that talks directly to OpenRouter using ephemeral, anonymous API keys obtained via the Open Anonymity network. Everything runs directly in the browser; no backend, no build step — just open and chat.

### Highlights
- **Standalone**: Pure ES modules loaded in the browser; no server required.
- **Provably anonymity**: Keys are ephemeral and acquired via Privacy Pass–backed inference tickets.
- **Persistent locally**: Sessions, messages, settings, and everything else are all *locally* stored in IndexedDB.
- **Streaming UX**: Incremental token updates with reliable auto‑scroll.
- **Markdown + LaTeX**: Rendered with Marked and KaTeX (from CDNs).
- **Model picker**: Fuzzy search, pinned models, and per‑session selection.
- **Multimodal**: Images, PDFs, and audio attachments (converted to OpenRouter formats).
- **Right panel**: Ticket registration, key issuance/expiry, and an activity timeline (logs are memory‑only per tab).

### Quick start
1. Clone the repo.
2. Serve the repo root (ensures correct module MIME types):
   ```bash
   cd chat && python3 -m http.server 8080
   # visit http://localhost:8080
   ```
   For quick checks you can also open `index.html` directly in a browser.

### Architecture (1‑minute overview)
- `index.html` bootstraps Tailwind, Marked, KaTeX, then loads ES modules.
- `app.js` coordinates state, components, streaming, and CRUD through `chatDB`.
- `api.js` handles OpenRouter calls (fetch models, stream completions).
- `db.js` provides an IndexedDB wrapper for sessions/messages/settings.
- `components/` contain UI pieces (sidebar, chat area, input, model picker, right panel, templates, message navigation).
- `services/` provide logging, key storage, file utilities, ticket/key flows, provider icons, and theme management.
- `wasm/` holds artifacts for the Privacy Pass/ticket logic.

For a deeper breakdown, see `AGENTS.md`.

### Privacy & security
- No server in this repo. The browser requests an ephemeral OpenRouter key using a redeemable ticket, then talks to OpenRouter directly over HTTPS.
- Keys are stored in session state and `localStorage` only; do not hard‑code secrets.
- Network logs are memory‑only (per tab) to avoid persistence.

### Development
- Keep devtools open — console warnings surface integration issues early.
- No bundler required; modules are authored as standard ES modules with 4‑space indentation and trailing semicolons.

