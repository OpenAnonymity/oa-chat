## `oa-chat`

A minimal, fast chat client that talks directly to the selected inference backend (OpenRouter by default) using ephemeral, unlinkable access credentials obtained via the Open Anonymity network. Everything runs directly in the browser with no backend; development is HTML-first, while production builds are bundled with esbuild and minified with terser.

### Highlights
- **Standalone**: Pure ES modules loaded in the browser; no server required.
- **Provable unlinkability**: Keys are ephemeral and acquired via Privacy Pass–backed inference tickets.
- **Persistent locally**: Sessions, messages, settings, and everything else are all *locally* stored in IndexedDB.
- **Streaming UX**: Incremental token updates with reliable auto‑scroll.
- **Markdown + LaTeX**: Rendered with Marked and KaTeX (self-hosted vendor assets).
- **Model picker**: Fuzzy search, pinned models, and per‑session selection.
- **Multimodal**: Images, PDFs, and audio attachments (converted to OpenRouter-compatible formats).
- **Right panel**: Ticket registration, access issuance/expiry, and an activity timeline (logs are memory‑only per tab).

### Quick start
1. Clone the repo.
2. Serve from the repo root:
   ```bash
   npm run dev
   # visit http://localhost:8080
   ```

Production build + preview:
```bash
npm run build
npm run preview
# visit http://localhost:8080
```

### Architecture (1‑minute overview)
- `index.html` bootstraps Tailwind, Marked, KaTeX, then loads ES modules.
- `app.js` coordinates state, components, streaming, and CRUD through `chatDB`.
- `services/inference/` selects the inference backend; `api.js` handles OpenRouter calls (fetch models, stream completions).
- `db.js` provides an IndexedDB wrapper for sessions/messages/settings (exported as `chatDB`).
- `components/` contain UI pieces (sidebar, chat area, input, model picker, right panel, templates, message navigation).
- `services/` provide logging, key storage, file utilities, ticket/key flows, provider icons, and theme management.
- `wasm/` holds artifacts for the Privacy Pass/ticket logic.

For a deeper breakdown, see `AGENTS.md`.

### Privacy & security
- No server in this repo. The browser requests an ephemeral access credential using a redeemable ticket, then talks to the inference backend directly over HTTPS.
- Keys are stored in session state and `localStorage` only; do not hard‑code secrets.
- Network logs are memory‑only (per tab) to avoid persistence.

### Development
- Keep devtools open — console warnings surface integration issues early.
- Source modules live in `chat/` and can be served directly in dev; production builds bundle and minify output into `dist/chat`.
