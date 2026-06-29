// zkAPI integration — shared config + formatting helpers.
//
// The oa-chat client talks to a local `zkapi-clientd` daemon (the wallet +
// proof layer). This module centralises the daemon URL, the credit unit, the
// billing-mode selection, and the small display helpers (credit↔USD, hash
// shortening) used across the zkAPI backend and panel.

// 1 credit = 1 micro-US-dollar. Mirrors zkapi_serverd::pricing::CREDITS_PER_USD
// and zkapi_clientd::CREDITS_PER_USD. The daemon's /zkapi/v1/config also reports
// this; we treat that as authoritative when available.
export const DEFAULT_CREDITS_PER_USD = 1_000_000;

// Where the local client daemon lives. Override with ?clientd=... or
// localStorage 'zkapi-clientd-url'.
function resolveClientdBase() {
    try {
        const params = new URLSearchParams(window.location.search);
        const fromQuery = params.get('clientd');
        if (fromQuery) {
            localStorage.setItem('zkapi-clientd-url', fromQuery);
            return fromQuery.replace(/\/$/, '');
        }
        const stored = localStorage.getItem('zkapi-clientd-url');
        if (stored) return stored.replace(/\/$/, '');
    } catch (_) {
        // ignore storage/URL access issues
    }
    return 'http://127.0.0.1:43134';
}

export const CLIENTD_BASE = resolveClientdBase();

// Billing mode: 'passthrough' (Mode 1) or 'ephemeral' (Mode 2).
export const BILLING_MODES = {
    passthrough: {
        id: 'passthrough',
        label: 'Pass-through',
        short: 'Mode 1',
        blurb: 'Prompt flows through the zkAPI server to the provider. The server sees the prompt but cannot link it to you.'
    },
    ephemeral: {
        id: 'ephemeral',
        label: 'Ephemeral key',
        short: 'Mode 2',
        blurb: 'zkAPI mints a credit-limited key; your browser streams from OpenRouter directly. The server never sees the prompt.'
    }
};

const MODE_KEY = 'zkapi-billing-mode';

export function getBillingMode() {
    try {
        const stored = localStorage.getItem(MODE_KEY);
        if (stored && BILLING_MODES[stored]) return stored;
    } catch (_) {
        // ignore
    }
    return 'passthrough';
}

export function setBillingMode(mode) {
    if (!BILLING_MODES[mode]) return;
    try {
        localStorage.setItem(MODE_KEY, mode);
    } catch (_) {
        // ignore
    }
}

let creditsPerUsd = DEFAULT_CREDITS_PER_USD;
export function setCreditsPerUsd(value) {
    if (typeof value === 'number' && value > 0) creditsPerUsd = value;
}
export function getCreditsPerUsd() {
    return creditsPerUsd;
}

// --- formatting helpers ----------------------------------------------------

export function creditsToUsd(credits) {
    return (Number(credits) || 0) / creditsPerUsd;
}

/** Format a USD amount with enough precision for tiny inference costs. */
export function formatUsd(usd) {
    const n = Number(usd) || 0;
    if (n === 0) return '$0.00';
    if (n >= 0.01) return `$${n.toFixed(2)}`;
    if (n >= 0.000001) return `$${n.toFixed(6)}`;
    return `$${n.toExponential(2)}`;
}

/** Format an integer credit amount with thousands separators. */
export function formatCredits(credits) {
    return Number(credits || 0).toLocaleString('en-US');
}

/** Combined "1,234 cr ($0.001234)" label. */
export function formatCreditsUsd(credits) {
    return `${formatCredits(credits)} cr (${formatUsd(creditsToUsd(credits))})`;
}

/**
 * Shorten a long hash/hex/opaque string to `0x1234…cdef`. Returns the original
 * if it's already short. `head`/`tail` count hex chars after the 0x.
 */
export function shortenHash(value, head = 6, tail = 4) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    const hasPrefix = s.startsWith('0x') || s.startsWith('0X');
    const body = hasPrefix ? s.slice(2) : s;
    if (body.length <= head + tail + 1) return s;
    const prefix = hasPrefix ? '0x' : '';
    return `${prefix}${body.slice(0, head)}…${body.slice(-tail)}`;
}
