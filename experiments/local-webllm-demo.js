import { localInferenceService } from '../local_inference/index.js';

const modelSelect = document.getElementById('model-select');
const loadModelsBtn = document.getElementById('load-models');
const prepareModelBtn = document.getElementById('prepare-model');
const clearModelBtn = document.getElementById('clear-model');
const clearAllModelsBtn = document.getElementById('clear-all-models');
const statusEl = document.getElementById('status');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const systemPromptEl = document.getElementById('system-prompt');
const temperatureEl = document.getElementById('temperature');
const topPEl = document.getElementById('top-p');
const maxTokensEl = document.getElementById('max-tokens');
const seedEl = document.getElementById('seed');
const inputEl = document.getElementById('input-text');
const outputEl = document.getElementById('output');
const runCompletionBtn = document.getElementById('run-completion');
const runStreamBtn = document.getElementById('run-stream');
const runEmbeddingBtn = document.getElementById('run-embedding');
const stopStreamBtn = document.getElementById('stop-stream');
const statElapsedEl = document.getElementById('stat-elapsed');
const statTokensEl = document.getElementById('stat-tokens');
const statTpsEl = document.getElementById('stat-tps');

let streamController = null;
let statsStart = 0;
let statsTokens = 0;
let modelIndex = new Map();

function setStatus(message, tone = 'info') {
    statusEl.textContent = message;
    statusEl.style.color = tone === 'error' ? '#f87171' : tone === 'success' ? '#34d399' : '#fbbf24';
}

function setProgress(value, label = '') {
    const safeValue = Math.max(0, Math.min(1, value || 0));
    progressBar.style.width = `${Math.round(safeValue * 100)}%`;
    progressLabel.textContent = label;
}

function clearOutput() {
    outputEl.textContent = '';
}

function appendOutput(text) {
    outputEl.textContent += text;
}

function resetStats() {
    statsStart = performance.now();
    statsTokens = 0;
    statElapsedEl.textContent = '0.00s';
    statTokensEl.textContent = '0';
    statTpsEl.textContent = '0.0';
}

function updateStats(tokenCountOverride = null) {
    const elapsedSec = Math.max(0.001, (performance.now() - statsStart) / 1000);
    const tokens = tokenCountOverride !== null ? tokenCountOverride : statsTokens;
    const tps = tokens / elapsedSec;
    statElapsedEl.textContent = `${elapsedSec.toFixed(2)}s`;
    statTokensEl.textContent = `${tokens}`;
    statTpsEl.textContent = tps.toFixed(1);
}

function getSelectedModel() {
    return modelSelect.value || '';
}

function getSystemPrompt() {
    return systemPromptEl.value.trim();
}

function parseNumber(value, fallback) {
    if (value === '' || value === null || value === undefined) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getModelControls() {
    const temperature = parseNumber(temperatureEl?.value, null);
    const topP = parseNumber(topPEl?.value, null);
    const maxTokensRaw = parseNumber(maxTokensEl?.value, null);
    const maxTokens = maxTokensRaw === null ? null : Math.max(1, Math.floor(maxTokensRaw));
    const seedRaw = parseNumber(seedEl?.value, null);
    const seed = seedRaw === null ? null : Math.trunc(seedRaw);

    return {
        temperature,
        top_p: topP,
        max_output_tokens: maxTokens,
        seed
    };
}

async function loadModels() {
    setStatus('Loading WebLLM model list...');
    loadModelsBtn.disabled = true;
    try {
        const models = await localInferenceService.fetchModels('webllm');
        const sortedModels = [...models].sort((a, b) => {
            const aVram = typeof a.vram_required_MB === 'number' ? a.vram_required_MB : Number.POSITIVE_INFINITY;
            const bVram = typeof b.vram_required_MB === 'number' ? b.vram_required_MB : Number.POSITIVE_INFINITY;
            if (aVram !== bVram) return aVram - bVram;
            return (a.name || '').localeCompare(b.name || '');
        });

        modelIndex = new Map(sortedModels.map(model => [model.id, model]));
        modelSelect.innerHTML = '';
        sortedModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            const vramLabel = typeof model.vram_required_MB === 'number'
                ? ` · ${Math.round(model.vram_required_MB)}MB`
                : '';
            const lowLabel = model.low_resource_required ? ' · low' : '';
            const typeLabel = model.model_type && model.model_type !== 'llm' ? ` · ${model.model_type}` : '';
            option.textContent = `${model.name || model.id}${vramLabel}${lowLabel}${typeLabel}`;
            modelSelect.appendChild(option);
        });
        setStatus(`Loaded ${sortedModels.length} models (sorted by VRAM).`, 'success');
    } catch (error) {
        setStatus(`Failed to load models: ${error.message}`, 'error');
    } finally {
        loadModelsBtn.disabled = false;
    }
}

async function prepareModel() {
    const modelId = getSelectedModel();
    if (!modelId) {
        setStatus('Select a model first.', 'error');
        return;
    }
    setStatus(`Preparing ${modelId}...`);
    prepareModelBtn.disabled = true;
    try {
        await localInferenceService.prepareModel('webllm', modelId);
        setStatus(`${modelId} is ready.`, 'success');
    } catch (error) {
        setStatus(`Failed to prepare model: ${error.message}`, 'error');
    } finally {
        prepareModelBtn.disabled = false;
    }
}

async function clearModelCache() {
    const modelId = getSelectedModel();
    if (!modelId) {
        setStatus('Select a model first.', 'error');
        return;
    }
    const confirmClear = window.confirm(`Clear cached files for ${modelId}?`);
    if (!confirmClear) return;
    setStatus(`Clearing cache for ${modelId}...`);
    clearModelBtn.disabled = true;
    try {
        await localInferenceService.clearModelCache('webllm', modelId);
        setStatus(`Cleared cache for ${modelId}.`, 'success');
        setProgress(0, '');
    } catch (error) {
        setStatus(`Failed to clear cache: ${error.message}`, 'error');
    } finally {
        clearModelBtn.disabled = false;
    }
}

async function clearAllModelCache() {
    const confirmClear = window.confirm('Clear cached files for all WebLLM models?');
    if (!confirmClear) return;
    setStatus('Clearing all model caches...');
    clearAllModelsBtn.disabled = true;
    try {
        const result = await localInferenceService.clearAllModelCache('webllm');
        const failedCount = result?.failed?.length || 0;
        if (failedCount > 0) {
            setStatus(`Cleared ${result.cleared} models, ${failedCount} failed.`, 'error');
        } else {
            setStatus(`Cleared ${result.cleared} models.`, 'success');
        }
        setProgress(0, '');
    } catch (error) {
        setStatus(`Failed to clear caches: ${error.message}`, 'error');
    } finally {
        clearAllModelsBtn.disabled = false;
    }
}

async function runCompletion() {
    const modelId = getSelectedModel();
    const input = inputEl.value.trim();
    if (!modelId || !input) {
        setStatus('Provide both a model and input.', 'error');
        return;
    }
    clearOutput();
    resetStats();
    setStatus('Running completion...');
    runCompletionBtn.disabled = true;
    try {
        const controls = getModelControls();
        const response = await localInferenceService.createResponse(
            { model: modelId, input, ...controls },
            { backendId: 'webllm', systemPrompt: getSystemPrompt() }
        );
        const text = response?.output?.[0]?.content?.[0]?.text || '';
        const outputTokens = response?.usage?.output_tokens || (text.length ? Math.ceil(text.length / 4) : 0);
        appendOutput(text);
        updateStats(outputTokens);
        setStatus('Completion finished.', 'success');
    } catch (error) {
        setStatus(`Error: ${error.message}`, 'error');
    } finally {
        runCompletionBtn.disabled = false;
    }
}

async function runStream() {
    const modelId = getSelectedModel();
    const input = inputEl.value.trim();
    if (!modelId || !input) {
        setStatus('Provide both a model and input.', 'error');
        return;
    }
    clearOutput();
    resetStats();
    setStatus('Streaming...');
    runStreamBtn.disabled = true;
    stopStreamBtn.disabled = false;

    streamController = new AbortController();
    try {
        const controls = getModelControls();
        await localInferenceService.streamResponse(
            { model: modelId, input, ...controls },
            {
                backendId: 'webllm',
                systemPrompt: getSystemPrompt(),
                signal: streamController.signal,
                onEvent: (event) => {
                    if (event.type === 'response.output_text.delta') {
                        const deltaText = event.delta || '';
                        appendOutput(deltaText);
                        const length = outputEl.textContent.length;
                        statsTokens = length ? Math.ceil(length / 4) : 0;
                        updateStats();
                    }
                }
            }
        );
        setStatus('Stream complete.', 'success');
    } catch (error) {
        if (error?.isCancelled || error?.name === 'AbortError') {
            setStatus('Stream cancelled.', 'error');
        } else {
            setStatus(`Error: ${error.message}`, 'error');
        }
    } finally {
        runStreamBtn.disabled = false;
        stopStreamBtn.disabled = true;
        streamController = null;
    }
}

async function runEmbedding() {
    const modelId = getSelectedModel();
    const input = inputEl.value.trim();
    if (!modelId || !input) {
        setStatus('Provide both a model and input.', 'error');
        return;
    }
    const modelMeta = modelIndex.get(modelId);
    if (modelMeta?.model_type && modelMeta.model_type !== 'embedding') {
        setStatus(`Selected model is ${modelMeta.model_type}. Choose an embedding model (snowflake-arctic-embed-*).`, 'error');
        return;
    }
    clearOutput();
    resetStats();
    setStatus('Creating embedding...');
    runEmbeddingBtn.disabled = true;
    try {
        const response = await localInferenceService.createEmbedding(
            { model: modelId, input },
            { backendId: 'webllm' }
        );
        const vector = response?.data?.[0]?.embedding || [];
        appendOutput(`Embedding length: ${vector.length}\n`);
        appendOutput(`Preview: ${vector.slice(0, 16).join(', ')}`);
        updateStats(0);
        setStatus('Embedding complete.', 'success');
    } catch (error) {
        setStatus(`Error: ${error.message}`, 'error');
    } finally {
        runEmbeddingBtn.disabled = false;
    }
}

localInferenceService.onStatus((event) => {
    if (!event || event.backendId !== 'webllm') return;
    if (event.type === 'model.load.start') {
        setStatus(`Loading model ${event.modelId}...`);
        setProgress(0);
    }
    if (event.type === 'model.load.progress') {
        setStatus(event.text || 'Downloading model...');
        if (typeof event.progress === 'number') {
            setProgress(event.progress, `${Math.round(event.progress * 100)}%`);
        }
    }
    if (event.type === 'model.load.ready') {
        setStatus(`Model ready: ${event.modelId}`, 'success');
        setProgress(1, 'Ready');
    }
    if (event.type === 'model.load.error') {
        const message = event.error?.message || 'Failed to load model.';
        setStatus(message, 'error');
    }
});

loadModelsBtn.addEventListener('click', loadModels);
prepareModelBtn.addEventListener('click', prepareModel);
clearModelBtn.addEventListener('click', clearModelCache);
clearAllModelsBtn.addEventListener('click', clearAllModelCache);
runCompletionBtn.addEventListener('click', runCompletion);
runStreamBtn.addEventListener('click', runStream);
runEmbeddingBtn.addEventListener('click', runEmbedding);
stopStreamBtn.addEventListener('click', () => {
    if (streamController) {
        streamController.abort();
    }
});

// Auto-load model list on first render
loadModels();
