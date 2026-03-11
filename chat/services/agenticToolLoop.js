/**
 * AgenticToolLoop — Backend-agnostic agentic tool-calling loop.
 *
 * Sends messages to an LLM with OpenAI-format tool definitions, executes
 * tool calls locally, and loops until the LLM stops calling tools or a
 * terminal tool is invoked.
 */
import { localInferenceService } from '../../local_inference/index.js';

const DEFAULT_MODEL = 'gpt-oss-120b';
const DEFAULT_BACKEND_ID = 'tinfoil';
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_OUTPUT_TOKENS = 500;
const DEFAULT_TEMPERATURE = 0;

/**
 * Run an agentic tool-calling loop.
 *
 * @param {object} options
 * @param {string} [options.model] — model ID (default gpt-oss-120b)
 * @param {string} [options.backendId] — backend ID (default tinfoil)
 * @param {Array} options.tools — OpenAI-format tool definitions
 * @param {object} options.toolExecutors — { name: async (args) => resultString }
 * @param {Array} options.messages — initial messages (system + user)
 * @param {string} [options.terminalTool] — tool name that ends the loop, returning its args
 * @param {number} [options.maxIterations] — max loop iterations (default 10)
 * @param {number} [options.maxOutputTokens] — per-call token limit (default 500)
 * @param {number} [options.temperature] — sampling temperature (default 0)
 * @param {function} [options.onToolCall] — callback(name, args, result) for progress
 * @param {AbortSignal} [options.signal] — cancellation signal
 *
 * @returns {Promise<{textResponse: string, terminalToolResult: object|null, messages: Array, iterations: number, toolCallLog: Array}>}
 */
export async function runAgenticToolLoop(options) {
    const {
        model = DEFAULT_MODEL,
        backendId = DEFAULT_BACKEND_ID,
        tools,
        toolExecutors,
        messages: initialMessages,
        terminalTool = null,
        maxIterations = DEFAULT_MAX_ITERATIONS,
        maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
        temperature = DEFAULT_TEMPERATURE,
        onToolCall = null,
        onModelText = null,
        signal = null
    } = options;

    const messages = [...initialMessages];
    const toolCallLog = [];
    let textResponse = '';
    let terminalToolResult = null;
    let iterations = 0;

    for (let i = 0; i < maxIterations; i++) {
        if (signal?.aborted) break;
        iterations++;

        const response = await localInferenceService.createResponse({
            model,
            input: messages.map(m => ({
                role: m.role,
                content: m.content,
                ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
            })),
            tools,
            max_output_tokens: maxOutputTokens,
            temperature,
            stream: false
        }, { backendId, signal });

        const responseToolCalls = response.tool_calls || [];
        const responseText = _extractOutputText(response);

        console.log(`[AgenticLoop] Iteration ${iterations}: ${responseToolCalls.length} tool call(s)${responseText ? ', text: ' + responseText.slice(0, 100) : ''}`);

        // Forward model text to caller (even alongside tool calls)
        if (responseText && onModelText) {
            onModelText(responseText, iterations);
        }

        // No tool calls → LLM is done, return text response
        if (responseToolCalls.length === 0) {
            textResponse = responseText;
            console.log(`[AgenticLoop] Done — no more tool calls after ${iterations} iteration(s). Text response: ${responseText ? responseText.length + ' chars' : 'empty'}`);
            break;
        }

        // Append assistant message with tool_calls to conversation
        messages.push({
            role: 'assistant',
            content: responseText || null,
            tool_calls: responseToolCalls
        });

        // Execute each tool call
        let hitTerminal = false;
        for (const tc of responseToolCalls) {
            const toolName = tc.function?.name || tc.name || '';
            let args;
            try {
                args = typeof tc.function?.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : (tc.function?.arguments || {});
            } catch {
                args = {};
            }

            const toolCallId = tc.id || '';

            // Check for terminal tool
            if (terminalTool && toolName === terminalTool) {
                console.log(`[AgenticLoop] Terminal tool: ${toolName}`, Object.keys(args));
                terminalToolResult = { name: toolName, arguments: args };
                toolCallLog.push({ name: toolName, args, result: '[terminal]', toolCallId });
                onToolCall?.(toolName, args, '[terminal]');

                // Still need to append tool result so conversation is valid
                messages.push({
                    role: 'tool',
                    content: JSON.stringify({ acknowledged: true }),
                    tool_call_id: toolCallId
                });
                hitTerminal = true;
                break;
            }

            // Execute the tool
            let result;
            const executor = toolExecutors[toolName];
            if (!executor) {
                result = JSON.stringify({ error: `Unknown tool: ${toolName}` });
            } else {
                try {
                    result = await executor(args);
                } catch (err) {
                    result = JSON.stringify({ error: `Tool error: ${err.message}` });
                }
            }

            console.log(`[AgenticLoop] Tool: ${toolName}`, args, '->', typeof result === 'string' ? result.slice(0, 200) : result);
            toolCallLog.push({ name: toolName, args, result, toolCallId });
            onToolCall?.(toolName, args, result);

            // Append tool result
            messages.push({
                role: 'tool',
                content: typeof result === 'string' ? result : JSON.stringify(result),
                tool_call_id: toolCallId
            });
        }

        if (hitTerminal) break;
    }

    if (iterations >= maxIterations && !terminalToolResult && !textResponse) {
        console.warn(`[AgenticLoop] Hit max iterations (${maxIterations}) without terminal tool or text response`);
    }

    console.log(`[AgenticLoop] Summary: ${iterations} iteration(s), ${toolCallLog.length} tool call(s)${terminalToolResult ? ', terminal: ' + terminalToolResult.name : ''}${textResponse ? ', text response: ' + textResponse.length + ' chars' : ''}`);

    return {
        textResponse,
        terminalToolResult,
        messages,
        iterations,
        toolCallLog
    };
}

function _extractOutputText(response) {
    if (!response) return '';
    if (typeof response.output_text === 'string') return response.output_text;
    const output = Array.isArray(response.output) ? response.output : [];
    for (const item of output) {
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const part of content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') {
                return part.text;
            }
        }
    }
    return '';
}
