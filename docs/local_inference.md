# 1. Local Inference Module

This repository includes a **standalone** module at `local_inference/` for **auxiliary** tasks (e.g., embeddings, query rewriting, metadata extraction). It is intentionally **separate** from the main chat app and should not replace remote, unlinkable inference.

The module implements a simple Open Responses–style API and provides swappable backends for:
- **WebLLM** (in‑browser)
- **Ollama** (local server)
- **vLLM** (local server)
- **OpenAI‑compatible HTTP servers** (generic adapter)
- **Tinfoil** (hosted OpenAI‑compatible endpoint)

## 2. Why this exists
Local inference is meant for **secondary tasks** where end‑to‑end confidentiality is desired, such as:
- Embedding chat sessions for memory search
- Query re‑writing / pre‑processing
- Lightweight local classification

The main chat UI should continue to use the remote inference backend (OpenRouter, enclave, etc.).

---

## 3. Structure
```
local_inference/
  index.js
  localInferenceService.js
  responseUtils.js
  backends/
    webllmBackend.js
    ollamaBackend.js
    vllmBackend.js
    tinfoilBackend.js
    httpOpenAIBackend.js
  vendor/
    webllm/
      web-llm.js
      web-llm.js.map
      LICENSE
  tests/
    responseUtils.test.mjs
```

`local_inference/` is standalone and does **not** depend on chat app internals.

---

## 4. Quick Start
```js
import { localInferenceService } from './local_inference/index.js';

// Configure backends if needed
localInferenceService.configureBackend('ollama', { baseUrl: 'http://127.0.0.1:11434' });

// Optional: download/pull a model (Ollama only)
await localInferenceService.prepareModel('ollama', 'llama3.1:8b');

// Non‑streaming response (Open Responses shape)
const response = await localInferenceService.createResponse({
    model: 'llama3.1:8b',
    instructions: 'You are a concise assistant.',
    input: 'Rewrite this for clarity.'
}, { backendId: 'ollama' });

// Streaming response (Open Responses streaming events)
await localInferenceService.streamResponse({
    model: 'llama3.1:8b',
    instructions: 'You are a concise assistant.',
    input: 'Summarize this.'
}, {
    backendId: 'ollama',
    onEvent: (event) => {
        // event.type: response.output_text.delta, response.completed, etc.
    }
});

// Embeddings
const embeddings = await localInferenceService.createEmbedding({
    model: 'llama3.1:8b',
    input: 'Embed this.'
}, { backendId: 'ollama' });
```

### 4.1 WebLLM quick start (browser)
```js
import { localInferenceService } from './local_inference/index.js';

// Optional: customize module path or app config
localInferenceService.configureBackend('webllm', {
    modulePath: '/local_inference/vendor/webllm/web-llm.js'
});

// Load a model (first run downloads weights)
await localInferenceService.prepareModel('webllm', 'Llama-3.2-1B-Instruct-q4f16_1-MLC');

const response = await localInferenceService.createResponse({
    model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    instructions: 'You are a concise assistant.',
    input: 'Summarize this.'
}, { backendId: 'webllm' });

console.log(response.output?.[0]?.content?.[0]?.text);
```

---

## 5. API Overview

### 5.1 `localInferenceService`
- `registerBackend(backend)`
  - Registers a backend object. Must include `id` and `label`.
  - Required methods: `fetchModels()`, `createResponse(request, options)`, `streamResponse(request, options)`.
  - Optional methods: `prepareModel(modelId, options)`, `createEmbedding(request, options)`,
    `configure(options)`, `clearModelCache(modelId)`, `clearAllModelCache()`.
- `getBackend(backendId)`
  - Returns a backend by id (or `null` if unknown). If `backendId` is falsy, defaults to WebLLM.
- `getBackends()`
  - Returns all registered backends.
- `configureBackend(backendId, options)`
  - Configures a backend by id (throws if unknown).
- `configureWebLLM(options)`
  - Convenience wrapper for configuring the WebLLM backend.
- `fetchModels(backendId)`
  - Returns a list of available models for the backend.
- `prepareModel(backendId, modelId, options)`
  - Preloads/downloads a model when supported (WebLLM/Ollama).
- `createResponse(request, options)`
  - Runs a non‑streaming response and returns an Open Responses‑style response object.
- `streamResponse(request, options)`
  - Streams responses via Open Responses streaming events and returns the final response object.
- `createEmbedding(request, options)`
  - Runs an embedding request and returns the raw backend response.
- `onStatus(callback)`
  - Subscribes to backend status events; returns an unsubscribe function.
- `clearModelCache(backendId, modelId)`
  - Clears cached files for a specific model (WebLLM only).
- `clearAllModelCache(backendId)`
  - Clears cached files for all models in a backend (WebLLM only).

Notes:
- If `backendId` is omitted, WebLLM is used by default.
- Passing an unknown `backendId` throws a clear error instead of silently falling back.

### 5.2 Request shape (Open Responses style)
The service accepts a lightweight Open Responses–style request:
```js
{
  model: 'model-id',
  input: 'text' | [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }],
  messages: [...], // alias for input
  instructions: 'optional system instructions',
  system: 'optional system instructions (alias)',
  system_prompt: 'optional system instructions (alias)',
  temperature: 0.7,
  top_p: 0.9,
  max_output_tokens: 256,
  seed: 42, // optional integer, for deterministic sampling when supported
  user: 'optional user id',
  stream: false,
  metadata: object | null,
  tools: [],
  tool_choice: null,
  truncation: 'disabled',
  reasoning: null,
  text: null
}
```
It normalizes messages internally before calling the backend. Most backends currently
use the chat‑focused fields (`model`, `input/messages`, `temperature`, `top_p`,
`max_output_tokens`, `seed`, `user`).

### 5.3 Request options
The `options` argument for `createResponse` / `streamResponse` / `createEmbedding`:
```js
{
  backendId: 'webllm' | 'ollama' | 'vllm' | '...',
  systemPrompt: 'prepended to instructions',
  onEvent: (event) => void,   // streaming only
  signal: AbortSignal         // supported by HTTP backends + streaming
}
```

### 5.4 Streaming events
`streamResponse` emits Open Responses streaming events (`response.in_progress`, `response.output_text.delta`, `response.completed`, etc.).

### 5.5 Determinism
For repeatable outputs, set `temperature: 0`, `top_p: 1`, and an integer `seed`.
Some models/backends (or WebGPU runtimes) may still be nondeterministic.

### 5.6 Status events
`onStatus` emits backend progress signals for UI wiring (e.g., download progress). Example:
- WebLLM: `model.load.start`, `model.load.progress`, `model.load.ready`, `model.load.error`
- Ollama: `model.pull.start`, `model.pull.progress`, `model.pull.done`, `model.pull.error`

Status events are normalized and include:
```js
{
  timestamp,
  backendId,
  backendLabel,
  type,
  ...backendSpecificFields
}
```

---

## 6. Backends

### 6.1 WebLLM (browser)
- Vendor bundle is located at:
  `local_inference/vendor/webllm/web-llm.js`
- Default module path is set in `webllmBackend.js`:
  `/local_inference/vendor/webllm/web-llm.js`
- You may override via:
```js
localInferenceService.configureBackend('webllm', {
  modulePath: '/local_inference/vendor/webllm/web-llm.js'
});
```

**Small model options (good for quick tests):**
- `Llama-3.2-1B-Instruct-q4f16_1-MLC`
- `Llama-3.2-1B-Instruct-q4f32_1-MLC`
- `Llama-3.2-3B-Instruct-q4f16_1-MLC`

**Embedding models (required for `createEmbedding`):**
- `snowflake-arctic-embed-s-q0f32-MLC-b4` (smallest)
- `snowflake-arctic-embed-s-q0f32-MLC-b32`
- `snowflake-arctic-embed-m-q0f32-MLC-b4`
- `snowflake-arctic-embed-m-q0f32-MLC-b32`

### 6.1.1 WebLLM Quick Test (Browser)
Use the bundled WebLLM demo page:
```
python3 -m http.server 8080
# then open: http://localhost:8080/experiments/local-webllm-demo.html
```
The demo loads the full WebLLM model list and sorts by VRAM requirement (smallest first).
WebLLM uses the browser Cache Storage by default (on disk). You can delete models via the demo's **Clear Cache** or **Clear All Cache** buttons, or by clearing site data in DevTools.

### 6.2 Ollama (local server)
- Defaults to `http://localhost:11434`
- Uses `/v1/chat/completions` for inference
- Uses `/api/pull` for model download progress

### 6.3 vLLM (local server)
- Defaults to `http://localhost:8000`
- Uses OpenAI‑compatible `/v1/models` and `/v1/chat/completions`

### 6.4 Generic OpenAI‑compatible
- Implemented in `httpOpenAIBackend.js`
- Use `createOpenAICompatibleBackend(...)` to add custom endpoints

### 6.5 Tinfoil (hosted OpenAI-compatible)
- Built with the same OpenAI-compatible adapter
- Default base URL: `https://inference.tinfoil.sh`
- Default model: `gpt-oss-120b`

---

## 7. Embeddings
`createEmbedding` is supported for:
- WebLLM
- OpenAI‑compatible servers (e.g., Ollama/vLLM if they expose `/v1/embeddings`)

Use the same `backendId` and model naming conventions as the text API.
If you need a higher-level API that pairs embeddings with the vector store, see
`docs/embeddings.md` and `docs/vector.md`.

## 8. Cache management
WebLLM exposes cache helpers. Use:
```js
await localInferenceService.clearModelCache('webllm', 'model-id');
await localInferenceService.clearAllModelCache('webllm');
```
These throw if the backend does not support cache clearing.

---

## 9. Tests
```bash
node --test local_inference/tests/responseUtils.test.mjs
```

---

## 10. Notes
- This module is **separate** from the main chat app and should be used only for auxiliary tasks.
- No API keys are stored here; all configuration is explicit and local.
- The main chat pipeline remains unchanged and continues to use the remote inference backend.
