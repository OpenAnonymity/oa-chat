/* Local address funding: the daemon owns signing and durable transaction
 * recovery. Browser loads/checks only read status; a click authorizes progress. */
'use strict';
const $ = id => document.getElementById(id);
let capability = location.hash.slice(1);
try {
    if (capability) sessionStorage.setItem('oa-funding-capability', capability);
    else capability = sessionStorage.getItem('oa-funding-capability') || '';
} catch (_) { /* Restricted storage only prevents restoring this page session. */ }
if (location.hash) history.replaceState(null, '', '/funding');
let config;
let receiving;
let busy = false;
let authorized = false;
let hasNote = false;
let privateStateReady = false;
let stopped = false;
const status = message => { $('status').textContent = message; };
const delay = () => new Promise(resolve => setTimeout(resolve, 2000));
function controls() {
    $('fund').disabled = busy || !authorized || !receiving || !privateStateReady || hasNote
        || ['active', 'legacy_recovery', 'recovery_required'].includes(receiving.phase);
    $('resume').disabled = busy || !authorized;
    $('check').disabled = busy || !authorized;
    $('copy').disabled = !receiving?.address;
    $('amount').disabled = busy || !authorized || hasNote;
}
function revokeSession() {
    authorized = false;
    try { sessionStorage.removeItem('oa-funding-capability'); } catch (_) {}
    controls();
}
async function api(path, body) {
    const response = await fetch('/funding/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {'Authorization': 'Bearer ' + capability, 'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store'
    });
    if (response.status === 401 || response.status === 403) {
        revokeSession();
        const error = new Error('Funding session expired or is no longer authorized. Run oa-chat fund --browser again.');
        error.code = 'funding_session_expired';
        throw error;
    }
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch (_) { throw new Error('The local funding service is unavailable.'); }
    if (!response.ok) throw new Error(result?.error || 'Funding request failed.');
    if (!result || typeof result !== 'object') throw new Error('The local funding service returned an invalid response.');
    return result;
}
function amountUnits() {
    const value = $('amount').value.trim();
    if (!/^(0|[1-9]\d{0,6})(\.\d{1,6})?$/.test(value)) throw new Error('Enter a positive token amount with at most six decimal places.');
    const [whole, fraction = ''] = value.split('.');
    const units = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
    if (units <= 0n || units > 1000000000000n) throw new Error('Enter an amount between 0.000001 and 1,000,000 tokens.');
    return Number(units);
}
function formatUnits(value, decimals) {
    if (!/^\d+$/.test(String(value ?? ''))) return 'unavailable';
    const digits = String(value).padStart(decimals + 1, '0');
    return digits.slice(0, -decimals) + '.' + digits.slice(-decimals);
}
function showAddress(result) {
    if (!/^0x[0-9a-f]{40}$/i.test(result.address || '')
        || Number(result.chain_id) !== config.chain_id
        || result.token_address?.toLowerCase() !== config.token_address.toLowerCase()) {
        throw new Error('The receiving address does not match the configured network and billing token. No further transaction was requested.');
    }
    if (receiving && result.address.toLowerCase() !== receiving.address.toLowerCase()) {
        throw new Error('The receiving address changed. Reload the funding page and verify it before continuing.');
    }
    const previous = receiving;
    receiving = result;
    $('address').textContent = result.address;
    $('received').textContent = 'Received: ' + formatUnits(result.token_balance, 6) + (config.chain_id === 1 ? ' USDC' : ' test billing tokens') + ' · ' + formatUnits(result.eth_balance, 18) + (config.chain_id === 1 ? ' ETH' : ' Sepolia ETH') + '.';
    $('transaction').textContent = /^0x[0-9a-f]{64}$/i.test(result.transaction_hash || '') ? 'Latest transaction: ' + result.transaction_hash : '';
    if (result.amount) {
        $('amount').value = formatUnits(result.amount, 6);
        $('amount').readOnly = true;
        $('fund').textContent = result.phase === 'reverted' ? 'Retry saved deposit' : 'Continue saved deposit';
    } else if (result.phase === 'ready') {
        $('amount').readOnly = false;
        $('fund').textContent = 'Deposit into private balance';
        if (previous?.amount) $('amount').value = '0.10';
    }
    controls();
}
async function refreshBalance() {
    privateStateReady = false;
    const privateStatus = await api('status');
    hasNote = privateStatus.has_note === true;
    privateStateReady = true;
    $('balance').textContent = hasNote
        ? 'Private balance: ' + formatUnits(privateStatus.balance || 0, 6) + (config.chain_id === 1 ? ' USDC' : ' test billing tokens')
        : 'No active private balance yet.';
    controls();
}
async function checkFunds() {
    showAddress(await api('address'));
    await refreshBalance();
    status(hasNote ? 'Your private balance is ready. You can return to your chat client.'
        : receiving.phase === 'active' ? 'The saved deposit is active, but its private balance is unavailable. Preserve your funding and companion recovery files; do not send another deposit.'
        : receiving.message || 'Funds checked. Choose an amount and select Deposit into private balance when ready.');
}
async function fund() {
    if (busy || !authorized || !receiving || !privateStateReady || hasNote || stopped
        || ['active', 'legacy_recovery', 'recovery_required'].includes(receiving.phase)) return;
    busy = true;
    controls();
    try {
        // Freeze this exact amount for this authorized run. Reloading the page
        // never recreates the run or resumes POST requests automatically.
        const amount = amountUnits();
        for (let attempt = 0; attempt < 900 && !stopped; attempt++) {
            status(attempt ? 'Checking the saved funding progress…' : 'Preparing the private deposit…');
            const result = await api('address/deposit', {amount});
            showAddress(result);
            status(result.message || 'Waiting for Ethereum finality. This may take around 15 minutes; progress is saved on disk.');
            if (result.phase === 'active') {
                hasNote = true;
                await refreshBalance();
                status('Your private balance is funded. You can return to your chat client.');
                return;
            }
            if (!['approval_pending', 'deposit_pending', 'confirming'].includes(result.phase)) return;
            if (attempt === 899) {
                status('Funding is still pending. Progress is saved on disk. Check funds before continuing the same deposit.');
                return;
            }
            await delay();
        }
    } catch (error) {
        status((error.message || 'Funding could not be completed.') + (error.code === 'funding_session_expired' ? '' : ' Progress is saved locally. Check funds before continuing; an interrupted request may have submitted a transaction.'));
    } finally {
        busy = false;
        controls();
    }
}
async function confirm(hash) {
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Enter a valid deposit transaction hash.');
    try { sessionStorage.setItem('oa-funding-deposit-tx', hash); } catch (_) {}
    for (let attempt = 0; attempt < 90 && !stopped; attempt++) {
        try {
            await api('confirm', {transaction_hash: hash});
            await refreshBalance();
            status('Your private balance is funded. You can return to your chat client.');
            return;
        } catch (error) {
            if (error.code === 'funding_session_expired' || !/not confirmed yet|cannot read deposit receipt/.test(error.message) || attempt === 89) throw error;
            status('Deposit submitted. Waiting for confirmation…\n' + hash);
            await delay();
        }
    }
}
async function readAction(action) {
    if (busy || !authorized || stopped) return;
    busy = true;
    controls();
    try { await action(); } catch (error) { status(error.message || 'The request failed.'); }
    finally { busy = false; controls(); }
}
$('fund').addEventListener('click', fund);
$('check').addEventListener('click', () => readAction(checkFunds));
$('resume').addEventListener('click', () => readAction(() => confirm($('tx').value.trim())));
$('copy').addEventListener('click', async () => {
    if (!receiving?.address) return;
    try {
        await navigator.clipboard.writeText(receiving.address);
        $('copy').textContent = 'Address copied';
    } catch (_) {
        status('Could not copy automatically. Select and copy the receiving address above.');
    }
});
window.addEventListener('pagehide', () => { stopped = true; });
(async () => {
    try {
        if (!capability) throw new Error('Start a secure funding session with oa-chat fund --browser.');
        config = await api('config');
        if (![1, 11155111].includes(config.chain_id) || !/^0x[0-9a-f]{40}$/i.test(config.token_address || '')) throw new Error('The funding network is not supported.');
        $('network').textContent = config.chain_id === 1 ? 'Ethereum Mainnet · real USDC' : 'Sepolia · test billing token';
        $('vault').textContent = config.contract_address;
        $('token').textContent = config.token_address;
        $('amount-label').textContent = config.chain_id === 1 ? 'Amount in USDC' : 'Amount in test billing tokens';
        $('requirements').textContent = config.chain_id === 1
            ? 'Send USDC (the billing token contract below) and ETH to this address on Ethereum Mainnet. ETH pays the approval and deposit network fees. Transfers on other networks will not fund this balance.'
            : 'Send the configured test billing token and Sepolia ETH to this address on Sepolia. ETH pays network fees. Other test USDC contracts will not work. Do not send real funds. This address funding flow does not mint test tokens.';
        try { $('tx').value = sessionStorage.getItem('oa-funding-deposit-tx') || ''; } catch (_) {}
        authorized = true;
        await checkFunds();
        controls();
    } catch (error) {
        status(error.message || 'The local funding service is unavailable.');
        controls();
    }
})();
