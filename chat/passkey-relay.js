const NONCE_PATTERN = /^[a-f0-9]{32,64}$/i;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MAX_FRAGMENT_LENGTH = 128 * 1024;

function fromBase64(value) {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
        bytes[index] = decoded.charCodeAt(index);
    }
    return bytes.buffer;
}

function toBase64(value) {
    if (!value) return null;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export function parseRelayRequest(fragment) {
    const raw = String(fragment || '').replace(/^#/, '');
    if (!raw || raw.length > MAX_FRAGMENT_LENGTH) throw new Error('Invalid request');

    const params = new URLSearchParams(raw);
    const nonce = params.get('nonce') || '';
    const portText = params.get('port') || '';
    const type = params.get('type');
    const optionsText = params.get('options');

    if (!NONCE_PATTERN.test(nonce) || !/^\d{4,5}$/.test(portText)) {
        throw new Error('Invalid request');
    }
    const port = Number(portText);
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
        throw new Error('Invalid request');
    }
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

function initializeRelay() {
    const card = document.querySelector('.relay-card');
    const status = document.getElementById('relay-status');
    const spinner = document.getElementById('relay-spinner');
    const action = document.getElementById('relay-action');
    let request;

    try {
        request = parseRelayRequest(window.location.hash);
        window.history.replaceState(null, '', window.location.pathname);
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
        } catch (error) {
            running = false;
            card.dataset.state = 'error';
            spinner.hidden = true;
            const message = normalizeRelayError(error);
            status.textContent = message;
            if (reportFailure) {
                submitResult(request.port, { nonce: request.nonce, error: message });
                return;
            }
            action.textContent = request.type === 'create' ? 'Create passkey' : 'Try passkey again';
            action.hidden = false;
            action.focus();
        }
    };

    action.addEventListener('click', () => run({ reportFailure: true }));
    run();
}

if (typeof document !== 'undefined') initializeRelay();
