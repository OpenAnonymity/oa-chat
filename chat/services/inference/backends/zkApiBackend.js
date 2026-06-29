// zkAPI inference backend for oa-chat.
//
// Routes chat through the local `zkapi-clientd` so every request is an
// unlinkable, paid zkAPI call. Two billing modes (selected in the zkAPI panel):
//
//   passthrough (Mode 1): clientd -> serverd -> provider. Server sees the prompt
//                         but cannot link it to the user. Non-streaming at the
//                         daemon; we simulate streaming for the UI.
//   ephemeral  (Mode 2): clientd mints a credit-limited OpenRouter key; the
//                        browser streams from OpenRouter DIRECTLY (server never
//                        sees the prompt); clientd settles the real usage cost.
//
// Crucially, this backend bypasses oa-chat's ticket/station access pipeline: the
// funded zkAPI note IS the payment. `getAccessToken` always returns a sentinel
// and `isAccessExpired` is always false, so `sendMessage` never calls the
// ticket-gated acquisition flow. Payment is enforced by clientd (a 402 with a
// funding hint surfaces if the wallet is unfunded).

import zkapiClient from '../../zkapi/zkapiClient.js';
import zkapiLedger from '../../zkapi/zkapiLedger.js';
import {
    getBillingMode,
    getCreditsPerUsd,
    creditsToUsd
} from '../../zkapi/zkapiConfig.js';

const ACCESS_SENTINEL = 'zkapi-note';

// One ephemeral OpenRouter key per tab, reused across messages until exhausted.
const ephemeralState = {
    key: null,
    keyHash: null,
    baseUrl: null,
    limitUsd: null
};

function fallbackModels() {
    return [
        { id: 'gpt-4o-mini', name: 'GPT-4o mini', category: 'Flagship models', categoryPriority: 1, provider: 'OpenAI', context_length: 128000, pricing: null }
    ];
}

/** Map clientd's OpenAI-format model list into oa-chat's model objects. */
function mapModels(list) {
    const data = Array.isArray(list?.data) ? list.data : [];
    const models = data
        .map(m => {
            if (!m || typeof m.id !== 'string') return null;
            const provider = (m.id.includes('/') ? m.id.split('/')[0] : (m.owned_by || 'zkAPI'));
            return {
                id: m.id,
                name: m.id,
                category: 'zkAPI models',
                categoryPriority: 1,
                provider: provider.charAt(0).toUpperCase() + provider.slice(1),
                context_length: m.context_length || null,
                pricing: m.pricing || null
            };
        })
        .filter(Boolean);
    return models.length ? models : fallbackModels();
}

/** Strip oa-chat message objects down to the {role, content} the API wants. */
function cleanMessages(messages) {
    return (messages || []).map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : (m.content ?? '')
    }));
}

/** Emit text as several chunks so Mode 1 (non-streaming) still feels live. */
async function emitSimulatedStream(text, onChunk, abortController) {
    const tokens = String(text).match(/\S+\s*|\s+/g) || [text];
    let buf = '';
    for (const tok of tokens) {
        if (abortController?.signal?.aborted) break;
        buf += tok;
        if (buf.length >= 18) {
            onChunk(buf);
            buf = '';
            await new Promise(r => setTimeout(r, 8));
        }
    }
    if (buf && !abortController?.signal?.aborted) onChunk(buf);
}

/** Mode 1: pass-through inference with full zkAPI inspection. */
async function streamPassthrough(messages, modelId, callbacks, abortController) {
    const { onChunk, onTokenUpdate, onStreamOpen } = callbacks;
    const startedAt = Date.now();
    const body = { model: modelId, messages: cleanMessages(messages) };

    let result;
    try {
        result = await zkapiClient.inference(body);
    } catch (err) {
        zkapiLedger.recordError({ mode: 'passthrough', kind: 'inference', model: modelId, label: 'Pass-through inference', error: err.message });
        throw err;
    }

    const payload = result?.response?.payload || {};
    const choice = payload?.choices?.[0]?.message?.content;
    const text = typeof choice === 'string' ? choice : (result?.response?.raw_payload || '');
    const usage = payload?.usage || null;

    if (onStreamOpen) onStreamOpen();
    await emitSimulatedStream(text, onChunk, abortController);

    const entry = zkapiLedger.record(result, {
        mode: 'passthrough',
        kind: 'inference',
        label: 'Pass-through inference',
        model: payload?.model || modelId,
        latencyMs: Date.now() - startedAt,
        usage
    });

    if (onTokenUpdate && usage) {
        onTokenUpdate({
            completionTokens: usage.completion_tokens || 0,
            promptTokens: usage.prompt_tokens || 0,
            totalTokens: usage.total_tokens || 0
        });
    }

    return {
        totalTokens: usage?.total_tokens || 0,
        promptTokens: usage?.prompt_tokens || 0,
        completionTokens: usage?.completion_tokens || 0,
        model: payload?.model || modelId,
        reasoning: null,
        citations: null,
        zkapiEntryId: entry.id
    };
}

/**
 * Ensure a usable ephemeral OpenRouter key, minting one via clientd if needed.
 * Returns an immutable SNAPSHOT (not the shared singleton) so a concurrent
 * re-mint can't swap the key/hash out from under an in-flight stream or settle.
 */
async function ensureEphemeralKey(modelId, forceNew = false) {
    if (!forceNew && ephemeralState.key) return { ...ephemeralState };
    const config = zkapiLedger.getConfig();
    const limitUsd = config?.request_charge_cap_usd || 0.25;
    const issue = await zkapiClient.ephemeralIssue({ limitUsd, model: modelId });
    const payload = issue?.response?.payload || {};
    ephemeralState.key = payload.ephemeral_key;
    ephemeralState.keyHash = payload.key_hash;
    ephemeralState.baseUrl = payload.base_url;
    ephemeralState.limitUsd = payload.limit_usd;
    // Record the issuance (charge 0) so the ledger shows the full Mode 2 flow.
    zkapiLedger.record(issue, {
        mode: 'ephemeral',
        kind: 'ephemeral_issue',
        label: 'Ephemeral key issued',
        model: modelId,
        extra: { keyHash: payload.key_hash, limitUsd: payload.limit_usd }
    });
    return { ...ephemeralState };
}

/** Stream a completion straight from OpenRouter using the ephemeral key. */
async function streamFromOpenRouter(eph, modelId, messages, callbacks, abortController) {
    const { onChunk, onStreamOpen } = callbacks;
    const resp = await fetch(`${eph.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${eph.key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://openanonymity.ai',
            'X-Title': 'oa-chat × zkAPI'
        },
        body: JSON.stringify({
            model: modelId,
            messages: cleanMessages(messages),
            stream: true,
            usage: { include: true }
        }),
        signal: abortController?.signal
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const err = new Error(`OpenRouter stream failed (${resp.status}): ${errText.slice(0, 200)}`);
        err.status = resp.status;
        throw err;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let usage = null;
    let opened = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (data === '[DONE]') continue;
            let json;
            try { json = JSON.parse(data); } catch (_) { continue; }
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
                if (!opened) { opened = true; if (onStreamOpen) onStreamOpen(); }
                content += delta;
                onChunk(delta);
            }
            if (json.usage) usage = json.usage;
        }
    }
    if (!opened && onStreamOpen) onStreamOpen();
    return { content, usage };
}

/** Mode 2: ephemeral-key flow — issue, stream direct, settle. */
async function streamEphemeral(messages, modelId, callbacks, abortController) {
    const { onTokenUpdate } = callbacks;
    const startedAt = Date.now();

    let eph = await ensureEphemeralKey(modelId);
    let streamed;
    try {
        streamed = await streamFromOpenRouter(eph, modelId, messages, callbacks, abortController);
    } catch (err) {
        // Key likely exhausted/expired — re-mint once and retry.
        if (err.status === 401 || err.status === 402 || err.status === 403) {
            eph = await ensureEphemeralKey(modelId, true);
            streamed = await streamFromOpenRouter(eph, modelId, messages, callbacks, abortController);
        } else {
            zkapiLedger.recordError({ mode: 'ephemeral', kind: 'direct_stream', model: modelId, label: 'Ephemeral stream', error: err.message });
            throw err;
        }
    }

    const usage = streamed.usage || {};
    const costUsd = typeof usage.cost === 'number' ? usage.cost : 0;

    // Settle the real usage cost against the zkAPI note.
    let settle = null;
    try {
        settle = await zkapiClient.ephemeralSettle({
            keyHash: eph.keyHash,
            reportedCostUsd: costUsd,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            model: modelId
        });
        zkapiLedger.record(settle, {
            mode: 'ephemeral',
            kind: 'ephemeral_settle',
            label: 'Usage settled',
            model: modelId,
            latencyMs: Date.now() - startedAt,
            usage: {
                prompt_tokens: usage.prompt_tokens || 0,
                completion_tokens: usage.completion_tokens || 0,
                total_tokens: usage.total_tokens || 0,
                cost: costUsd
            },
            extra: { keyHash: eph.keyHash }
        });
    } catch (err) {
        zkapiLedger.recordError({ mode: 'ephemeral', kind: 'ephemeral_settle', model: modelId, label: 'Settle failed', error: err.message });
    }

    if (onTokenUpdate && usage) {
        onTokenUpdate({
            completionTokens: usage.completion_tokens || 0,
            promptTokens: usage.prompt_tokens || 0,
            totalTokens: usage.total_tokens || 0
        });
    }

    return {
        totalTokens: usage.total_tokens || 0,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        model: modelId,
        reasoning: null,
        citations: null,
        zkapiEntryId: settle ? `settle` : null
    };
}

const zkApiBackend = {
    id: 'zkapi',
    label: 'zkAPI',
    accessLabel: 'zkAPI credits',
    accessShortLabel: 'zkAPI',
    accessType: 'zkapi-note',
    baseUrl: zkapiClient.base,
    defaultModelId: 'gpt-4o-mini',
    defaultModelName: 'GPT-4o mini',
    tls: {
        captureHosts: ['openrouter.ai'],
        verifyUrl: 'https://openrouter.ai/api/v1/models',
        displayName: 'zkAPI'
    },

    async fetchModels() {
        try {
            const list = await zkapiClient.getModels();
            return mapModels(list);
        } catch (err) {
            console.warn('zkAPI fetchModels failed, using fallback', err);
            return fallbackModels();
        }
    },

    getDisplayName(modelId, fallback) {
        return fallback || modelId;
    },

    // Access is the funded note; we never route through the ticket pipeline.
    getAccessInfo(session) {
        return {
            token: ACCESS_SENTINEL,
            info: session?.zkapiAccessInfo || { type: 'zkapi-note' },
            expiresAt: null
        };
    },
    getAccessToken() {
        return ACCESS_SENTINEL;
    },
    setAccessInfo(session, accessInfo) {
        if (session) session.zkapiAccessInfo = accessInfo || { type: 'zkapi-note' };
    },
    clearAccessInfo(session) {
        if (session) session.zkapiAccessInfo = null;
    },
    isAccessExpired() {
        return false;
    },
    async requestAccess() {
        // Defensive: not used (getAccessToken is always truthy), but if invoked
        // we just confirm there is a funded note.
        const status = await zkapiClient.getWalletStatus();
        if (!status?.has_note) {
            const err = new Error('No funded zkAPI note. Open the zkAPI panel and deposit credits via MetaMask.');
            err.status = 402;
            throw err;
        }
        return { key: ACCESS_SENTINEL, token: ACCESS_SENTINEL, info: { type: 'zkapi-note' }, expiresAt: null };
    },

    // Local title generation — no extra paid request.
    async generateSessionTitle(prompt) {
        const text = (prompt || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        return text.length > 48 ? `${text.slice(0, 48)}…` : text;
    },

    streamCompletion(messages, modelId, token, onChunk, onTokenUpdate, files, searchEnabled, abortController, onStreamOpen, onReasoningChunk, reasoningEnabled, reasoningEffort) {
        if (files && files.length) {
            console.warn('zkAPI backend: file attachments are not yet supported; sending text only.');
        }
        const callbacks = { onChunk, onTokenUpdate, onStreamOpen, onReasoningChunk };
        const mode = getBillingMode();
        if (mode === 'ephemeral') {
            return streamEphemeral(messages, modelId, callbacks, abortController);
        }
        return streamPassthrough(messages, modelId, callbacks, abortController);
    },

    maskAccessToken() {
        return 'zkAPI note (unlinkable)';
    },

    buildCurlCommand(token, modelId) {
        return `curl ${zkapiClient.base}/zkapi/v1/inference \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hi"}]}'`;
    }
};

export default zkApiBackend;

// Expose ephemeral-key reset for the panel (e.g. on mode switch / re-fund).
export function resetEphemeralKey() {
    ephemeralState.key = null;
    ephemeralState.keyHash = null;
    ephemeralState.baseUrl = null;
    ephemeralState.limitUsd = null;
}
