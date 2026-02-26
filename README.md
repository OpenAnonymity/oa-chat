# `oa-chat`

A ChatGPT-like AI chat app that implements [unlinkable inference](https://openanonymity.ai/blog/unlinkable-inference/) — AI inference where every request is verifiably decoupled from each other, and from your identity. Built by [The Open Anonymity Project](https://openanonymity.ai).

Everything runs in the browser with no server backend. Each session uses a fresh ephemeral access key obtained via blind signatures, so no party — including the OA system and the inference provider — can link your identity to your inference activity or link sessions to each other.

### Highlights
- **Unlinkable inference**: Every session uses an ephemeral, blind-signature-backed access key. The inference provider sees anonymous requests with no way to identify the user behind them or link them across sessions.
- **Standalone**: Pure ES modules loaded in the browser; no server required.
- **Local-only storage**: Sessions, messages, and settings are stored locally in IndexedDB. Network logs are memory-only (per tab). You have the only copy of your activity history.
- **Streaming UX**: Incremental token updates with reliable auto-scroll.
- **Markdown + LaTeX**: Rendered with Marked and KaTeX (self-hosted vendor assets).
- **Model picker**: Fuzzy search, pinned models, and per-session selection.
- **Multimodal**: Images, PDFs, and audio attachments.
- **Right panel**: Ticket registration, access issuance/expiry, and an activity timeline (logs are memory-only per tab).

### Quick start
1. Clone the repo.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Serve from the repo root:
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

### Architecture (1-minute overview)
- `index.html` bootstraps Tailwind, Marked, KaTeX, then loads ES modules.
- `app.js` coordinates state, components, streaming, and CRUD through `chatDB`.
- `services/inference/` selects the inference backend; `api.js` handles OpenRouter calls (fetch models, stream completions).
- `db.js` provides an IndexedDB wrapper for sessions/messages/settings (exported as `chatDB`).
- `components/` contain UI pieces (sidebar, chat area, input, model picker, right panel, templates, message navigation).
- `services/` provide logging, key storage, file utilities, ticket/key flows, provider icons, and theme management.
- `local_inference/`, `embeddings/`, and `vector/` are standalone modules for local/auxiliary inference and memory search (in development).
- `chat/vendor/privacypass-ts/privacypass-ts.min.js` provides blind signature operations via `@cloudflare/privacypass-ts` (open-source, Apache-2.0).

For a deeper breakdown, see `AGENTS.md`.

### Privacy & security

**Unlinkable inference**: No party — including the OA system and the inference
provider — can link a user's identity to their inference activity. Blind
signatures ensure the station cannot correlate ticket issuance (blind signing)
to ticket redemption (ephemeral API key request). The ephemeral API key carries no user
identity — the model provider sees anonymous inference from an ephemeral key with no
way to identify the user behind it. Each session uses a different ephemeral key, so sessions cannot be linked to each other.

This is much stronger than pseudonymity — there is no stable alias on your data. The adversary observing requests cannot tell if 100 requests came from 100 people with 1 request each, or 1 person with 100 requests, or anything in between.

**What OA does NOT claim**: OA does not claim that prompts are hidden from the
inference provider. Prompts must reach the model for inference to work. The claim
is that prompts are *unlinkable* to your identity and to each other — the provider
sees anonymous requests from ephemeral keys with no way to know who sent them or
link them across sessions.

**Zero trust on OA infrastructure**: Users need not trust any OA-operated component
(org, stations, verifier operators). The verifier runs in a hardware-attested enclave
(AMD SEV-SNP) with open-source auditable code. Station compliance (privacy toggles,
key ownership) is enforced using the provider's own APIs as evidence. Even a
compromised OA operator cannot deanonymize users because no OA component possesses user
identity in the first place.

For the detailed privacy model, see [docs/PRIVACY_MODEL.md](docs/PRIVACY_MODEL.md) and the blog post
[Unlinkable Inference as a User Privacy Architecture](https://openanonymity.ai/blog/unlinkable-inference/).

### Development
- Keep devtools open — console warnings surface integration issues early.
- Source modules live in `chat/` and can be served directly in dev; production builds bundle and minify output into `dist/`.
- Debug logging is enabled on localhost and disabled in production builds (see `DEBUG` flag in `chat/config.js`).

### License
This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE).
