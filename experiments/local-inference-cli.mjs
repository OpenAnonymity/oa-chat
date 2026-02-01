import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { localInferenceService } from '../local_inference/index.js';

const DEFAULT_BACKENDS = {
    ollama: 'http://127.0.0.1:11434',
    vllm: 'http://127.0.0.1:8000'
};

function normalizeBackend(value) {
    const trimmed = String(value || '').trim().toLowerCase();
    if (!trimmed) return null;
    return trimmed;
}

async function prompt(rl, question, fallback = '') {
    const answer = await rl.question(question);
    const trimmed = answer.trim();
    return trimmed === '' ? fallback : trimmed;
}

async function readMultiline(rl, header) {
    output.write(`${header}\n`);
    const lines = [];
    while (true) {
        const line = await rl.question('> ');
        if (line.trim() === '') break;
        lines.push(line);
    }
    return lines.join('\n').trim();
}

async function main() {
    const rl = readline.createInterface({ input, output });
    try {
        output.write('Local Inference CLI (auxiliary tasks)\n');
        output.write('Use Ollama or vLLM for quick local tests.\n\n');

        const backendInput = await prompt(
            rl,
            `Backend [ollama|vllm] (${DEFAULT_BACKENDS.ollama ? 'ollama' : 'vllm'}): `,
            'ollama'
        );

        const backendId = normalizeBackend(backendInput);
        if (!backendId || backendId === 'webllm') {
            output.write('WebLLM requires a browser environment. Use the WebLLM demo in a browser instead.\n');
            return;
        }

        if (!DEFAULT_BACKENDS[backendId]) {
            output.write(`Unknown backend: ${backendId}\n`);
            return;
        }

        const baseUrl = await prompt(
            rl,
            `Base URL [${DEFAULT_BACKENDS[backendId]}]: `,
            DEFAULT_BACKENDS[backendId]
        );

        localInferenceService.configureBackend(backendId, { baseUrl });

        const modelId = await prompt(rl, 'Model ID: ', backendId === 'ollama' ? 'llama3.1:8b' : 'local-model');
        const mode = await prompt(rl, 'Mode [completion|embedding] (completion): ', 'completion');

        const systemPrompt = await readMultiline(rl, 'System prompt (optional, blank line to finish):');

        const statusUnsub = localInferenceService.onStatus((event) => {
            if (!event || event.backendId !== backendId) return;
            if (event.type && event.type.startsWith('model.')) {
                output.write(`\n[status] ${event.type} ${event.modelId || ''} ${event.progress ? `${Math.round(event.progress * 100)}%` : ''}\n`);
            }
        });

        if (mode === 'embedding') {
            const text = await readMultiline(rl, 'Embedding input (blank line to finish):');
            if (!text) {
                output.write('No input provided.\n');
                return;
            }
            const result = await localInferenceService.createEmbedding({ model: modelId, input: text }, { backendId, systemPrompt });
            const vector = result?.data?.[0]?.embedding || [];
            output.write(`Embedding length: ${vector.length}\n`);
            output.write(`Embedding preview: ${vector.slice(0, 8).join(', ')}\n`);
            return;
        }

        const shouldStream = (await prompt(rl, 'Stream output? [y/N]: ', 'n')).toLowerCase().startsWith('y');
        const userInput = await readMultiline(rl, 'User input (blank line to finish):');
        if (!userInput) {
            output.write('No input provided.\n');
            return;
        }

        if (!shouldStream) {
            const response = await localInferenceService.createResponse(
                { model: modelId, input: userInput },
                { backendId, systemPrompt }
            );
            const text = response?.output?.[0]?.content?.[0]?.text || '';
            output.write(`\n--- Response ---\n${text}\n`);
            return;
        }

        const abortController = new AbortController();
        const onSigInt = () => abortController.abort();
        process.once('SIGINT', onSigInt);

        output.write('\n--- Streaming ---\n');
        await localInferenceService.streamResponse(
            { model: modelId, input: userInput },
            {
                backendId,
                systemPrompt,
                signal: abortController.signal,
                onEvent: (event) => {
                    if (event.type === 'response.output_text.delta') {
                        output.write(event.delta || '');
                    }
                    if (event.type === 'response.completed') {
                        output.write('\n\n[done]\n');
                    }
                }
            }
        );

        process.removeListener('SIGINT', onSigInt);
    } finally {
        rl.close();
    }
}

main().catch((error) => {
    output.write(`\nError: ${error.message}\n`);
    process.exitCode = 1;
});
