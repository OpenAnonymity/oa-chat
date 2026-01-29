# local_inference

Standalone local inference module for auxiliary tasks (embeddings, query rewriting, etc.).

## Usage
```js
import { localInferenceService } from './local_inference/index.js';

// Configure backends as needed
localInferenceService.configureBackend('ollama', { baseUrl: 'http://127.0.0.1:11434' });

// Optional: download/pull a model (Ollama only)
await localInferenceService.prepareModel('ollama', 'llama3.1:8b');

// Non-streaming response
const response = await localInferenceService.createResponse({
    model: 'llama3.1:8b',
    input: 'Rewrite this clearly.'
}, { backendId: 'ollama' });

// Embeddings
const embeddings = await localInferenceService.createEmbedding({
    model: 'llama3.1:8b',
    input: 'Embed this.'
}, { backendId: 'ollama' });

// Streaming response
await localInferenceService.streamResponse({
    model: 'llama3.1:8b',
    input: 'Summarize this.'
}, {
    backendId: 'ollama',
    onEvent: (event) => {
        // Open Responses streaming events
    }
});
```

## Backends
- WebLLM (in-browser): `/local_inference/vendor/webllm/web-llm.js`
- Ollama (local server): OpenAI-compatible inference + `/api/pull` progress
- vLLM (local server): OpenAI-compatible inference

## Tests
```bash
node --test local_inference/tests/responseUtils.test.mjs
```
