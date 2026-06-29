// zkAPI integration — low-level HTTP client for the local `zkapi-clientd`.
//
// Thin wrappers over the daemon's REST surface. Every call returns parsed JSON
// or throws an Error whose message is suitable for surfacing in the UI (the
// daemon's error envelope is `{ error: { code, message, funding_url } }`).

import { CLIENTD_BASE } from './zkapiConfig.js';

async function request(path, options = {}) {
    const url = `${CLIENTD_BASE}${path}`;
    let resp;
    try {
        resp = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
    } catch (networkErr) {
        throw new Error(
            `Cannot reach the zkAPI client daemon at ${CLIENTD_BASE}. Is it running? (${networkErr.message})`
        );
    }
    const text = await resp.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (_) {
        data = text;
    }
    if (!resp.ok) {
        const err = new Error(
            data?.error?.message || data?.message || `zkAPI daemon error (${resp.status})`
        );
        err.status = resp.status;
        err.code = data?.error?.code || null;
        err.fundingUrl = data?.error?.funding_url || null;
        err.data = data;
        throw err;
    }
    return data;
}

const zkapiClient = {
    base: CLIENTD_BASE,

    /** Integration config: credit scale, caps, modes available, funding params. */
    getConfig() {
        return request('/zkapi/v1/config');
    },

    /** Wallet status: { has_note, pending_request, funding_url, note? }. */
    getWalletStatus() {
        return request('/wallet/status');
    },

    /** Rolled-up overview used by the funding flow (wallet + funding + server). */
    getDemoOverview() {
        return request('/funding/api/demo');
    },

    /** Funding page config (vault address, chain id, demo defaults). */
    getFundingConfig() {
        return request('/funding/config');
    },

    /** Advertised model list (OpenAI format: { data: [{ id, ... }] }). */
    getModels() {
        return request('/v1/models');
    },

    /** Mode 1: run an OpenAI-style chat completion through the full zkAPI path. */
    inference(body) {
        return request('/zkapi/v1/inference', {
            method: 'POST',
            body: JSON.stringify(body)
        });
    },

    /** Mode 2: mint a credit-limited ephemeral OpenRouter key. */
    ephemeralIssue({ limitUsd, model } = {}) {
        return request('/zkapi/v1/ephemeral/issue', {
            method: 'POST',
            body: JSON.stringify({
                ...(limitUsd != null ? { limit_usd: limitUsd } : {}),
                ...(model ? { model } : {})
            })
        });
    },

    /** Mode 2: settle a generation's real cost against the zkAPI note. */
    ephemeralSettle({ keyHash, reportedCostUsd, promptTokens, completionTokens, model }) {
        return request('/zkapi/v1/ephemeral/settle', {
            method: 'POST',
            body: JSON.stringify({
                key_hash: keyHash,
                reported_cost_usd: reportedCostUsd || 0,
                ...(promptTokens != null ? { prompt_tokens: promptTokens } : {}),
                ...(completionTokens != null ? { completion_tokens: completionTokens } : {}),
                ...(model ? { model } : {})
            })
        });
    },

    /** Deposit step 1: generate the commitment + indexer snapshot. */
    prepareDeposit(amount) {
        return request('/funding/api/deposit/prepare', {
            method: 'POST',
            body: JSON.stringify({ amount })
        });
    },

    /** Deposit step 2: activate the note locally after the on-chain deposit. */
    confirmDeposit({ secret, noteId, amount, expiryTs }) {
        return request('/funding/api/deposit/confirm', {
            method: 'POST',
            body: JSON.stringify({
                secret,
                note_id: noteId,
                amount,
                expiry_ts: expiryTs
            })
        });
    },

    /** Build a withdrawal plan (mutual close) for on-chain settlement. */
    withdraw({ mode = 'mutual', destination }) {
        return request('/funding/api/withdraw', {
            method: 'POST',
            body: JSON.stringify({ mode, destination })
        });
    }
};

if (typeof window !== 'undefined') {
    window.zkapiClient = zkapiClient;
}

export default zkapiClient;
