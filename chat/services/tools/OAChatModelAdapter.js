import inferenceService from '../inference/inferenceService.js';

function createAsyncQueue() {
    const items = [];
    let resolver = null;
    let rejectedError = null;
    let done = false;

    return {
        push(item) {
            items.push(item);
            if (resolver) {
                resolver();
                resolver = null;
            }
        },
        finish() {
            done = true;
            if (resolver) {
                resolver();
                resolver = null;
            }
        },
        fail(error) {
            rejectedError = error;
            done = true;
            if (resolver) {
                resolver();
                resolver = null;
            }
        },
        async *consume() {
            while (!done || items.length > 0) {
                if (items.length === 0) {
                    await new Promise((resolve) => {
                        resolver = resolve;
                    });
                }

                while (items.length > 0) {
                    yield items.shift();
                }
            }

            if (rejectedError) {
                throw rejectedError;
            }
        }
    };
}

export default class OAChatModelAdapter {
    constructor(app) {
        this.app = app;
    }

    async *streamTurn({
        messages,
        modelId,
        session,
        files = [],
        searchEnabled = false,
        abortController = null,
        reasoningEnabled = true,
        reasoningEffort = null,
        tools = []
    }) {
        const queue = createAsyncQueue();

        const supportsStructuredToolCalling = typeof inferenceService.supportsStructuredToolCalls === 'function'
            ? inferenceService.supportsStructuredToolCalls(session)
            : typeof inferenceService.streamStructuredTurn === 'function';

        const supportsStructuredTools = Array.isArray(tools) &&
            tools.length > 0 &&
            supportsStructuredToolCalling;

        if (supportsStructuredTools) {
            inferenceService.streamStructuredTurn({
                messages,
                modelId,
                session,
                tools,
                searchEnabled,
                abortController,
                reasoningEnabled,
                reasoningEffort,
                onEvent: (event) => {
                    queue.push(event);
                }
            }).then((result) => {
                queue.push({
                    type: 'assistant.completed',
                    result: {
                        ...result,
                        message: {
                            role: 'assistant',
                            content: result?.message?.content || '',
                            toolCalls: result?.message?.toolCalls || result?.toolCalls || []
                        }
                    }
                });
                queue.finish();
            }).catch((error) => {
                queue.fail(error);
            });
        } else {
            inferenceService.streamCompletion(
                messages,
                modelId,
                session,
                (chunk, imageData) => {
                    if (chunk) {
                        queue.push({ type: 'assistant.delta', delta: chunk });
                    }
                    if (imageData?.images?.length) {
                        queue.push({ type: 'assistant.image', images: imageData.images });
                    }
                },
                (tokenUpdate) => {
                    queue.push({ type: 'assistant.usage', usage: tokenUpdate });
                },
                files,
                searchEnabled,
                abortController,
                async () => {
                    queue.push({ type: 'assistant.stream.open' });
                },
                async (reasoningChunk) => {
                    queue.push({ type: 'reasoning.delta', delta: reasoningChunk });
                },
                reasoningEnabled,
                reasoningEffort
            ).then((result) => {
                queue.push({
                    type: 'assistant.completed',
                    result: {
                        ...result,
                        message: {
                            role: 'assistant',
                            content: '',
                            toolCalls: []
                        }
                    }
                });
                queue.finish();
            }).catch((error) => {
                queue.fail(error);
            });
        }

        for await (const event of queue.consume()) {
            yield event;
        }
    }
}
