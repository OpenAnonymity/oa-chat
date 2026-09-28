import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { addressFundingWallet } from './addressFundingProvider.mjs';

const PREFERENCE_KEY = 'oa-zkapi-wallet-method';
let method = 'metamask';
let initialization;
const listeners = new Set();

export function getWalletMethod() { return method; }
export function subscribeWalletMethod(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export function initWalletMethod() {
    if (!initialization) initialization = (async () => {
        let saved;
        try { saved = globalThis.localStorage?.getItem(PREFERENCE_KEY); } catch { /* Optional preference. */ }
        try { await addressFundingWallet.init(); }
        catch (error) {
            if (saved === 'address') throw error;
            return method;
        }
        if (addressFundingWallet.hasPendingTransaction || saved === 'address') {
            zkapiClient.setWalletProvider(addressFundingWallet);
            method = 'address';
        }
        return method;
    })().catch(error => { initialization = null; throw error; });
    return initialization;
}

export async function setWalletMethod(next) {
    if (!['metamask', 'address'].includes(next)) throw new Error('Choose MetaMask or Send to an address.');
    await initWalletMethod();
    await addressFundingWallet.reload();
    if (next === method) return;
    if (addressFundingWallet.hasPendingTransaction) throw new Error('Check the saved funding transaction before changing methods.');
    zkapiClient.setWalletProvider(next === 'address' ? addressFundingWallet : null);
    method = next;
    try { globalThis.localStorage?.setItem(PREFERENCE_KEY, method); } catch { /* Optional preference. */ }
    for (const listener of listeners) listener(method);
}

export async function initWalletClient() {
    await initWalletMethod();
    const result = await zkapiClient.init();
    try {
        await addressFundingWallet.reload();
        if (addressFundingWallet.hasPendingTransaction && method !== 'address') {
            zkapiClient.setWalletProvider(addressFundingWallet);
            method = 'address';
            for (const listener of listeners) listener(method);
        }
    } catch (error) {
        if (method === 'address') throw error;
        // Optional local custody storage must not disable MetaMask.
    }
    return result;
}

export async function prepareWalletMethod() {
    await initWalletMethod();
    if (method === 'address') await addressFundingWallet.ensureAddress();
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
        .replaceAll('Continue with MetaMask', 'Next')
        .replaceAll('Try again with MetaMask', 'Retry deposit')
        .replaceAll('Resume with MetaMask', 'Resume deposit')
        .replaceAll('Continue in MetaMask', 'Continue withdrawal')
        .replaceAll('Finalize in MetaMask', 'Finalize withdrawal')
        .replaceAll('Returned to MetaMask', 'Returned to your withdrawal address')
        .replaceAll('returned to MetaMask', 'sent to your withdrawal address')
        .replaceAll('Return the remaining balance to MetaMask', 'Send the remaining balance to your withdrawal address')
        .replaceAll('MetaMask prompt was closed', 'Recover interrupted request')
        .replaceAll('Try again in MetaMask', 'Retry saved deposit')
        .replaceAll('MetaMask', 'your funding account');
}
