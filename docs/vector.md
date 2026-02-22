# Vector Store

Single source of truth for the vector search module (usage, API, and backend contract).

## Quick start

```js
import { createVectorStore, encodeVectorId } from '../vector/index.js';

const store = await createVectorStore({
    name: 'chat-history',
    dimension: 1536,
    metric: 'cosine',
    backend: 'auto'
});

await store.upsert([
    {
        id: encodeVectorId({ namespace: 'chat', type: 'session', entityId: 's1' }),
        vector: embedding,
        metadata: { sessionId: 's1' }
    }
]);

const results = await store.search(queryEmbedding, 5, {
    filter: (metadata) => metadata?.sessionId === 's1'
});
```

## Embeddings + local inference

The vector store does not generate embeddings itself. Pair it with the embeddings module
(which uses `local_inference/` by default) and then upsert the returned vectors:

```js
import { createEmbeddingSource } from '../embeddings/index.js';
import { createVectorStore } from '../vector/index.js';

const embedder = createEmbeddingSource({
    backend: 'local',
    model: 'Qwen3-0.6B-embed',
    backendId: 'webllm'
});

const store = await createVectorStore({
    name: 'chat-history',
    dimension: 1536,
    metric: 'cosine',
    backend: 'auto'
});

const vector = await embedder.embedText('Hello world');
await store.upsert({ id: 'doc-1', vector, metadata: { source: 'hello' } });
```

## Public API

This module does not expose HTTP endpoints. The public API is the ESM exports and
the `VectorStore` instance methods.

### Module exports

From `vector/index.js`:
- `createVectorStore(options)` → async store instance (awaits backend init)
- `new VectorStore(options)` → store instance (`await store.ready` if you construct directly)
- `registerBackend(name, factory)` → register a backend factory
- `availableBackends()` → list registered backend names
- `encodeVectorId(fields)` / `decodeVectorId(id)` → stable ID helpers

#### Export details

```ts
createVectorStore(options: VectorStoreOptions): Promise<VectorStore>
VectorStore(options: VectorStoreOptions)
registerBackend(name: string, factory: (options: VectorStoreOptions) => VectorBackend)
availableBackends(): string[]
encodeVectorId(fields: VectorIdFields): string
decodeVectorId(id: string): VectorIdFields | null
```

### VectorStore methods (public endpoints)

These are the stable entry points for callers. All methods are async and await
the backend `init()` once per store via `store.ready`.

```ts
store.upsert(items: VectorItem | VectorItem[]): Promise<number>
store.remove(ids: string | string[]): Promise<number>
store.get(ids: string | string[], options?: GetOptions): Promise<VectorItem[]>
store.search(queryVector: VectorLike, k?: number, options?: SearchOptions): Promise<SearchResult[]>
store.count(): Promise<number>
store.clear(): Promise<void>
store.stats(): Promise<Record<string, unknown>>
store.close(): Promise<void>
```

Behavior notes:
- `upsert` returns the number of items accepted (after validation).
- `remove` returns the number of items removed (best effort across backends).
- `get` preserves input order only if the backend does; treat as unordered.
- `search` returns results sorted by `score` (higher is better).
- `k` defaults to 10 when omitted or invalid.
- All vector inputs must match `dimension` or an error is thrown.

### Common options

- `name` (string): collection name
- `dimension` (number, required)
- `metric` (`cosine`, `ip`, `l2`)
- `normalize` (boolean): override normalization behavior (default: `metric === 'cosine'`)
- `backend`:
  - string (`auto`, `memory`, `indexeddb`, `orama`)
  - factory function `(options) => backend`
  - object `{ name, options }`
  - backend instance implementing the contract

`backend: 'auto'` chooses Orama in browser contexts, IndexedDB when `indexedDB` is
available without `window`, and falls back to in‑memory otherwise.

Type hints:

```ts
type VectorLike = Float32Array | number[] | ArrayBufferView | ArrayBuffer;

type VectorStoreOptions = {
    name?: string;
    dimension: number;
    metric?: 'cosine' | 'ip' | 'l2';
    normalize?: boolean;
    backend?: 'auto' | 'memory' | 'indexeddb' | 'orama'
        | ((options: VectorStoreOptions) => VectorBackend)
        | { name: string; options?: Record<string, unknown> }
        | VectorBackend;
};

type GetOptions = { includeVectors?: boolean };
type SearchOptions = { filter?: (metadata: any, id: string) => boolean; minScore?: number; includeVectors?: boolean };
```

### Item shape

```js
{
    id: string,
    vector: Float32Array | number[] | ArrayBufferView | ArrayBuffer,
    metadata: object | null
}
```

Type hint:

```ts
type VectorItem = {
    id: string;
    vector: VectorLike;
    metadata?: Record<string, unknown> | null;
};
```

### Search result shape

```js
{
    id: string,
    score: number,
    metadata: object | null,
    vector?: Float32Array
}
```

Type hint:

```ts
type SearchResult = {
    id: string;
    score: number;
    metadata: Record<string, unknown> | null;
    vector?: Float32Array;
};
```

Search options:
- `filter(metadata, id)` → boolean
- `minScore` (number)
- `includeVectors` (boolean)

### Error handling

- Invalid `dimension`, unsupported `metric`, or mismatched vector length throws.
- Unknown backend names or invalid backend configs throw at construction time.
- Backend init errors surface via `store.ready` (and any method that awaits it).

Notes:
- Scores are higher‑is‑better. For `l2`, scores are negative distances.
- `minScore` for cosine typically lives in `[-1, 1]` (Orama returns `0..1`).
- The vector length must match the store `dimension` or `upsert` will throw.

## Built‑in backends

- `memory`: fast in‑memory brute force (typed arrays)
- `indexeddb`: persistent store backed by IndexedDB (loads into memory)
- `orama`: Orama vector search (see below)

## Backend contract

A backend must expose the following methods (sync or async):
- `init(options)`
- `upsert(items)`
- `remove(ids)`
- `get(ids, options)`
- `search(query, k, options)`
- `count()`
- `clear()`
- `stats()`
- `close()`

Implementations should treat vectors as row‑major `Float32Array`s and return `score`
with higher‑is‑better. For `l2`, scores are negative distances.

Type hint:

```ts
type VectorBackend = {
    init?: (options: VectorStoreOptions) => void | Promise<void>;
    upsert: (items: VectorItem[]) => Promise<number> | number;
    remove: (ids: string | string[]) => Promise<number> | number;
    get: (ids: string | string[], options?: GetOptions) => Promise<VectorItem[]> | VectorItem[];
    search: (query: VectorLike, k?: number, options?: SearchOptions) => Promise<SearchResult[]> | SearchResult[];
    count: () => Promise<number> | number;
    clear: () => Promise<void> | void;
    stats: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    close: () => Promise<void> | void;
};
```

## IndexedDB backend

The `indexeddb` backend persists vectors/metadata and then loads them into an
in‑memory index at startup. It uses the same storage schema as the Orama backend,
so you can switch between them without re‑embedding.

Options:
- `dbName` (default `oa-vector-store`)
- `collection` (default: `name`)

## Orama backend (web)

The `orama` backend uses Orama for vector search in the browser and persists
vectors/metadata to the same IndexedDB schema as `indexeddb`.

Limitations:
- Cosine similarity only (Orama vector search does not expose metric selection).
- Scores are clamped to `0..1` in Orama results.

Options:
- `moduleFactory`: function that returns the Orama module (preferred for tests/bundlers)
- `moduleUrl`: URL to dynamically import the Orama ESM bundle
- `vectorProperty`: name of the vector field (default `embedding`)
- `idField`: name of the document id field (default `id`)
- `persistence`: `indexeddb` (default) or `none`

Local bundle:
- Orama is vendored at `vector/vendor/orama/` with entry `index.js`.
- Dev server: `chat/vector` is a symlink to `../vector`, so the browser can load
  `/vector/vendor/orama/index.js` directly when running `npm run dev`.
- Production build: `scripts/build.mjs` copies `vector/vendor` into `dist/vector/vendor`.
- In browser contexts, the backend defaults to `moduleUrl = '/vector/vendor/orama/index.js'`
  if you don’t provide one.

Usage (browser):

```js
const store = await createVectorStore({
    name: 'chat-history',
    dimension: 1536,
    backend: 'orama',
    moduleUrl: '/vector/vendor/orama/index.js'
});
```

## ID design

Use `encodeVectorId` to avoid collisions and allow future chunking:

```js
const id = encodeVectorId({
    namespace: 'chat',
    type: 'session',
    entityId: 'session-123',
    chunkId: 0,
    field: 'summary',
    variant: 'v1'
});
```

Fields:
- `namespace`: high‑level source (chat, files, os, etc.)
- `type`: entity type (session, message, file, calendar, etc.)
- `entityId`: stable source identifier (required)
- `chunkId`: optional chunk index for long content
- `field`: optional sub‑field (title, summary, body)
- `variant`: optional embedding version

## Environment & sharing

- Browser (oa‑chat): `backend: 'auto'` uses Orama with IndexedDB persistence.
- Electron renderer: can use the same IndexedDB backend and data model as the browser.
- Electron main process: register a native backend (e.g., LanceDB/FAISS) and keep the
  API surface unchanged.

Switching backend should only change the `backend` option (or `registerBackend` call)
— the API is consistent across implementations.
