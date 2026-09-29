import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { addressFundingWallet } from './addressFundingProvider.mjs';

const PREFERENCE_KEY = 'oa-zkapi-wallet-method';
let method = 'metamask';
let initialization;
let selectionVersion = 0;
let walletAction = null;
const listeners = new Set();

export function getWalletMethod() { return method; }
export function walletMethodActionBusy() { return walletAction !== null; }
export function subscribeWalletMethod(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export function initWalletMethod() {
    if (!initialization) initialization = (async () => {
        const version = selectionVersion;
        let saved;
        try { saved = globalThis.localStorage?.getItem(PREFERENCE_KEY); } catch { /* Optional preference. */ }
        try { await addressFundingWallet.init(); }
        catch (error) {
            if (saved === 'address') throw error;
            return method;
        }
        if (addressFundingWallet.hasPendingTransaction || (version === selectionVersion && saved === 'address')) {
            method = 'address';
        }
        return method;
    })().catch(error => { initialization = null; throw error; });
    return initialization;
}

// Choosing a screen is independent of the signer. The SDK pins its provider
// during every async operation, including harmless price and fee reads.
// Wallet actions and scoped address quotes activate their provider separately.
export function setWalletMethod(next) {
    if (!['metamask', 'address'].includes(next)) throw new Error('Choose MetaMask or Send Ethereum.');
    if (next === method) return;
    if (walletAction) throw new Error('Finish the current transaction before changing payment methods.');
    if (addressFundingWallet.hasPendingTransaction) throw new Error('Check the saved funding transaction before changing methods.');
    selectionVersion++;
    method = next;
    try { globalThis.localStorage?.setItem(PREFERENCE_KEY, method); } catch { /* Optional preference. */ }
    for (const listener of listeners) listener(method);
}

function activateIfIdle() {
    try {
        zkapiClient.setWalletProvider(method === 'address' ? addressFundingWallet : null);
        return true;
    } catch (error) {
        if (error?.code !== 'wallet_provider_busy') throw error;
        return false;
    }
}

async function waitForSelectedProvider() {
    const selected = method;
    const deadline = Date.now() + 30_000;
    while (!activateIfIdle()) {
        if (Date.now() >= deadline) throw new Error('The previous wallet check is still running. Try this transaction again shortly.');
        await new Promise(resolve => setTimeout(resolve, 50));
        if (method !== selected) throw new Error('The payment method changed before the transaction started.');
    }
}

export async function initWalletClient() {
    await initWalletMethod();
    // Initial reconciliation may need the saved signer. A concurrent read is
    // allowed to finish with its original provider; it cannot change the UI.
    if (addressFundingWallet.hasPendingTransaction) await waitForSelectedProvider();
    else activateIfIdle();
    const result = await zkapiClient.init();
    try {
        await addressFundingWallet.reload();
        if (addressFundingWallet.hasPendingTransaction && method !== 'address' && !walletAction) {
            method = 'address';
            selectionVersion++;
            await waitForSelectedProvider();
            for (const listener of listeners) listener(method);
        }
    } catch (error) {
        if (method === 'address') throw error;
        // Optional local custody storage must not disable MetaMask.
    }
    return result;
}

// The returned release callback owns the explicit action until its caller's
// finally block. Background quotes never acquire this lease. A stale read can
// delay signing, but never delay selecting a different payment method.
export async function prepareWalletMethod() {
    if (walletAction) throw new Error('Another wallet transaction is still running.');
    const action = {};
    walletAction = action;
    const release = () => { if (walletAction === action) walletAction = null; };
    try {
        await initWalletMethod();
        try { await addressFundingWallet.reload(); }
        catch (error) { if (method === 'address') throw error; }
        if (addressFundingWallet.hasPendingTransaction && method !== 'address') {
            throw new Error('Check the saved funding transaction before using MetaMask.');
        }
        await waitForSelectedProvider();
        if (method === 'address') await addressFundingWallet.ensureAddress();
        return release;
    } catch (error) {
        release();
        throw error;
    }
}

// Adapt presentation only; the SDK journal and verification phases are shared.
export function walletMethodText(value) {
    const text = String(value ?? '');
    if (method !== 'address') return text;
    return text
        .replaceAll('Connecting to MetaMask…', 'Preparing your funding address…')
        .replaceAll('Connect MetaMask', 'Prepare funding address')
        .replaceAll('Waiting for MetaMask…', 'Preparing transaction…')
        .replaceAll('Waiting for MetaMask', 'Preparing transaction')
        .replaceAll('Use MetaMask once', 'Fund your address once')
        .replaceAll('Install MetaMask to get started', 'Send ETH to your funding address')
        .replaceAll('MetaMask may still be open in this or another tab.', 'Check your saved funding transaction before retrying.')
        .replaceAll('Continue with MetaMask', 'Deposit')
        .replaceAll('Try again with MetaMask', 'Retry deposit')
        .replaceAll('Resume with MetaMask', 'Resume deposit')
        .replaceAll('Continue in MetaMask', 'Continue withdrawal')
        .replaceAll('Finalize in MetaMask', 'Finalize withdrawal')
        .replaceAll('Returned to MetaMask', 'Returned to your withdrawal address')
        .replaceAll('returned to MetaMask', 'sent to your withdrawal address')
        .replaceAll('Return the remaining balance to MetaMask', 'Send the remaining balance to your withdrawal address')
        .replaceAll('MetaMask prompt was closed', 'Recover interrupted request')
        .replaceAll('Try again in MetaMask', 'Retry saved deposit')
        .replaceAll('Open MetaMask from your browser toolbar to check the request. If its window closed, use “Recover withdrawal” below.', 'Check the saved withdrawal below. If you started it in a wallet extension, check its pending request before recovering.')
        .replaceAll('MetaMask', 'your funding account');
}
