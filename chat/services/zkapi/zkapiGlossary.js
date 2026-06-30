// zkAPI field glossary — plain-language explanations of every field the UI
// surfaces, written for a CS-literate power user who isn't a cryptographer.
//
// Each entry is { title, desc }. The desc explains WHAT the value is, HOW it's
// derived (briefly), and WHY it matters (the privacy/security property it buys).
// The same glossary backs the client panel and the server dashboard so the
// explanations stay identical.

const GLOSSARY = {
    // ---- billing ----------------------------------------------------------
    charge: {
        title: 'Charge',
        desc: 'What you were billed for this request, in credits. 1 credit = 1 micro-dollar ($0.000001), so 1,000,000 credits = $1. It is computed from the upstream LLM\'s actual token usage (and price), then deducted from your hidden balance by homomorphic arithmetic on a commitment — the server never sees the balance, only subtracts the charge from its committed form.'
    },
    remaining_balance: {
        title: 'Remaining balance',
        desc: 'Your note\'s balance after this charge, in credits, as tracked locally by your wallet. On the wire the balance is never sent in the clear — only a re-randomized commitment to it — so this number lives on your machine, not the server\'s.'
    },
    cost_usd: {
        title: 'Provider cost',
        desc: 'What the upstream LLM actually cost for this call, in US dollars. For OpenRouter it is the exact figure the provider reports (usage.cost); for OpenAI it is token-counts × OpenAI\'s published per-token prices. The credit charge is just this number scaled to micro-dollars and rounded up.'
    },
    cost_source: {
        title: 'Cost source',
        desc: 'Where the dollar cost came from: openrouter_reported = the provider returned an exact cost; openai_table = computed from token counts and our built-in OpenAI price list; a *_fallback variant means the model wasn\'t in the table and was priced at a default rate.'
    },
    tokens: {
        title: 'Tokens',
        desc: 'Token counts for the call: prompt (your input) and completion (the model\'s output). LLM pricing is per-token, so these are what the cost is computed from.'
    },
    latency: {
        title: 'Latency',
        desc: 'Time spent on the upstream LLM call (and, on the dashboard, total server processing). Purely informational — it doesn\'t affect billing.'
    },
    billing_label: {
        title: 'Billing path',
        desc: 'Which billing path produced this charge: passthrough:openai / passthrough:openrouter (the server forwarded your prompt and billed token usage), ephemeral:issue (a credit-limited key was minted; charge 0), or ephemeral:settle (the usage accumulated on a minted key was billed when it expired).'
    },

    // ---- authentication & payment proof ----------------------------------
    request_nullifier: {
        title: 'Request nullifier',
        desc: 'A one-time "spend token" for this request, computed as Poseidon(secret, current_anchor). Think of it as a unique serial number that consumes your current wallet state: the server records it and rejects any repeat, which is how double-spends and replays are prevented. Because it\'s a hash of your secret (which never leaves your machine), the server can confirm you\'re entitled to spend without learning your secret or which on-chain note you hold. Every request gets a fresh nullifier, so the server can\'t tell two requests came from the same wallet.'
    },
    payload_hash: {
        title: 'Payload hash',
        desc: 'A hash of the exact request bytes you sent (the serialized prompt envelope). It is bound into the zero-knowledge proof, so the server can\'t silently swap your request for a different one, and your client can later confirm the response it got corresponds to this exact request.'
    },
    solvency_bound: {
        title: 'Solvency bound',
        desc: 'The maximum the server is pre-authorized to charge for this request — your per-request spending cap. Your zero-knowledge proof asserts balance ≥ solvency_bound WITHOUT revealing the balance, so the server is convinced you can cover the worst case. The actual charge (decided after the LLM call) must be ≤ this bound.'
    },
    active_root: {
        title: 'Active root',
        desc: 'The current Merkle-tree root of all live on-chain notes, mirrored from the blockchain by the indexer. Your proof demonstrates that your note is a leaf in this tree (membership) without revealing which leaf. The server checks this root matches its own view of the chain, so everyone is validating against the same on-chain state; a stale root is rejected and retried.'
    },
    anon_commitment: {
        title: 'Anon commitment',
        desc: 'A Pedersen commitment to your hidden balance: a point on an elliptic curve, E(balance, blinding) = balance·G + blinding·H. The blinding factor randomizes it so the point reveals nothing about the balance, yet the server can still do arithmetic on it. The "anon" form is freshly re-randomized for this request so it can\'t be matched to your previous commitments.'
    },
    statement_type: {
        title: 'Statement type',
        desc: 'An integer tag for what the zero-knowledge proof proves: 1 = a paid API request, 2 = a withdrawal. It lets a single verifier handle several proof shapes unambiguously.'
    },
    state_sig_epoch: {
        title: 'State-sig epoch',
        desc: 'The server signs every new wallet state with a one-time hash-based (XMSS) signature. The epoch identifies which signing key-tree was used. Epoch 0 means a brand-new (genesis) note that hasn\'t been signed yet; later requests carry the real epoch.'
    },
    state_sig_root: {
        title: 'State-sig root',
        desc: 'The public root of the server\'s XMSS signing key-tree for this epoch, published on-chain. Your client verifies the server\'s signature on your next state against this trusted root, so a malicious server can\'t forge a state transition or charge.'
    },
    proof_public_output_hash: {
        title: 'Proof public-output hash',
        desc: 'A hash (Keccak over the proof\'s canonical public output felts) that binds the proof blob to its public inputs. It stops a valid proof from being reused with different inputs — the server checks it equals the hash of the public inputs you submitted.'
    },
    proof_size_bytes: {
        title: 'Proof size',
        desc: 'The size, in bytes, of the (base64-decoded) proof blob the client submitted. Informational.'
    },
    merkle_siblings: {
        title: 'Merkle siblings',
        desc: 'The sibling hashes along the path from your note\'s leaf to the Merkle root (one per tree level, here 32). Combined with your leaf they recompute the root, proving membership. Your client fetches them from the indexer; they\'re part of the proof witness, never revealing your note id to the server.'
    },
    registration_commitment: {
        title: 'Registration commitment',
        desc: 'A commitment to your note\'s secret, computed when you deposited (compute_registration_commitment(secret)). It\'s what binds your note on-chain. Shown here as part of what the client computes to build the proof.'
    },
    note_leaf: {
        title: 'Note leaf',
        desc: 'The Merkle-tree leaf value for your note: a hash of (note_id, registration_commitment, deposit_amount, expiry). The on-chain tree stores this; your membership proof shows this leaf sits under the active root.'
    },

    // ---- next state the server signed ------------------------------------
    next_anchor: {
        title: 'Next anchor (τ)',
        desc: 'A fresh, unpredictable "address" for your next wallet state, chosen by the server as Poseidon(server_randomness, nullifier, next_commitment, leaf_index). Your wallet uses it to derive the NEXT request\'s nullifier. Because it changes every request and can\'t be guessed in advance, consecutive requests can\'t be linked through their nullifiers/anchors — this rolling anchor is what makes your requests unlinkable to each other.'
    },
    next_commitment: {
        title: 'Next commitment',
        desc: 'The Pedersen commitment to your balance AFTER this charge: next = anon_commitment − charge·G + blind_delta·H. The server computes it homomorphically — subtracting the charge and adding fresh blinding — so your balance moves correctly while staying hidden. Your client re-derives the same point to verify the server didn\'t cheat.'
    },
    blind_delta_srv: {
        title: 'Blind delta (server)',
        desc: 'A server-chosen value (Δ) folded into the blinding of your next balance commitment. It re-randomizes the commitment so two commitments to the same balance look completely different, preventing anyone — including the server — from tracking your balance across requests by comparing commitments.'
    },
    next_state_sig_epoch: {
        title: 'Next state-sig epoch',
        desc: 'The epoch of the XMSS key the server used to sign your new state. Together with the leaf index it pins down exactly which one-time key signed this transition.'
    },
    next_state_sig_leaf_index: {
        title: 'Next state-sig leaf index',
        desc: 'The index of the one-time XMSS key (a leaf in the signing tree) used to sign your new state. XMSS keys are one-time, so each signature consumes the next leaf; the server tracks how many remain.'
    },
    next_state_sig_root: {
        title: 'Next state-sig root',
        desc: 'The published root of the XMSS signing tree for the epoch that signed your new state — what your client verifies the signature against.'
    },
    response_hash: {
        title: 'Response hash',
        desc: 'A hash of the upstream response bytes, bound into the server-signed state. Your client can recompute it to confirm it received exactly the response the server processed and billed for.'
    },

    // ---- wallet / note ----------------------------------------------------
    note_id: {
        title: 'Note id',
        desc: 'The index of your deposit\'s note in the on-chain tree, assigned when you deposited. One funded note backs many requests.'
    },
    is_genesis: {
        title: 'Genesis',
        desc: 'True for a freshly funded note that hasn\'t made its first request yet (it has no prior server signature, so the first request is accepted specially). After the first request it becomes part of the signed state chain.'
    },
    current_anchor: {
        title: 'Current anchor',
        desc: 'The anchor (τ) for your wallet\'s current state — 1 for a genesis note, otherwise the next_anchor the server returned on your previous request. It feeds into this request\'s nullifier.'
    },
    upstream_model: {
        title: 'Upstream model',
        desc: 'The exact model the upstream provider billed (e.g. gpt-4o-mini-2024-07-18). A model id with a vendor prefix (openai/…, anthropic/…) is routed to OpenRouter; a bare id goes to OpenAI.'
    },

    // ---- ephemeral key (Mode 2) ------------------------------------------
    ephemeral_key: {
        title: 'Ephemeral key',
        desc: 'A short-lived, credit-limited OpenRouter API key the server mints for you. Your browser uses it to call OpenRouter DIRECTLY, so the server never sees your prompts. It auto-expires (default 1 minute) and has a hard credit cap, so exposure is bounded; when it expires the accumulated usage is settled against your zkAPI balance in one shot.'
    },
    key_hash: {
        title: 'Key hash',
        desc: 'A stable identifier for the minted ephemeral key (not the secret itself). The server uses it to read the key\'s authoritative total usage from OpenRouter at settlement, and to revoke it. The secret key is never logged or shown on the dashboard.'
    },
    ephemeral_expiry: {
        title: 'Key expiry',
        desc: 'When the ephemeral key stops working. Follow-up prompts reuse the same key until then; once it expires the total usage is billed and a fresh key is minted on your next message.'
    }
};

/** Look up an entry; returns null if the field has no glossary text. */
export function describeField(key) {
    return GLOSSARY[key] || null;
}

export default GLOSSARY;
