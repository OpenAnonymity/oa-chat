# Memory System Architecture

This document covers the agentic memory system: how it stores, retrieves, and extracts user context across conversations.

## Overview

The memory system gives the chat app persistent, cross-session memory. It has three runtime paths:

1. **Retrieval (read)** — Before sending a message, the LLM searches memory files and assembles relevant context to prepend to the user's query.
2. **Extraction (write)** — After each assistant response, the LLM examines the conversation and saves new facts to memory files.
3. **Compaction (cleanup)** — Every 6 hours, the LLM rewrites each memory file to remove duplicates and archive stale facts.

All three paths use **tool calling** through a shared agentic loop. The LLM receives OpenAI-format tool definitions and calls them to read/write the virtual filesystem. This replaces an earlier "JSON-in-text" approach where the LLM returned raw JSON that we parsed with regex.

## File Map

| File | Role |
|------|------|
| `chat/services/memoryFileSystem.js` | IndexedDB-backed virtual filesystem (storage layer) |
| `chat/services/memoryBulletUtils.js` | Bullet parsing, scoring, rendering, compaction |
| `chat/services/memoryBulletIndex.js` | In-memory bullet cache for fast scoring |
| `chat/services/memoryStorageBackend.js` | Storage interface definition + tool executor factories |
| `chat/services/agenticToolLoop.js` | Backend-agnostic LLM tool-calling loop |
| `chat/services/agenticRetrieval.js` | Retrieval (read path) |
| `chat/services/memoryExtractor.js` | Extraction (write path) |
| `chat/services/memoryCompactor.js` | Periodic compaction |
| `chat/services/messageMemoryContext.js` | Per-message memory context tracking |
| `chat/components/MemoryEditor.js` | File browser/editor modal (Cmd+Shift+M) |
| `local_inference/backends/httpOpenAIBackend.js` | HTTP backend with tool calling support |
| `local_inference/responseUtils.js` | Request normalization (preserves tool fields) |

## Storage Layer

### `memoryFileSystem.js`

A virtual markdown filesystem stored in IndexedDB (`oa-memory-fs` database). Each file is a record with:

```
{ path, content, l0 (one-line summary), itemCount, titles, parentPath, createdAt, updatedAt }
```

**Public API:**

| Method | Returns | Description |
|--------|---------|-------------|
| `init()` | `Promise<IDBDatabase>` | Open DB, bootstrap seeds if empty |
| `read(path)` | `string \| null` | Read file content |
| `write(path, content)` | `void` | Upsert file, auto-rebuild index |
| `delete(path)` | `void` | Delete file (protects `_index.md`) |
| `exists(path)` | `boolean` | Check file existence |
| `ls(dirPath)` | `{ files, dirs }` | List directory children |
| `search(query)` | `[{ path, snippet }]` | Brute-force text search |
| `getIndex()` | `string` | Read root `_index.md` |
| `rebuildIndex()` | `void` | Regenerate `_index.md` from all files |
| `exportAll()` | `[record]` | Export all records |

**Default structure after bootstrap:**
```
_index.md              — Auto-generated file listing
personal/about.md      — Personal facts
projects/about.md      — Project placeholder
```

On every `write()`, the file's `l0` summary, `itemCount`, and `titles` are recomputed from content, and `_index.md` is rebuilt asynchronously.

### Memory Bullet Format

Files use a structured bullet format with inline metadata:

```markdown
## Active

### Education
- Studying MSCS at Stanford | topic=education | updated_at=2026-03-05

### Career
- Research Assistant at Stanford University | topic=career | updated_at=2026-03-05

## Archive
### Old Facts
- Previously worked at Google | topic=career | updated_at=2025-01-01 | expires_at=2026-01-01
```

`memoryBulletUtils.js` provides parsing (`parseMemoryBullets`), scoring (`scoreMemoryBullet`), deduplication (`compactBullets`), and rendering (`renderCompactedMemoryDocument`) for this format.

`memoryBulletIndex.js` maintains an in-memory cache of parsed bullets per file, refreshed on writes via `refreshPath(path)`.

## Storage Backend Interface

`memoryStorageBackend.js` defines the contract any storage backend must implement, and exports two factory functions that build tool executors from a backend:

```js
// Any backend must implement:
backend.read(path)         // → string | null
backend.write(path, content) // → void
backend.delete(path)       // → void
backend.exists(path)       // → boolean
backend.ls(dirPath)        // → { files: [], dirs: [] }
backend.search(query)      // → [{ path, snippet }]
backend.getIndex()         // → string
backend.rebuildIndex()     // → void
backend.exportAll()        // → [{ path, content, ... }]
```

**Factory functions:**

- `createRetrievalExecutors(backend)` — Returns `{ retrieve_file, read_file }` for the read path.
- `createExtractionExecutors(backend, helpers)` — Returns `{ read_file, create_new_file, create_new_folder, append_memory, update_memory, archive_memory, delete_memory }` for the write path. Accepts optional `helpers` for content normalization and merge logic.

Currently, `memoryFileSystem` is the only backend. The factories receive it directly:

```js
const toolExecutors = createRetrievalExecutors(memoryFileSystem);
```

## Agentic Tool Loop

`agenticToolLoop.js` exports `runAgenticToolLoop(options)`, a generic loop that:

1. Sends messages + tool definitions to the LLM via `localInferenceService.createResponse()`
2. If the LLM returns `tool_calls`: parses args, executes each via the `toolExecutors` map, appends results to the conversation
3. If a **terminal tool** is called: captures its arguments and stops the loop
4. If no tool calls: captures the text response and stops
5. Repeats up to `maxIterations`

```
┌─────────────┐
│   LLM Call   │◄──────────────────────┐
└──────┬───────┘                       │
       │ tool_calls?                   │
       ├── No ──► return textResponse  │
       │                               │
       ▼ Yes                           │
┌─────────────────┐                    │
│ Execute tools    │                    │
│ (via executors)  │                    │
└──────┬──────────┘                    │
       │ terminal tool?                │
       ├── Yes ──► return terminalResult
       │                               │
       └── No ──► append results ──────┘
```

**Key options:**

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `gpt-oss-120b` | Model ID |
| `backendId` | `tinfoil` | Inference backend |
| `tools` | required | OpenAI-format tool definitions |
| `toolExecutors` | required | `{ name: async(args) => string }` |
| `messages` | required | Initial system + user messages |
| `terminalTool` | `null` | Tool name that ends the loop |
| `maxIterations` | `10` | Safety cap |
| `maxOutputTokens` | `500` | Per-call limit |

**Returns:** `{ textResponse, terminalToolResult, messages, iterations, toolCallLog }`

## Retrieval (Read Path)

`agenticRetrieval.js` — singleton `agenticRetrieval`.

### Flow

```
User query
    │
    ▼
Read _index.md → trivial? → return null
    │
    ▼
Acquire Tinfoil key
    │
    ├── Key available ──► Tool-calling retrieval
    │                     │
    │                     ├─ LLM calls retrieve_file(keyword)
    │                     ├─ LLM calls read_file(path)  (up to 5 files)
    │                     └─ LLM calls append_mem_to_query(content)  [terminal]
    │
    └── No key ──► Text search fallback
                   │
                   ├─ Tokenize query → search each word
                   ├─ Load top 5 files
                   └─ Score bullets, build snippet context
    │
    ▼
Return { files, paths, assembledContext }
```

### Tools

| Tool | Description | Terminal? |
|------|-------------|-----------|
| `retrieve_file(query)` | Keyword search across file contents and paths | No |
| `read_file(path)` | Read a memory file (truncated to 1500 chars) | No |
| `append_mem_to_query(content)` | Assemble final context to attach to query | **Yes** |

The `assembledContext` from the terminal tool is what actually gets prepended to the user's message in the API request.

### Integration with app.js

1. `runAgenticMemoryRetrievalFlow()` calls `agenticRetrieval.retrieveForQuery(query)`
2. Shows approval UI with retrieved files
3. On approval, `assembledContext` becomes the `approvedPayload` (or user can edit it in the full-prompt editor)
4. `processMessagesWithFiles()` prepends `assembledContext` to the user message

## Extraction (Write Path)

`memoryExtractor.js` — singleton `memoryExtractor`.

### Flow

```
Assistant response completes
    │
    ▼
memoryExtractor.processSession(sessionId)
    │
    ├─ Load last 10 messages (max 8000 chars)
    ├─ Read memory index
    ├─ Acquire Tinfoil key
    │
    ▼
Run agentic loop (max 6 iterations)
    │
    ├─ LLM calls read_file(path) to inspect existing
    ├─ LLM calls append_memory(path, content) to add facts
    ├─ LLM calls create_new_file(path, content) for new topics
    ├─ LLM calls update_memory(path, content) to fix stale facts
    └─ LLM stops when done (no terminal tool)
    │
    ▼
Bullet index refreshed for each written path
```

### Tools

| Tool | Description |
|------|-------------|
| `read_file(path)` | Inspect existing content before writing |
| `create_new_file(path, content)` | Create new memory file |
| `create_new_folder(folder_path)` | Create folder with placeholder |
| `append_memory(path, content)` | Append bullets (merged with existing via `compactBullets`) |
| `update_memory(path, content)` | Overwrite entire file |
| `archive_memory(path, item_text)` | Remove specific bullet |
| `delete_memory(path)` | Delete file |

No terminal tool — the LLM stops naturally when it has nothing more to save.

### Content Normalization

The extraction executors receive helpers from `memoryExtractor`:

- `normalizeContent(content, path)` — Parses bullets, ensures metadata, compacts
- `mergeWithExisting(existing, incoming, path)` — Merges existing + incoming bullets, deduplicates, renders as Active/Archive markdown

Both use `memoryBulletUtils` functions: `parseMemoryBullets`, `ensureBulletMetadata`, `compactBullets`, `renderCompactedMemoryDocument`.

## Infrastructure: Tool Calling Support

Two files in `local_inference/` were modified to support tool calling:

### `responseUtils.js`

`normalizeInputItem()` preserves `tool_calls` and `tool_call_id` fields during request normalization — without this, the multi-turn tool conversation structure was stripped and the LLM couldn't see its previous tool calls.

`buildChatMessagesFromRequest()` handles three message types:
- `{role: 'tool', tool_call_id}` — tool result messages
- `{role: 'assistant', tool_calls}` — assistant messages with tool calls (content set to `null` if empty)
- `{type: 'function_call_output', call_id}` — legacy function call outputs

### `httpOpenAIBackend.js`

`buildChatRequestBody()` passes through `tools` and `tool_choice` to the OpenAI-compatible API.

`createResponse()` extracts `tool_calls` from `choices[0].message` and attaches them to the response object.

## Extending: Real Filesystem Backend

The storage backend interface (`memoryStorageBackend.js`) is designed for swapping. To add a Node.js/Electron filesystem backend:

### 1. Implement the interface

```js
// e.g. chat/services/fsMemoryBackend.js
import fs from 'fs/promises';
import path from 'path';

class FsMemoryBackend {
    constructor(rootDir) {
        this.rootDir = rootDir; // e.g. ~/.oa-chat/memory/
    }

    async read(filePath) {
        try {
            return await fs.readFile(path.join(this.rootDir, filePath), 'utf-8');
        } catch { return null; }
    }

    async write(filePath, content) {
        const fullPath = path.join(this.rootDir, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
    }

    async delete(filePath) {
        await fs.unlink(path.join(this.rootDir, filePath)).catch(() => {});
    }

    async exists(filePath) {
        try { await fs.access(path.join(this.rootDir, filePath)); return true; }
        catch { return false; }
    }

    async ls(dirPath) {
        const fullDir = path.join(this.rootDir, dirPath || '');
        const entries = await fs.readdir(fullDir, { withFileTypes: true });
        return {
            files: entries.filter(e => e.isFile()).map(e => path.join(dirPath || '', e.name)),
            dirs: entries.filter(e => e.isDirectory()).map(e => e.name)
        };
    }

    async search(query) {
        // Walk all .md files, grep for query
        const results = [];
        // ... recursive file walk + string search ...
        return results;
    }

    async getIndex() { return this.read('_index.md'); }
    async rebuildIndex() { /* regenerate _index.md from file listing */ }
    async exportAll() { /* walk all files, return records */ }
}
```

### 2. Wire it in

No changes needed to `agenticRetrieval.js`, `memoryExtractor.js`, or `agenticToolLoop.js`. Just pass the new backend to the executor factories:

```js
// In agenticRetrieval.js (Electron variant)
const backend = new FsMemoryBackend('~/.oa-chat/memory/');
const toolExecutors = createRetrievalExecutors(backend);
```

### 3. What stays the same

- Tool definitions (schemas the LLM sees) — identical across backends
- Agentic loop (`agenticToolLoop.js`) — completely backend-agnostic
- System prompts — no backend-specific language
- Bullet format and compaction logic — operates on strings, not storage

### 4. What would need adaptation

- `memoryBulletIndex.js` currently reads from `memoryFileSystem` directly. For a new backend, either pass the backend as a constructor arg or make it read from the same interface.
- `memoryCompactor.js` also calls `memoryFileSystem` directly — same approach.
- `MemoryEditor.js` (UI) imports `memoryFileSystem` — would need a backend selector or injection.
- The `rebuildIndex()` and `exportAll()` implementations differ significantly between IndexedDB and a real filesystem.

### 5. Recommended approach

Create a `getMemoryBackend()` factory that returns the right backend based on environment:

```js
export function getMemoryBackend() {
    if (typeof window !== 'undefined' && window.indexedDB) {
        return memoryFileSystem; // Browser/IndexedDB
    }
    return new FsMemoryBackend(getMemoryDir()); // Node.js/Electron
}
```

Then update all consumers to call `getMemoryBackend()` instead of importing `memoryFileSystem` directly.
