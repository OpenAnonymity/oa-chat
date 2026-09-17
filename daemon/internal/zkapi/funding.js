/* Same prepare -> ERC20 approve -> vault deposit -> confirm protocol used by
 * OA Chat's MetaMask flow. EIP-1193 calls replace a CDN-loaded wallet library. */
'use strict';
const $ = id => document.getElementById(id);
let capability = location.hash.slice(1);
if (capability) {
    sessionStorage.setItem('oa-funding-capability', capability);
    history.replaceState(null, '', '/funding');
} else {
    capability = sessionStorage.getItem('oa-funding-capability') || '';
}
let config;
let busy = false;
const status = message => { $('status').textContent = message; };
const word = value => {
    const number = BigInt(value);
    if (number < 0n || number >= 1n << 256n) throw new Error('Invalid contract value.');
    return number.toString(16).padStart(64, '0');
};
async function api(path, body) {
    const response = await fetch('/funding/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {'Authorization': 'Bearer ' + capability, 'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store'
    });
    if (response.status === 401) {
        const error = new Error('Funding session expired. Run oa-chat fund again.');
        error.code = 'funding_session_expired';
        throw error;
    }
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch (_) { throw new Error(response.status === 401 ? 'Funding session expired. Run oa-chat fund again.' : 'The local funding service is unavailable.'); }
    if (!response.ok) throw new Error(result.error || 'Funding request failed.');
    return result;
}
function amountUnits() {
    const value = $('amount').value.trim();
    if (!/^(0|[1-9]\d{0,6})(\.\d{1,6})?$/.test(value)) throw new Error('Enter a positive USDC amount with at most six decimal places.');
    const [whole, fraction = ''] = value.split('.');
    const units = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
    if (units <= 0n || units > 1000000000000n) throw new Error('Enter an amount between 0.000001 and 1,000,000 USDC.');
    return Number(units);
}
async function wallet(method, params = []) {
    if (!window.ethereum) throw new Error('Open this page in a browser with MetaMask installed.');
    return window.ethereum.request({method, params});
}
async function onConfiguredChain() {
    const current = BigInt(await wallet('eth_chainId'));
    if (current !== BigInt(config.chain_id)) throw new Error('The wallet network changed. Switch back to the displayed network and retry.');
}
async function onConfiguredWallet(account) {
    await onConfiguredChain();
    const accounts = await wallet('eth_accounts');
    if (accounts[0]?.toLowerCase() !== account.toLowerCase()) {
        throw new Error('The selected wallet account changed. Retry funding.');
    }
    await onConfiguredChain();
}
const tokenAmount = units => (units / 1000000n).toString() + '.' + (units % 1000000n).toString().padStart(6, '0');
async function readTokenBalance(account, block = 'latest') {
    await onConfiguredWallet(account);
    const value = await wallet('eth_call', [{to: config.token_address, data: '0x70a08231' + word(account)}, block]);
    await onConfiguredWallet(account);
    if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
        throw new Error('The wallet returned an invalid token balance. No transaction was submitted.');
    }
    return BigInt(value);
}
async function readConfirmedMintBalance(account, receipt, minimum) {
    if (receipt.status !== '0x1' || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber || '') || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash || '')) {
        throw new Error('The test-token mint did not return a valid confirmed block. Check its status in MetaMask before retrying.');
    }
    const canonicalBlock = async () => {
        const block = await wallet('eth_getBlockByNumber', [receipt.blockNumber, false]);
        if (!block) throw new Error('The confirmed mint block is not available yet.');
        if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
            const error = new Error('The test-token mint block changed. Check its status in MetaMask before retrying.');
            error.code = 'mint_receipt_reorg';
            throw error;
        }
    };
    // Match the SDK's receipt-bound read: MetaMask's cached latest state can
    // lag a successful mint. Retry only reads of its canonical mined block.
    for (let attempt = 0; attempt < 20; attempt++) {
        await onConfiguredWallet(account);
        try {
            await canonicalBlock();
            const balance = await readTokenBalance(account, receipt.blockNumber);
            await canonicalBlock();
            await onConfiguredWallet(account);
            if (balance >= minimum) return balance;
        } catch (error) {
            await onConfiguredWallet(account);
            if (error.code === 'mint_receipt_reorg') throw error;
        }
        if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('The test-token mint was confirmed, but the balance is not available from the wallet RPC yet. No further transaction was submitted. Check your wallet balance before retrying.');
}
async function sendContractTransaction(account, to, data, prompt, phase) {
    const transaction = {from: account, chainId: '0x' + BigInt(config.chain_id).toString(16), to, data};
    await onConfiguredChain();
    let estimate;
    try {
        estimate = await wallet('eth_estimateGas', [transaction]);
    } catch (error) {
        const revertData = [error.data, error.data?.originalError?.data, error.data?.data].find(value => typeof value === 'string' && /^0x[0-9a-f]{8,}$/i.test(value));
        throw new Error(phase + ' simulation failed. This transaction was not submitted. ' + (error.message || 'The wallet could not estimate gas.') + (revertData ? ' Contract error: ' + revertData.slice(0, 10) + '.' : ''));
    }
    if (typeof estimate !== 'string' || !/^0x[0-9a-f]+$/i.test(estimate) || BigInt(estimate) <= 0n) {
        throw new Error('The wallet returned an invalid gas estimate. Nothing was submitted.');
    }
    // Match OA's browser SDK (services/zkapiGas.mjs): estimate the exact call
    // and apply 20% + 50,000 gas, below EIP-7825's per-transaction cap. This
    // avoids delegating the gas limit to MetaMask's possible 21M fallback.
    // MetaMask still selects all fee fields; gas units are not the ETH fee.
    const estimatedGas = BigInt(estimate);
    const gasLimit = estimatedGas * 12n / 10n + 50000n;
    if (gasLimit > 1n << 24n) {
        throw new Error('The simulated transaction exceeds Ethereum’s per-transaction gas limit. Nothing was submitted.');
    }
    transaction.gas = '0x' + gasLimit.toString(16);
    await onConfiguredWallet(account);
    status(prompt + '\nEstimated gas: ' + estimatedGas.toLocaleString('en-US') + ' units; gas limit: ' + gasLimit.toLocaleString('en-US') + ' units. MetaMask shows the ETH fee.');
    return wallet('eth_sendTransaction', [transaction]);
}
async function waitReceipt(hash) {
    for (let i = 0; i < 180; i++) {
        await onConfiguredChain();
        const receipt = await wallet('eth_getTransactionReceipt', [hash]);
        if (receipt) {
            if (receipt.status !== '0x1') throw new Error('The wallet transaction reverted. No private balance was activated.');
            return receipt;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('Transaction is still pending. Resume it with the transaction hash below.');
}
async function confirm(hash) {
    $('tx').value = hash;
    sessionStorage.setItem('oa-funding-deposit-tx', hash);
    // Save the transaction beside the recovery note immediately, even if the
    // receipt is still pending; the Go service checks the actual chain receipt.
    for (let i = 0; i < 90; i++) {
        try {
            await api('confirm', {transaction_hash: hash});
            status('Your private balance is funded. You can return to your chat client.');
            await refreshBalance();
            return;
        } catch (error) {
            if (!/not confirmed yet|cannot read deposit receipt/.test(error.message) || i === 89) throw error;
            status('Deposit submitted. Waiting for confirmation…\n' + hash);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}
async function refreshBalance() {
    const walletStatus = await api('status');
    $('balance').textContent = walletStatus.has_note ? 'Private balance: ' + (Number(walletStatus.balance || 0) / 1000000).toFixed(6) + ' USDC' : 'No active private note yet.';
}
async function fund() {
    if (busy) return;
    busy = true; $('fund').disabled = true; $('resume').disabled = true;
    let allowanceReady = false;
    let depositSubmitted = false;
    try {
        const amount = amountUnits();
        const plan = await api('prepare', {amount});
        if (plan.active) { status('This private note is already funded. Return to your chat client.'); return; }
        if (plan.transaction_hash) { await confirm(plan.transaction_hash); return; }
        status('Connect MetaMask and select your funding account.');
        const accounts = await wallet('eth_requestAccounts');
        if (!accounts.length) throw new Error('MetaMask did not provide an account.');
        const account = accounts[0];
        $('wallet-status').textContent = 'Funding account: ' + account;
        const targetChain = '0x' + BigInt(config.chain_id).toString(16);
        if (BigInt(await wallet('eth_chainId')) !== BigInt(config.chain_id)) {
            await wallet('wallet_switchEthereumChain', [{chainId: targetChain}]);
        }
        await onConfiguredChain();
        const decimals = await wallet('eth_call', [{to: config.token_address, data: '0x313ce567'}, 'latest']);
        if (BigInt(decimals) !== 6n) throw new Error('This deployment token does not use the expected six decimals.');
        await onConfiguredWallet(account);
        status('Checking the existing token approval…');
        const allowance = await wallet('eth_call', [{to: config.token_address, data: '0xdd62ed3e' + word(account) + word(config.contract_address)}, 'latest']);
        await onConfiguredWallet(account);
        if (typeof allowance !== 'string' || !/^0x[0-9a-f]{64}$/i.test(allowance)) {
            throw new Error('The wallet returned an invalid token allowance. No transaction was submitted.');
        }
        let tokenBalance = await readTokenBalance(account);
        const showWalletBalance = () => { $('wallet-status').textContent = 'Funding account: ' + account + '\nWallet balance: ' + tokenAmount(tokenBalance) + ' USDC. Vault allowance: ' + tokenAmount(BigInt(allowance)) + ' USDC.'; };
        showWalletBalance();
        if (tokenBalance < BigInt(amount)) {
            if (config.demo_mint_enabled !== true || config.chain_id !== 11155111) {
                throw new Error('The selected account needs at least ' + tokenAmount(BigInt(amount)) + ' USDC in the displayed billing token. No transaction was submitted.');
            }
            await onConfiguredWallet(account);
            const shortfall = BigInt(amount) - tokenBalance;
            status('Simulating the Sepolia test-token mint…');
            const mint = await sendContractTransaction(account, config.token_address, '0x40c10f19' + word(account) + word(shortfall), 'Mint exactly ' + tokenAmount(shortfall) + ' test USDC in MetaMask.', 'Test-token mint');
            const mintReceipt = await waitReceipt(mint);
            status('Test tokens minted. Checking the confirmed balance…');
            tokenBalance = await readConfirmedMintBalance(account, mintReceipt, BigInt(amount));
            showWalletBalance();
        }
        if (BigInt(allowance) < BigInt(amount)) {
            const approvalPrompt = 'Approve exactly ' + (amount / 1000000).toFixed(6) + ' USDC in MetaMask.';
            status('Simulating the exact USDC approval…');
            const approval = await sendContractTransaction(account, config.token_address, '0x095ea7b3' + word(config.contract_address) + word(amount), approvalPrompt, 'Token approval');
            await waitReceipt(approval);
        }
        allowanceReady = true;
        await onConfiguredWallet(account);
        status('Approve the vault deposit in MetaMask.');
        const refreshedPath = await api('path');
        await onConfiguredChain();
        const data = '0xc588341c' + word(plan.commitment) + word(amount) + refreshedPath.zero_path.map(word).join('');
        status('Simulating the vault deposit…');
        const transaction = await sendContractTransaction(account, config.contract_address, data, 'Approve the vault deposit in MetaMask.', 'Vault deposit');
        depositSubmitted = true;
        await confirm(transaction);
    } catch (error) {
        status(error.code === 'funding_session_expired' && allowanceReady && !depositSubmitted
            ? 'The token allowance is ready, but the funding session expired before the deposit was submitted. Run oa-chat fund again; the existing approval will be reused.'
            : error.message || 'Funding failed.');
    }
    finally { busy = false; $('fund').disabled = false; $('resume').disabled = false; }
}
$('fund').addEventListener('click', fund);
$('resume').addEventListener('click', async () => {
    if (busy) return;
    busy = true; $('fund').disabled = true; $('resume').disabled = true;
    try { await confirm($('tx').value.trim()); } catch (error) { status(error.message); }
    finally { busy = false; $('fund').disabled = false; $('resume').disabled = false; }
});
(async () => {
    try {
        if (!capability) throw new Error('Start a secure funding session with oa-chat fund.');
        config = await api('config');
        $('network').textContent = config.chain_id === 1 ? 'Ethereum mainnet · real USDC' : 'Sepolia · test USDC';
        $('vault').textContent = config.contract_address;
        $('token').textContent = config.token_address;
        $('tx').value = sessionStorage.getItem('oa-funding-deposit-tx') || '';
        await refreshBalance();
        status(config.chain_id === 1 ? 'Funding uses real USDC and ETH for gas. Review the amount and vault in MetaMask.' : 'Use Sepolia test USDC and Sepolia ETH for gas.');
        $('fund').disabled = false;
    } catch (error) { status(error.message); }
})();
