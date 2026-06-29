// zkAPI integration — in-memory ledger + event bus.
//
// The zkAPI backend records one rich "entry" per request (a decoded view of the
// clientd `RequestDemoResult`, plus mode/timing metadata). The panel subscribes
// and renders them. Entries are memory-only and tab-scoped, matching oa-chat's
// network-log philosophy. This is purely a UI surface — it never affects
// protocol state.

const MAX_ENTRIES = 200;

const state = {
    entries: [],      // newest first
    wallet: null,     // latest wallet status note
    config: null,     // latest /zkapi/v1/config
    seq: 0
};

const listeners = new Set();

function emit(event) {
    for (const fn of listeners) {
        try {
            fn(event);
        } catch (err) {
            console.error('zkapi ledger listener failed', err);
        }
    }
}

/**
 * Build a normalized ledger entry from a clientd RequestDemoResult.
 *
 * @param {object} result   the RequestDemoResult JSON
 * @param {object} meta      { mode, kind, label, model, latencyMs, sessionId, error }
 *                           kind ∈ 'inference' | 'ephemeral_issue' | 'ephemeral_settle' | 'direct_stream'
 */
function entryFromResult(result, meta = {}) {
    const preview = result?.preview || {};
    const proto = result?.protocol_response || {};
    const response = result?.response || {};
    const note = result?.wallet?.note || null;

    // Usage is in the upstream response payload (Mode 1) or supplied via meta (Mode 2).
    const payload = response.payload || null;
    const usage = meta.usage || payload?.usage || null;

    return {
        id: `zk-${++state.seq}`,
        ts: meta.ts || Date.now(),
        mode: meta.mode || 'passthrough',
        kind: meta.kind || 'inference',
        label: meta.label || 'zkAPI request',
        model: meta.model || preview?.request?.body?.model || null,
        error: meta.error || null,
        latencyMs: meta.latencyMs || null,

        // billing
        chargeApplied: proto.charge_applied ?? response.charge_applied ?? null,
        remainingBalance: response.remaining_balance ?? note?.current_balance ?? null,
        usage,

        // proof / auth (from the client preview — "what the client computed")
        payloadHash: preview.payload_hash || null,
        requestNullifier: preview.request_nullifier || proto.request_nullifier || null,
        solvencyBound: preview.solvency_bound ?? null,
        activeRoot: preview.active_root || null,
        registrationCommitment: preview.registration_commitment || null,
        noteLeaf: preview.note_leaf || null,
        stateSigEpoch: preview.state_sig_epoch ?? null,
        stateSigRoot: preview.state_sig_root || null,
        runtimeProofBackend: preview.runtime_proof_backend || null,
        merkleSiblingsCount: Array.isArray(preview.merkle_siblings) ? preview.merkle_siblings.length : null,

        // next state (server-signed) — "what the server returned"
        nextAnchor: proto.next_anchor || response.next_anchor || null,
        nextCommitmentX: proto.next_commitment_x || null,
        nextCommitmentY: proto.next_commitment_y || null,
        blindDeltaSrv: proto.blind_delta_srv || null,
        nextStateSigEpoch: proto.next_state_sig_epoch ?? null,
        nextStateSigRoot: proto.next_state_sig_root || null,
        responseCode: proto.response_code ?? response.response_code ?? null,
        responseHash: proto.response_hash || null,

        // the exact request the client serialized + hashed
        requestPath: preview?.request?.path || null,
        requestRaw: preview?.payload || null,

        // mode-2 specifics
        extra: meta.extra || null
        // NB: we deliberately do NOT retain the full RequestDemoResult here — in
        // ephemeral mode it contains the live OpenRouter secret key, which
        // shouldn't linger in tab memory / window.zkapiLedger.
    };
}

const zkapiLedger = {
    subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },

    getEntries() {
        return state.entries.slice();
    },

    getWallet() {
        return state.wallet;
    },

    getConfig() {
        return state.config;
    },

    setConfig(config) {
        state.config = config;
        emit({ type: 'config', config });
    },

    setWallet(note) {
        state.wallet = note;
        emit({ type: 'wallet', note });
    },

    /** Record a successful request and return the entry. */
    record(result, meta) {
        const entry = entryFromResult(result, meta);
        state.entries.unshift(entry);
        if (state.entries.length > MAX_ENTRIES) state.entries.pop();
        if (result?.wallet?.note) {
            state.wallet = result.wallet.note;
        }
        emit({ type: 'entry', entry });
        return entry;
    },

    /** Record a failed request (no RequestDemoResult). */
    recordError(meta) {
        const entry = entryFromResult({}, { ...meta, error: meta.error || 'request failed' });
        state.entries.unshift(entry);
        if (state.entries.length > MAX_ENTRIES) state.entries.pop();
        emit({ type: 'entry', entry });
        return entry;
    },

    clear() {
        state.entries = [];
        emit({ type: 'clear' });
    }
};

if (typeof window !== 'undefined') {
    window.zkapiLedger = zkapiLedger;
}

export default zkapiLedger;
