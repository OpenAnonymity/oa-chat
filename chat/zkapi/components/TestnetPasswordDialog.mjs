/** The SDK owns validation and in-memory retention. This form never puts a
 * password into a URL, HTML string, account or log. When `remember` is a
 * boolean, browser storage is usable: the form shows the "Remember" choice
 * and passes it to `authenticate`, whose caller (testnetPasswordMemory)
 * saves or forgets the accepted value. */
export function requestTestnetPassword({ authenticate, signal, remember }, doc = document) {
    signal?.throwIfAborted();
    const offerRemember = typeof remember === 'boolean';
    const dialog = doc.createElement('dialog');
    dialog.className = 'zkapi-testnet-password-dialog';
    dialog.setAttribute('aria-labelledby', 'zkapi-testnet-password-title');
    dialog.innerHTML = `<form>
        <h2 id="zkapi-testnet-password-title">Sepolia access</h2>
        <p>Enter the shared password to use this testnet service.</p>
        <label for="zkapi-testnet-password">Password</label>
        <input id="zkapi-testnet-password" type="password" autocomplete="off" maxlength="1024" required aria-describedby="zkapi-testnet-password-note zkapi-testnet-password-error" />
        ${offerRemember ? `<label class="zkapi-testnet-password-remember"><input type="checkbox" data-remember ${remember ? 'checked' : ''} /> Remember in this browser</label>` : ''}
        <p id="zkapi-testnet-password-note">${offerRemember
            ? 'Saved on this device for Sepolia only, so a reload does not ask again. Uncheck to keep it only in this tab.'
            : 'Kept only in this tab until you reload or close it.'}</p>
        <p id="zkapi-testnet-password-error" role="alert"></p>
        <div class="zkapi-testnet-password-actions">
            <button type="button" data-cancel class="zkapi-secondary-button">Cancel</button>
            <button type="submit" class="zkapi-primary-button">Unlock Sepolia</button>
        </div>
    </form>`;
    const input = dialog.querySelector('#zkapi-testnet-password');
    const rememberBox = offerRemember ? dialog.querySelector('[data-remember]') : null;
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
                await authenticate(input.value, rememberBox
                    ? { signal: controller.signal, remember: rememberBox.checked === true }
                    : { signal: controller.signal });
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
