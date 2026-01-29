# Embedding Source

Generic embedding module with swappable backends (local inference or external API). Designed to be used by `vector/` or the chat app without tight coupling.

## Quick start

```js
import { createEmbeddingSource } from '../embeddings/index.js';

const embedder = createEmbeddingSource({
    backend: 'local',
    model: 'Qwen2-0.5B-embed'
});

const vector = await embedder.embedText('Hello world');
```

## API

- `createEmbeddingSource(options)` → EmbeddingSource instance
- `EmbeddingSource.createEmbedding(request, options)` → normalized embedding response
- `EmbeddingSource.embedText(text, options)` → `Float32Array`
- `EmbeddingSource.embedTexts(texts, options)` → `Float32Array[]`
- `EmbeddingSource.prepareModel(modelId, options)` → optional prepare hook

### API reference (short)

```ts
createEmbeddingSource(options: EmbeddingSourceOptions): EmbeddingSource

embedder.prepareModel(modelId?: string, options?: Record<string, unknown>): Promise<unknown>
embedder.createEmbedding(request: EmbeddingRequest, options?: EmbeddingRequestOptions): Promise<EmbeddingResponse>
embedder.embedText(text: string, options?: EmbeddingRequestOptions): Promise<Float32Array>
embedder.embedTexts(texts: string[], options?: EmbeddingRequestOptions): Promise<Float32Array[]>
```

Type hints:

```ts
type EmbeddingSourceOptions = {
    backend?: 'local' | 'openai' | 'openai-compatible' | EmbeddingBackend;
    model?: string;
    backendId?: string;
    backendOptions?: Record<string, unknown>;
};

type EmbeddingRequest = {
    model?: string;
    input?: string | string[];
    text?: string;
    texts?: string[];
};

type EmbeddingRequestOptions = {
    model?: string;
    backendId?: string;
    backendOptions?: Record<string, unknown>;
};

type EmbeddingResponse = {
    model: string | null;
    data: { index: number; embedding: Float32Array }[];
    embeddings: Float32Array[];
    usage: Record<string, unknown> | null;
    raw: unknown;
};

type EmbeddingBackend = {
    configure?: (options?: Record<string, unknown>) => void;
    fetchModels?: () => Promise<unknown>;
    prepareModel?: (modelId: string, options?: Record<string, unknown>) => Promise<unknown>;
    createEmbedding: (request: EmbeddingRequest, options?: EmbeddingRequestOptions) => Promise<EmbeddingResponse>;
};
```

### Options

- `backend` (`local`, `openai`, `openai-compatible`, or custom backend object)
- `model` (string)
- `backendId` (for local inference backends, e.g. `webllm`, `ollama`, `vllm`)
- `backendOptions` (passed to backend.configure)

## Built-in backends

### Local (`local`)
Delegates to `local_inference/` and supports WebLLM, Ollama, vLLM via `backendId`. If `backendId` is omitted, the local inference module chooses its default backend.
Unknown backend ids throw a clear error.

### OpenAI-compatible (`openai`)
Uses OpenAI-compatible HTTP API (same helper used by local inference).
Configure with `backendOptions`:

```js
const embedder = createEmbeddingSource({
    backend: 'openai',
    model: 'text-embedding-3-small',
    backendOptions: {
        baseUrl: 'https://api.openai.com',
        apiKey: '...'
    }
});
```

## Notes
- Embeddings should match the vector store dimension you configure in `vector/`.
- Use `prepareModel` to pre-load local models when supported (WebLLM/Ollama).

## Response format

`createEmbedding` returns:

```js
{
    model: string | null,
    data: [{ index, embedding: Float32Array }],
    embeddings: Float32Array[],
    usage: object | null,
    raw: object
}
```
