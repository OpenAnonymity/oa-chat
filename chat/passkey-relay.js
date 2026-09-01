const NONCE_PATTERN = /^[a-f0-9]{32,64}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MAX_FRAGMENT_LENGTH = 128 * 1024;
const SINGLE_BROWSER_STORAGE_KEY = 'oa.desktop.single-browser-auth.v1';
const SINGLE_BROWSER_MAX_AGE_MS = 15 * 60 * 1000;
const PRF_INPUT = new TextEncoder().encode(
    'openanonymity.ai/account-master-key/v1'
);

function fromBase64(value) {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
        bytes[index] = decoded.charCodeAt(index);
    }
    return bytes.buffer;
}

function fromBase64Url(value) {
    let base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    if (base64.length % 4) base64 += '='.repeat(4 - (base64.length % 4));
    return fromBase64(base64);
}

function toBase64(value) {
    if (!value) return null;
    const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
}

function parseLoopback(params) {
    const nonce = params.get('nonce') || '';
    const portText = params.get('port') || '';
    if (!NONCE_PATTERN.test(nonce) || !/^\d{4,5}$/.test(portText)) {
        throw new Error('Invalid request');
    }
    const port = Number(portText);
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
        throw new Error('Invalid request');
    }
    return { nonce, port };
}

function parseFragment(fragment) {
    const raw = String(fragment || '').replace(/^#/, '');
    if (!raw || raw.length > MAX_FRAGMENT_LENGTH) throw new Error('Invalid request');
    return new URLSearchParams(raw);
}

export function parseRelayRequest(fragment) {
    const params = parseFragment(fragment);
    const { nonce, port } = parseLoopback(params);
    const type = params.get('type');
    const optionsText = params.get('options');

    if (type !== 'create' && type !== 'get') throw new Error('Invalid request');

    let options;
    try {
        options = JSON.parse(optionsText);
    } catch {
        throw new Error('Invalid options');
    }
    if (!options || typeof options !== 'object' || !options.publicKey) {
        throw new Error('Invalid options');
    }

    return { nonce, port, type, options };
}

export function parseSingleBrowserStart(fragment, pageOrigin) {
    const params = parseFragment(fragment);
    if (params.get('mode') !== 'start') throw new Error('Invalid request');
    const { nonce, port } = parseLoopback(params);
    let authorizationUrl;
    try {
        authorizationUrl = new URL(params.get('authorizationUrl') || '');
    } catch {
        throw new Error('Invalid request');
    }
    if (
        authorizationUrl.origin !== pageOrigin
        || authorizationUrl.pathname !== '/auth/desktop/authorize'
        || authorizationUrl.username
        || authorizationUrl.password
        || authorizationUrl.hash
    ) {
        throw new Error('Invalid request');
    }
    return { mode: 'start', nonce, port, authorizationUrl: authorizationUrl.href };
}

export function parseSingleBrowserCompletion(fragment) {
    const params = parseFragment(fragment);
    if (params.get('mode') !== 'complete') throw new Error('Invalid request');
    const state = params.get('state') || '';
    const code = params.get('code') || '';
    const context = params.get('context') || '';
    const error = params.get('error') || '';
    const fallback = params.get('fallback') === '1';
    if (!TOKEN_PATTERN.test(state)) throw new Error('Invalid request');
    if (error) {
        if (!/^[a-z0-9_]{1,64}$/i.test(error)) throw new Error('Invalid request');
        return { mode: 'complete', state, error };
    }
    if (!TOKEN_PATTERN.test(code)) throw new Error('Invalid request');
    if (!fallback && !TOKEN_PATTERN.test(context)) throw new Error('Invalid request');
    return { mode: 'complete', state, code, context, fallback };
}

export function deserializeCredentialOptions(options) {
    const publicKey = { ...options.publicKey };
    if (typeof publicKey.challenge === 'string') publicKey.challenge = fromBase64(publicKey.challenge);
    if (typeof publicKey.user?.id === 'string') {
        publicKey.user = { ...publicKey.user, id: fromBase64(publicKey.user.id) };
    }
    if (Array.isArray(publicKey.excludeCredentials)) {
        publicKey.excludeCredentials = publicKey.excludeCredentials.map((credential) => ({
            ...credential,
            id: typeof credential.id === 'string' ? fromBase64(credential.id) : credential.id
        }));
    }
    if (Array.isArray(publicKey.allowCredentials)) {
        publicKey.allowCredentials = publicKey.allowCredentials.map((credential) => ({
            ...credential,
            id: typeof credential.id === 'string' ? fromBase64(credential.id) : credential.id
        }));
    }
    const firstPrfInput = publicKey.extensions?.prf?.eval?.first;
    if (typeof firstPrfInput === 'string') {
        publicKey.extensions = {
            ...publicKey.extensions,
            prf: {
                ...publicKey.extensions.prf,
                eval: {
                    ...publicKey.extensions.prf.eval,
                    first: fromBase64(firstPrfInput)
                }
            }
        };
    }
    return { publicKey };
}

export function serializeCredential(credential, type) {
    const result = {
        id: credential.id,
        rawId: toBase64(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment || null,
        response: type === 'create'
            ? {
                clientDataJSON: toBase64(credential.response.clientDataJSON),
                attestationObject: toBase64(credential.response.attestationObject)
            }
            : {
                clientDataJSON: toBase64(credential.response.clientDataJSON),
                authenticatorData: toBase64(credential.response.authenticatorData),
                signature: toBase64(credential.response.signature),
                userHandle: credential.response.userHandle
                    ? toBase64(credential.response.userHandle)
                    : null
            }
    };
    const extensions = credential.getClientExtensionResults?.();
    if (extensions?.prf?.results?.first) {
        result.clientExtensionResults = {
            prf: { results: { first: toBase64(extensions.prf.results.first) } }
        };
    }
    return result;
}

function getPrfBytes(credential) {
    const first = credential?.getClientExtensionResults?.()?.prf?.results?.first;
    return first ? new Uint8Array(first) : null;
}

function prfWasEnabled(credential) {
    const results = credential?.getClientExtensionResults?.();
    return results?.prf?.enabled === true || !!results?.prf?.results?.first;
}

async function evaluatePrf(credentialIds) {
    const credential = await navigator.credentials.get({
        publicKey: {
            challenge: randomBytes(32),
            allowCredentials: credentialIds.map((id) => ({
                id: fromBase64Url(id),
                type: 'public-key'
            })),
            userVerification: 'required',
            timeout: 60000,
            extensions: { prf: { eval: { first: PRF_INPUT } } }
        }
    });
    const prfBytes = getPrfBytes(credential);
    if (!credential || !prfBytes) throw new Error('Passkey request failed');
    return { credential, prfBytes };
}

export function validateSingleBrowserContext(value) {
    const operation = value?.operation;
    const credentialIds = value?.credentialIds;
    if (
        (operation !== 'create' && operation !== 'get')
        || !Array.isArray(credentialIds)
        || credentialIds.length > 32
        || credentialIds.some((id) => typeof id !== 'string' || !id || id.length > 2048)
    ) {
        throw new Error('Invalid passkey context');
    }
    const email = typeof value.email === 'string' ? value.email.trim() : '';
    if (operation === 'create' && !email) throw new Error('Invalid passkey context');
    if (operation === 'get' && credentialIds.length === 0) {
        throw new Error('Invalid passkey context');
    }
    return { operation, email: operation === 'create' ? email : null, credentialIds };
}

export async function performSingleBrowserPasskey(rawContext) {
    const context = validateSingleBrowserContext(rawContext);
    let credential;
    let prfBytes;
    if (context.operation === 'create') {
        credential = await navigator.credentials.create({
            publicKey: {
                challenge: randomBytes(32),
                rp: { name: 'Open Anonymity' },
                user: {
                    id: randomBytes(32),
                    name: context.email,
                    displayName: context.email
                },
                pubKeyCredParams: [
                    { type: 'public-key', alg: -7 },
                    { type: 'public-key', alg: -257 }
                ],
                authenticatorSelection: {
                    residentKey: 'required',
                    requireResidentKey: true,
                    userVerification: 'required'
                },
                excludeCredentials: context.credentialIds.map((id) => ({
                    id: fromBase64Url(id),
                    type: 'public-key'
                })),
                attestation: 'none',
                timeout: 60000,
                extensions: { prf: { eval: { first: PRF_INPUT } } }
            }
        });
        if (!credential || !prfWasEnabled(credential)) {
            throw new Error('Passkey request failed');
        }
        prfBytes = getPrfBytes(credential);
        if (!prfBytes) {
            const evaluated = await evaluatePrf([credential.id]);
            if (evaluated.credential.id !== credential.id) {
                evaluated.prfBytes.fill(0);
                throw new Error('Passkey request failed');
            }
            prfBytes = evaluated.prfBytes;
        }
    } else {
        ({ credential, prfBytes } = await evaluatePrf(context.credentialIds));
        if (!context.credentialIds.includes(credential.id)) {
            prfBytes.fill(0);
            throw new Error('Passkey request failed');
        }
    }

    try {
        return {
            operation: context.operation,
            credentialId: credential.id,
            prf: toBase64(prfBytes)
        };
    } finally {
        prfBytes.fill(0);
    }
}

export function normalizeRelayError(error) {
    if (error?.name === 'NotAllowedError') return 'Passkey request canceled';
    if (error?.name === 'InvalidStateError') return 'Passkey already registered';
    return 'Passkey request failed';
}

function submitResult(port, payload) {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `http://127.0.0.1:${port}/callback`;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'data';
    input.value = JSON.stringify(payload);
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
}

function readSingleBrowserHandoff() {
    let value;
    try {
        value = JSON.parse(sessionStorage.getItem(SINGLE_BROWSER_STORAGE_KEY));
    } catch {
        value = null;
    }
    sessionStorage.removeItem(SINGLE_BROWSER_STORAGE_KEY);
    if (
        !value
        || !NONCE_PATTERN.test(value.nonce || '')
        || !Number.isInteger(value.port)
        || value.port < MIN_PORT
        || value.port > MAX_PORT
        || !Number.isFinite(value.createdAt)
        || Date.now() - value.createdAt < 0
        || Date.now() - value.createdAt > SINGLE_BROWSER_MAX_AGE_MS
    ) {
        throw new Error('Invalid request');
    }
    return value;
}

async function runLegacyRelay(request, ui, { reportFailure = false } = {}) {
    const { card, status, spinner, action } = ui;
    action.hidden = true;
    spinner.hidden = false;
    status.textContent = request.type === 'create'
        ? 'Creating your encryption passkey...'
        : 'Waiting for Touch ID or your passkey manager...';
    try {
        const credentialOptions = deserializeCredentialOptions(request.options);
        const credential = request.type === 'create'
            ? await navigator.credentials.create(credentialOptions)
            : await navigator.credentials.get(credentialOptions);
        if (!credential) throw new Error('Missing credential');
        card.dataset.state = 'success';
        spinner.hidden = true;
        status.textContent = 'Passkey complete. Returning to OA Desktop...';
        submitResult(request.port, {
            nonce: request.nonce,
            result: serializeCredential(credential, request.type)
        });
        return true;
    } catch (error) {
        card.dataset.state = 'error';
        spinner.hidden = true;
        const message = normalizeRelayError(error);
        status.textContent = message;
        if (reportFailure) {
            submitResult(request.port, { nonce: request.nonce, error: message });
            return true;
        }
        action.textContent = request.type === 'create' ? 'Create passkey' : 'Try passkey again';
        action.hidden = false;
        action.focus();
        return false;
    }
}

async function runSingleBrowserCompletion(request, ui) {
    const { card, status, spinner } = ui;
    const handoff = readSingleBrowserHandoff();
    if (request.error) {
        submitResult(handoff.port, {
            nonce: handoff.nonce,
            oauth: { state: request.state, error: request.error }
        });
        return;
    }

    try {
        status.textContent = request.fallback
            ? 'Returning to OA Desktop...'
            : 'Waiting for Touch ID or your passkey manager...';
        spinner.hidden = false;
        let passkey = null;
        if (!request.fallback) {
            const response = await fetch('/auth/desktop/relay/context', {
                method: 'POST',
                credentials: 'omit',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    token: request.context,
                    code: request.code,
                    state: request.state
                })
            });
            if (!response.ok) throw new Error('Invalid passkey context');
            passkey = await performSingleBrowserPasskey(await response.json());
        }

        card.dataset.state = 'success';
        spinner.hidden = true;
        status.textContent = 'Sign in complete. Returning to OA Desktop...';
        submitResult(handoff.port, {
            nonce: handoff.nonce,
            oauth: { state: request.state, code: request.code },
            fallback: request.fallback,
            passkey
        });
    } catch (error) {
        card.dataset.state = 'error';
        spinner.hidden = true;
        const message = normalizeRelayError(error);
        status.textContent = 'Returning to OA Desktop to finish unlocking...';
        submitResult(handoff.port, {
            nonce: handoff.nonce,
            oauth: { state: request.state, code: request.code },
            fallback: true,
            passkeyError: message
        });
    }
}

function initializeRelay() {
    const card = document.querySelector('.relay-card');
    const status = document.getElementById('relay-status');
    const spinner = document.getElementById('relay-spinner');
    const action = document.getElementById('relay-action');
    const ui = { card, status, spinner, action };
    const rawFragment = window.location.hash;
    const mode = new URLSearchParams(rawFragment.replace(/^#/, '')).get('mode');
    window.history.replaceState(null, '', window.location.pathname);

    if (mode === 'start') {
        try {
            const request = parseSingleBrowserStart(rawFragment, window.location.origin);
            sessionStorage.setItem(SINGLE_BROWSER_STORAGE_KEY, JSON.stringify({
                nonce: request.nonce,
                port: request.port,
                createdAt: Date.now()
            }));
            status.textContent = 'Opening Google sign in...';
            window.location.replace(request.authorizationUrl);
        } catch {
            card.dataset.state = 'error';
            spinner.hidden = true;
            status.textContent = 'This sign-in request is invalid or has expired.';
        }
        return;
    }

    if (mode === 'complete') {
        let request;
        try {
            request = parseSingleBrowserCompletion(rawFragment);
        } catch {
            card.dataset.state = 'error';
            spinner.hidden = true;
            status.textContent = 'This sign-in request is invalid or has expired.';
            return;
        }
        runSingleBrowserCompletion(request, ui).catch(() => {
            card.dataset.state = 'error';
            spinner.hidden = true;
            status.textContent = 'This sign-in request is invalid or has expired.';
        });
        return;
    }

    let request;
    try {
        request = parseRelayRequest(rawFragment);
    } catch {
        card.dataset.state = 'error';
        spinner.hidden = true;
        status.textContent = 'This passkey request is invalid or has expired.';
        return;
    }

    let running = false;
    const run = async ({ reportFailure = false } = {}) => {
        if (running) return;
        running = true;
        const settled = await runLegacyRelay(request, ui, { reportFailure });
        running = settled;
    };
    action.addEventListener('click', () => run({ reportFailure: true }));
    run();
}

if (typeof document !== 'undefined') initializeRelay();
