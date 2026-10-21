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
    if (!['metamask', 'address'].includes(next)) throw new Error('Choose Ethereum wallet or Send to address.');
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
            throw new Error('Check the saved funding transaction before using your Ethereum wallet.');
        }
        await waitForSelectedProvider();
        if (method === 'address') await addressFundingWallet.ensureAddress();
        return release;
    } catch (error) {
        release();
        throw error;
    }
}

// The wallet is named "Ethereum wallet" on screen, whichever extension it is.
// The SDK and its patches still say "MetaMask"; this rewrites that wording for
// display only. Case-sensitive, so ids, classes, method values ("metamask")
// and URLs are never touched; idempotent, so text that passes twice is safe.
function ethereumWalletText(value) {
    return String(value ?? '')
        .replace(/\bMetaMask was not detected\. Install or enable it\b/g, 'No Ethereum wallet was detected. Install or enable one')
        .replace(/\bI closed MetaMask\b/g, 'I closed the Ethereum wallet prompt')
        .replace(/\bChoose MetaMask or Send Ethereum\./g, 'Choose Ethereum wallet or Send to address.')
        .replace(/\bPaused before MetaMask\./g, 'Paused before the Ethereum wallet prompt.')
        .replace(/\bwhile MetaMask confirmations\b/g, 'while Ethereum wallet confirmations')
        .replace(/\bMetaMask wallet\b/g, 'Ethereum wallet')
        .replace(/\b([Ii]nstall) MetaMask\b/g, '$1 an Ethereum wallet')
        .replace(/\b([Ww]ith) MetaMask\b/g, '$1 Ethereum wallet')
        .replace(/\bA MetaMask\b/g, 'An Ethereum wallet')
        .replace(/\ba MetaMask\b/g, 'an Ethereum wallet')
        .replace(/\b(the|The|your|Your|its|Its|this|This|that|another|Another|any|Any)((?: (?:old|new|earlier|previous|selected|outstanding|hashless|same|other|connected))?) MetaMask\b/g,
            (match, determiner, adjective) => `${determiner}${adjective} Ethereum wallet`)
        .replace(/(^|[.!?…]\s+|>\s*|[“"(]\s*)MetaMask\b/g, '$1Your Ethereum wallet')
        .replace(/\bMetaMask\b/g, 'your Ethereum wallet');
}

// Adapt presentation only; the SDK journal and verification phases are shared.
// Every method reads "Ethereum wallet"; Send to address then reads its own
// words for the wallet steps it does not have.
export function walletMethodText(value) {
    const text = ethereumWalletText(value);
    if (method !== 'address') return text;
    return text
        .replaceAll('Connecting to your Ethereum wallet…', 'Preparing your funding address…')
        .replaceAll('Connect your Ethereum wallet', 'Prepare funding address')
        .replaceAll('Waiting for your Ethereum wallet…', 'Preparing transaction…')
        .replaceAll('Waiting for your Ethereum wallet', 'Preparing transaction')
        .replaceAll('Use your Ethereum wallet once', 'Fund your address once')
        .replaceAll('Install an Ethereum wallet to get started', 'Send ETH to your funding address')
        .replaceAll('Your Ethereum wallet may still be open in this or another tab.', 'Check your saved funding transaction before retrying.')
        .replaceAll('Continue with Ethereum wallet', 'Deposit')
        .replaceAll('Try again with Ethereum wallet', 'Retry deposit')
        .replaceAll('Resume with Ethereum wallet', 'Resume deposit')
        .replaceAll('Continue in your Ethereum wallet', 'Continue withdrawal')
        .replaceAll('Finalize in your Ethereum wallet', 'Finalize withdrawal')
        .replaceAll('Returned to your Ethereum wallet', 'Returned to your withdrawal address')
        .replaceAll('returned to your Ethereum wallet', 'sent to your withdrawal address')
        .replaceAll('Return the remaining balance to your Ethereum wallet', 'Send the remaining balance to your withdrawal address')
        .replaceAll('Your Ethereum wallet prompt was closed', 'Recover interrupted request')
        .replaceAll('Try again in your Ethereum wallet', 'Retry saved deposit')
        .replaceAll('Open your Ethereum wallet from your browser toolbar to check the request. If its window closed, use “Recover withdrawal” below.', 'Check the saved withdrawal below. If you started it in a wallet extension, check its pending request before recovering.')
        .replaceAll('the Ethereum wallet account', 'your funding account')
        .replaceAll('your Ethereum wallet account', 'your funding account')
        .replaceAll('Your Ethereum wallet account', 'Your funding account')
        .replaceAll('an Ethereum wallet', 'your funding account')
        .replaceAll('the Ethereum wallet', 'your funding account')
        .replaceAll('Your Ethereum wallet', 'Your funding account')
        .replaceAll('your Ethereum wallet', 'your funding account');
}
