/** Remembers the shared Sepolia test-group password in this browser so a
 * reload does not ask for it again (docs/SEPOLIA_AUTH.md). The SDK still owns
 * validation and the in-memory credential; this module only offers it a saved
 * value through the host's password callback. The entry is bound to the
 * Sepolia protocol server it was accepted by: Mainnet, and any other service,
 * never read, write or send it. It is never synced, logged or put in chatDB.
 * Storage may be missing or throw; the dialog then works as before. */

export const TESTNET_PASSWORD_STORAGE_KEY = 'oa-zkapi-sepolia-access-v1';
const SEPOLIA_CHAIN_ID = 11155111;
const RESTORE_TIMEOUT_MS = 20_000;

function passwordRequired() {
    return Object.assign(new Error('Enter the Sepolia password to continue.'), {
        code: 'testnet_password_required', status: 401
    });
}

export function createTestnetPasswordMemory({ getFunding, storage = () => globalThis.localStorage, restoreTimeoutMs = RESTORE_TIMEOUT_MS } = {}) {
    // True once this page has a validated password from the saved entry or
    // the dialog. Later prompts (Change password, a server 401) then open the
    // dialog instead of silently offering the saved value again.
    let settled = false;
    let silent = false;
    let restoration = null;

    function service() {
        let funding;
        try { funding = getFunding?.(); } catch { return null; }
        if (Number(funding?.chain_id) !== SEPOLIA_CHAIN_ID) return null;
        const url = funding?.protocol_server_url;
        return typeof url === 'string' && url ? url.replace(/\/+$/, '') : null;
    }
    function store() {
        try { return storage() || null; } catch { return null; }
    }
    // This service's entry as `{raw, password}`; `raw` is the stored string,
    // the snapshot that forgetIf compares against.
    function entry() {
        const scope = service();
        const target = scope && store();
        if (!target) return null;
        try {
            const raw = target.getItem(TESTNET_PASSWORD_STORAGE_KEY);
            const value = JSON.parse(raw);
            return value?.service === scope && typeof value.password === 'string' && value.password
                ? { raw, password: value.password } : null;
        } catch { return null; }
    }
    function read() {
        return entry()?.password ?? null;
    }
    function write(password) {
        const scope = service();
        const target = scope && store();
        if (!target) return false;
        try {
            target.setItem(TESTNET_PASSWORD_STORAGE_KEY, JSON.stringify({ v: 1, service: scope, password }));
            return true;
        } catch { return false; }
    }
    // Removes the entry only while it is still exactly `snapshot`. Every tab
    // shares the key, so a late rejection or failed save here must not delete
    // a newer password another tab saved, or another service's entry.
    function forgetIf(snapshot) {
        if (!snapshot) return;
        try {
            const target = store();
            if (target?.getItem(TESTNET_PASSWORD_STORAGE_KEY) === snapshot.raw) target.removeItem(TESTNET_PASSWORD_STORAGE_KEY);
        } catch { /* Nothing to remove. */ }
    }
    // The explicit clear: this service's entry, whatever it holds.
    function forget() {
        forgetIf(entry());
    }
    // A write probe, because some private modes expose storage but refuse writes.
    function available() {
        const target = service() && store();
        if (!target) return false;
        try {
            target.setItem(`${TESTNET_PASSWORD_STORAGE_KEY}-probe`, '1');
            target.removeItem(`${TESTNET_PASSWORD_STORAGE_KEY}-probe`);
            return true;
        } catch { return false; }
    }

    /** Wraps the password dialog passed to configureBrowserSdk. */
    function wrap(requestDialog) {
        return async ({ authenticate, signal }) => {
            const saved = settled ? null : entry();
            if (saved) {
                try {
                    await authenticate(saved.password, { signal });
                    settled = true;
                    return;
                } catch (error) {
                    if (signal?.aborted || error?.name === 'AbortError') throw error;
                    // Rotated or revoked: never offer it again. A network
                    // failure keeps it for the next attempt.
                    if (error?.code === 'testnet_password_required') forgetIf(saved);
                    if (silent) throw error;
                }
            } else if (silent) {
                throw passwordRequired();
            }
            const offer = available();
            const before = offer ? entry() : null;
            return requestDialog({
                signal,
                remember: offer ? true : undefined,
                authenticate: async (password, { signal: attemptSignal, remember } = {}) => {
                    await authenticate(password, { signal: attemptSignal });
                    settled = true;
                    if (!offer) return;
                    if (remember === false) forget();
                    // A failed save drops the value this dialog replaced, not
                    // one saved since by another tab.
                    else if (!write(password) && before?.password !== password) forgetIf(before);
                }
            });
        };
    }

    /** Offers the saved password once after a reload, without ever opening the
     * dialog. Resolves true when the SDK accepted it. Never throws. */
    async function restore(client) {
        if (settled || read() === null) return false;
        silent = true;
        try {
            await client.ensureTestnetAccess({ interactive: true, signal: AbortSignal.timeout(restoreTimeoutMs) });
            return client.testnetAuthenticated === true;
        } catch {
            return false;
        } finally {
            silent = false;
        }
    }

    /** Wraps the wallet client start so the first successful start restores
     * the saved password before the runtime publishes its state. */
    function initializeWith(initialize, client) {
        return async () => {
            const result = await initialize();
            restoration ||= restore(client);
            await restoration;
            return result;
        };
    }

    return { wrap, restore, initializeWith, forget };
}
