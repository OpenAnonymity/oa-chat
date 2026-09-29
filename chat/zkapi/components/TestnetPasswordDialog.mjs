/** The SDK owns validation and memory-only retention. This form never puts a
 * password into a URL, HTML string, storage record, account or log. */
export function requestTestnetPassword({ authenticate, signal }, doc = document) {
    signal?.throwIfAborted();
    const dialog = doc.createElement('dialog');
    dialog.className = 'zkapi-testnet-password-dialog';
    dialog.setAttribute('aria-labelledby', 'zkapi-testnet-password-title');
    dialog.innerHTML = `<form>
        <h2 id="zkapi-testnet-password-title">Sepolia access</h2>
        <p>Enter the shared password to use this testnet service.</p>
        <label for="zkapi-testnet-password">Password</label>
        <input id="zkapi-testnet-password" type="password" autocomplete="off" maxlength="1024" required aria-describedby="zkapi-testnet-password-note zkapi-testnet-password-error" />
        <p id="zkapi-testnet-password-note">Kept only in this tab until you reload or close it.</p>
        <p id="zkapi-testnet-password-error" role="alert"></p>
        <div class="zkapi-testnet-password-actions">
            <button type="button" data-cancel class="zkapi-secondary-button">Cancel</button>
            <button type="submit" class="zkapi-primary-button">Unlock Sepolia</button>
        </div>
    </form>`;
    const input = dialog.querySelector('input');
    const submit = dialog.querySelector('[type="submit"]');
    const message = dialog.querySelector('[role="alert"]');
    const previousFocus = doc.activeElement;
    const controller = new AbortController();
    let finished = false;
    let busy = false;
    return new Promise((resolve, reject) => {
        const finish = error => {
            if (finished) return;
            finished = true;
            input.value = '';
            controller.abort();
            signal?.removeEventListener('abort', aborted);
            dialog.close();
            dialog.remove();
            if (previousFocus?.isConnected !== false) previousFocus?.focus?.();
            if (error) reject(error); else resolve();
        };
        const canceled = () => finish(Object.assign(new Error('Sepolia access was canceled.'), {
            code: 'testnet_auth_canceled', isCancelled: true
        }));
        const aborted = () => finish(signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
        signal?.addEventListener('abort', aborted, { once: true });
        dialog.addEventListener('cancel', event => { event.preventDefault(); canceled(); });
        // Existing wallet dialogs listen on document; Escape belongs to the
        // topmost password dialog and must not dismiss the underlying workflow.
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
        dialog.querySelector('[data-cancel]').addEventListener('click', canceled);
        dialog.querySelector('form').addEventListener('submit', async event => {
            event.preventDefault();
            if (busy || finished) return;
            busy = true;
            submit.disabled = true;
            message.textContent = '';
            input.removeAttribute('aria-invalid');
            try {
                await authenticate(input.value, { signal: controller.signal });
                if (!finished) finish();
            } catch (error) {
                if (finished) return;
                input.value = '';
                input.setAttribute('aria-invalid', 'true');
                message.textContent = error?.code === 'testnet_password_required'
                    ? 'That password was not accepted. Try again.'
                    : 'Unable to check access. Try again shortly.';
                input.focus();
            } finally { busy = false; submit.disabled = false; }
        });
        doc.body.append(dialog);
        dialog.showModal();
        input.focus();
    });
}
