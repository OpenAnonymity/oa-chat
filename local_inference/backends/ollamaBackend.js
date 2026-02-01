import { createOpenAICompatibleBackend } from './httpOpenAIBackend.js';

async function readJsonLines(response, onLine) {
    if (!response.body) {
        throw new Error('Streaming response body is not available.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed);
                onLine(parsed);
            } catch (error) {
                console.warn('Ollama pull parse error:', error);
            }
        }
    }

    const remaining = buffer.trim();
    if (remaining) {
        try {
            const parsed = JSON.parse(remaining);
            onLine(parsed);
        } catch (error) {
            console.warn('Ollama pull parse error:', error);
        }
    }
}

const ollamaBackend = createOpenAICompatibleBackend({
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434',
    defaultModelId: 'llama3.1:8b',
    defaultModelName: 'Llama 3.1 8B (Ollama)',
    providerLabel: 'Ollama',
    modelsEndpoint: '/v1/models',
    chatEndpoint: '/v1/chat/completions'
});

ollamaBackend.fetchModels = async function fetchModels() {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
        return [{
            id: this.defaultModelId,
            name: this.defaultModelName,
            category: 'Local models',
            provider: 'Ollama'
        }];
    }

    const response = await fetch(`${baseUrl}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch Ollama models (${response.status})`);
    }

    const payload = await response.json();
    const models = (payload?.models || []).map(model => ({
        id: model.name,
        name: model.name,
        category: 'Local models',
        provider: 'Ollama',
        context_length: model.context_length || null
    }));

    return models.length > 0 ? models : [{
        id: this.defaultModelId,
        name: this.defaultModelName,
        category: 'Local models',
        provider: 'Ollama'
    }];
};

ollamaBackend.prepareModel = async function prepareModel(modelId, { emitStatus, signal } = {}) {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
        throw new Error('Ollama base URL is not configured.');
    }

    emitStatus?.({ type: 'model.pull.start', modelId });

    const response = await fetch(`${baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelId, stream: true }),
        signal
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData?.error || `HTTP ${response.status}`;
        emitStatus?.({ type: 'model.pull.error', modelId, error: new Error(errorMessage) });
        throw new Error(errorMessage);
    }

    await readJsonLines(response, (payload) => {
        const total = payload?.total || null;
        const completed = payload?.completed || null;
        const progress = total && completed ? completed / total : null;
        emitStatus?.({
            type: 'model.pull.progress',
            modelId,
            progress,
            status: payload?.status || null
        });
    });

    emitStatus?.({ type: 'model.pull.done', modelId });
    return true;
};

export default ollamaBackend;
