import { getAddress, parseUnits, formatUnits } from 'ethers';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { getVersionTable } from '../versioning/activeVersion.mjs';
import { noteBoundV1 } from '../versioning/adapters/noteBoundV1.mjs';
import { addressFundingWallet, installedVersionContext } from './addressFundingProvider.mjs';

export function fundingEthAmount(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw new Error('Enter an ETH amount with up to 18 decimal places.');
    const amount = parseUnits(text, 18);
    if (amount <= 0n || amount >= 2n ** 256n) throw new Error('Enter a positive ETH amount.');
    return amount.toString();
}

// Addresses a typed destination may never be, once more than one protocol
// version exists: the vault of every registered version (live or retired; none
// accepts a plain transfer, and one is never a wallet) and, while versions
// differ, this browser's own funding address. Funds sent there would be
// reachable only through a funding scope the next version no longer shows.
// A single-version build denies only its own vault, which is the funding
// contract fundingDestination already refuses, so nothing changes there.
function defaultDeniedDestinations() {
    const table = getVersionTable();
    const denied = table.map(version => version.vault).filter(vault => typeof vault === 'string' && vault);
    const versioned = table.filter(version => version.status !== 'retired').length > 1
        || table.some(version => version.status === 'retired');
    const own = versioned ? addressFundingWallet.address : null;
    if (own) denied.push(own);
    return denied;
}

// `denied` replaces the registry-derived list for a caller that knows better
// (a saved destination is not user input; a rescue sweep may target the
// current funding address on purpose). The vault of `funding` is always
// refused.
export function fundingDestination(value, funding = zkapiClient.config?.funding, { denied } = {}) {
    let result;
    try { result = getAddress(String(value ?? '').trim()); }
    catch { throw new Error('Enter a valid Ethereum withdrawal address.'); }
    const same = address => typeof address === 'string' && address.toLowerCase() === result.toLowerCase();
    if (/^0x0{40}$/i.test(result) || same(funding?.contract_address)) {
        throw new Error('Use your own receiving address, not the vault contract.');
    }
    const own = addressFundingWallet.address;
    for (const address of denied ?? defaultDeniedDestinations()) {
        if (!same(address)) continue;
        throw new Error(own && same(own)
            ? 'Use an address in your own wallet, not this browser’s funding address.'
            : 'Use your own receiving address, not a vault contract.');
    }
    return result;
}

export function formatFundingAmount(value, decimals = 6) {
    try { return formatUnits(String(value), decimals); } catch { return '—'; }
}

export function withdrawalDestination(owner, recordId = null) {
    const record = recordId ? zkapiClient.withdrawals.find(entry => entry.recordId === recordId) : null;
    const saved = record?.destination || zkapiClient.config?.prepared_withdrawal?.destination
        || zkapiClient.withdrawal?.destination;
    // A saved destination was fixed when its withdrawal was prepared and cannot
    // be edited. It must stay completable, so only typed input meets the
    // version-aware denylist.
    return saved ? fundingDestination(saved, undefined, { denied: [] }) : fundingDestination(owner.fundingDestination);
}

export function canQuotePendingAddressDeposit(client = zkapiClient, wallet = addressFundingWallet) {
    return client.config?.pending_deposit?.funding_quote_available === true
        && !wallet.hasPendingTransaction;
}

// An explicit UI action authorizes only that SDK operation. Opening, refreshing
// or unlocking an address never authorizes signing or sending a transaction.
export async function runAddressAction(owner, details, report, action) {
    const kind = details?.kind;
    let authorization;
    if (kind === 'deposit' && details?.phase === 'wallet') {
        if (!addressFundingWallet.unlocked) throw new Error('Your funding address is not available in this browser.');
        const pending = zkapiClient.config?.pending_deposit;
        if (pending && !canQuotePendingAddressDeposit()) {
            throw new Error('Check the saved deposit status before continuing.');
        }
        if (!owner.fundingFlow) throw new Error('Enter a deposit amount before choosing Deposit.');
        const intent = await owner.fundingFlow.verifyReady();
        if (pending && (String(pending.amount) !== intent.amount
            || pending.operation_id !== intent.preparedOperationId)) {
            throw new Error('The saved deposit changed. Reopen this screen before continuing.');
        }
        owner.fundingDepositIntent = intent;
        authorization = { kind: 'deposit', amount: intent.amount,
            preparedOperationId: intent.preparedOperationId, depositCommitment: intent.depositCommitment,
            feeLimitWei: intent.feeLimitWei, feeQuoteExpiresAt: intent.feeQuoteExpiresAt };
    } else if (kind === 'withdraw' || kind === 'escape') {
        const record = details.withdrawalRecordId ? zkapiClient.withdrawals.find(entry => entry.recordId === details.withdrawalRecordId) : null;
        authorization = { kind: 'withdrawal', destination: withdrawalDestination(owner, details.withdrawalRecordId),
            // An explicit escape choice can replace an unsubmitted mutual
            // plan. The SDK rechecks that transition under its wallet lock.
            mode: record?.mode || (kind === 'escape' ? 'escape' : zkapiClient.config?.prepared_withdrawal?.mode || owner.withdrawMode),
            noteId: record?.noteId ?? zkapiClient.note?.note_id };
        // The amount an escape concedes, only where the protocol has one and
        // only as the caller confirmed it. The signer refuses any other value.
        //   conceded     the exact amount
        //   concededMax  a cap: the bound the person was shown before choosing
        // A call that names neither concedes nothing, except that a repeat of
        // an operation the signer already accepted or signed is held to no
        // more than that operation's amount
        // (AddressFundingProvider.continuedAuthorization). This function never
        // reads the SDK's saved plan to fill either one: the plan records what
        // the SDK proved, not what anyone confirmed, so a refused action
        // repeated without its bound stays refused. A call site that continues
        // an escape the signer has not itself accepted (a saved plan after a
        // reload, a set-aside record) must therefore pass the bound it showed.
        // Where there is none to show (the state's bound has fallen to nothing
        // since the plan was prepared), the signer refuses before anything is
        // signed, in words that tell the person to start the withdrawal again
        // (CONCESSION_UNCONFIRMED_MESSAGE). By then the SDK has usually cleared
        // the unsubmitted plan itself, so the words name no button.
        if (details.conceded != null) authorization.conceded = String(details.conceded);
        if (details.concededMax != null) authorization.concededMax = String(details.concededMax);
        // The prepared withdrawal the person looked at. The signer refuses a
        // call for another one.
        if (details.operationId != null) authorization.operationId = String(details.operationId);
    } else if (kind === 'payout-claim') {
        // Delivering a credited escape payout. Only a protocol that credits
        // payouts has this call; the destination is the saved record's, which
        // the claimant never chooses.
        const claim = (installedVersionContext().adapter?.callProfile ?? noteBoundV1.callProfile).claim;
        if (!claim) throw new Error('This version has no payout to claim.');
        const record = details.withdrawalRecordId ? zkapiClient.withdrawals.find(entry => entry.recordId === details.withdrawalRecordId) : null;
        if (!record?.destination) throw new Error('Choose the payout to claim first.');
        authorization = { kind: claim.authorizationKind, destination: fundingDestination(record.destination, undefined, { denied: [] }),
            recordId: record.recordId, noteId: record.noteId };
    } else if (kind === 'escape-finalize') {
        const record = details.withdrawalRecordId ? zkapiClient.withdrawals.find(entry => entry.recordId === details.withdrawalRecordId) : zkapiClient.withdrawal;
        authorization = { kind: 'finalization', noteId: record?.noteId ?? record?.note_id };
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
