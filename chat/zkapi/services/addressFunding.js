import { getAddress, parseUnits, formatUnits } from 'ethers';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { addressFundingWallet } from './addressFundingProvider.mjs';

export function fundingAmount(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw new Error('Enter an amount with up to six decimal places.');
    const amount = parseUnits(text, 6);
    if (amount <= 0n || amount > 1_000_000_000_000n) throw new Error('Enter an amount between 0.000001 and 1,000,000.');
    return amount.toString();
}

export function fundingEthAmount(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw new Error('Enter an ETH amount with up to 18 decimal places.');
    const amount = parseUnits(text, 18);
    if (amount <= 0n || amount >= 2n ** 256n) throw new Error('Enter a positive ETH amount.');
    return amount.toString();
}

export function fundingDestination(value, funding = zkapiClient.config?.funding) {
    let result;
    try { result = getAddress(String(value ?? '').trim()); }
    catch { throw new Error('Enter a valid Ethereum withdrawal address.'); }
    if (/^0x0{40}$/i.test(result) || [funding?.contract_address, funding?.demo_billing_token_address]
        .some(address => address?.toLowerCase() === result.toLowerCase())) {
        throw new Error('Use your own receiving address, not a token or vault contract.');
    }
    return result;
}

export function formatFundingAmount(value, decimals = 6) {
    try { return formatUnits(String(value), decimals); } catch { return '—'; }
}

export function withdrawalDestination(owner, recordId = null) {
    const record = recordId ? zkapiClient.withdrawals.find(entry => entry.recordId === recordId) : null;
    return fundingDestination(record?.destination || zkapiClient.config?.prepared_withdrawal?.destination
        || zkapiClient.withdrawal?.destination || owner.fundingDestination);
}

// An explicit UI action authorizes only that SDK operation. Opening, refreshing
// or unlocking an address never authorizes signing or sending a transaction.
export async function runAddressAction(owner, details, report, action) {
    const kind = details?.kind;
    let authorization;
    if (kind === 'deposit' && details?.phase === 'wallet') {
        if (!addressFundingWallet.unlocked) throw new Error('Your funding address is not available in this browser.');
        let amount = zkapiClient.config?.pending_deposit?.amount;
        if (amount == null) {
            if (!zkapiClient.isNativeEthFunding || !owner.fundingFlow) throw new Error('Prepare an ETH deposit before choosing Next.');
            owner.fundingDepositIntent = await owner.fundingFlow.verifyReady();
            amount = owner.fundingDepositIntent.amount;
        }
        authorization = { kind: 'deposit', amount: String(amount) };
    } else if (kind === 'withdraw' || kind === 'escape') {
        const record = details.withdrawalRecordId ? zkapiClient.withdrawals.find(entry => entry.recordId === details.withdrawalRecordId) : null;
        authorization = { kind: 'withdrawal', destination: withdrawalDestination(owner, details.withdrawalRecordId),
            mode: record?.mode || zkapiClient.config?.prepared_withdrawal?.mode || owner.withdrawMode,
            noteId: record?.noteId ?? zkapiClient.note?.note_id };
    } else if (kind === 'escape-finalize') {
        const record = details.withdrawalRecordId ? zkapiClient.withdrawals.find(entry => entry.recordId === details.withdrawalRecordId) : zkapiClient.withdrawal;
        authorization = { kind: 'finalization', noteId: record?.noteId ?? record?.note_id };
    } else if (kind === 'token') {
        authorization = { kind: 'token', amount: '10000000' };
    }
    if (!authorization) {
        // A user's explicit status check may replay a saved signed transaction.
        // Locked accounts remain readable, and ordinary background reads do not
        // enter this scope or authorize rebroadcast.
        if (addressFundingWallet.unlocked && (kind === 'withdraw-sync' || (kind === 'deposit' && details?.phase === 'syncing'))) {
            return addressFundingWallet.withAuthorizedAction({ kind: 'recovery' }, action);
        }
        return action();
    }
    return addressFundingWallet.withAuthorizedAction(authorization, action);
}
