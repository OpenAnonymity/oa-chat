import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { addressFundingWallet } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { fundingEthAmount, fundingDestination, runAddressAction, withdrawalDestination } from '../../chat/zkapi/services/addressFunding.js';

const recipient = '0x2222222222222222222222222222222222222222';
const savedRecipient = '0x3333333333333333333333333333333333333333';
const funding = {
    chain_id: 11155111,
    contract_address: '0x4444444444444444444444444444444444444444'
};

function fixture(t, extra = {}) {
    const original = { config: zkapiClient.config, wallet: zkapiClient.wallet,
        withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals };
    const walletState = addressFundingWallet.state;
    const nativeDescriptor = Object.getOwnPropertyDescriptor(zkapiClient, 'isNativeEthFunding');
    Object.defineProperty(zkapiClient, 'isNativeEthFunding', { configurable: true,
        get: () => zkapiClient.config?.funding?.billing_asset === 'native_eth' });
    Object.assign(zkapiClient, { config: { funding }, wallet: { note: { note_id: 7 } }, withdrawal: null, withdrawals: [] }, extra);
    addressFundingWallet.state = { exists: true, unlocked: true, backedUp: true, address: recipient, pending: null };
    t.after(() => {
        Object.assign(zkapiClient, original);
        addressFundingWallet.state = walletState;
        if (nativeDescriptor) Object.defineProperty(zkapiClient, 'isNativeEthFunding', nativeDescriptor);
        else delete zkapiClient.isNativeEthFunding;
    });
    const authorizations = [];
    t.mock.method(addressFundingWallet, 'withAuthorizedAction', async (authorization, action) => {
        authorizations.push(authorization);
        return action();
    });
    t.mock.method(addressFundingWallet, 'getStatus', async () => ({ tokenBalance: '100000000', ethBalance: '1000000000000000' }));
    const owner = { depositAmount: '2.50', fundingDestination: recipient, withdrawMode: 'mutual', render() {} };
    return { owner, authorizations };
}

test('exact ETH returns preserve 18-decimal precision and reject rounding or exponent notation', () => {
    assert.equal(fundingEthAmount('0.000000000000000001'), '1');
    assert.equal(fundingEthAmount(' 1.123456789012345678 '), '1123456789012345678');
    for (const invalid of ['', '0', '-1', '1e-18', '0.0000000000000000001', 'NaN', (2n ** 256n).toString()]) {
        assert.throws(() => fundingEthAmount(invalid), undefined, invalid);
    }
});

test('destinations reject zero and vault addresses before any signer action', () => {
    assert.equal(fundingDestination(recipient, funding), recipient);
    for (const invalid of ['', 'not an address', `0x${'0'.repeat(40)}`, funding.contract_address]) {
        assert.throws(() => fundingDestination(invalid, funding), undefined, invalid);
    }
});

test('Next rechecks the saved ETH intent before authorizing its exact native units', async t => {
    const { owner, authorizations } = fixture(t, { config: { funding: { ...funding, billing_asset: 'native_eth' } } });
    let calls = 0;
    let verified = false;
    owner.fundingFlow = { async verifyReady() {
        assert.deepEqual(authorizations, [], 'balance and fee checks happen before signer authorization');
        verified = true;
        return { amount: '1250000', ethAmount: '0.00125', depositWei: '1250000000000000', usdAmount: '2.50',
            preparedOperationId: 'op-1', depositCommitment: 'commitment-1', feeLimitWei: '1234', feeQuoteExpiresAt: 42_000 };
    } };
    await runAddressAction(owner, { kind: 'deposit', phase: 'wallet' }, () => {}, async () => {
        assert.equal(verified, true);
        assert.equal(owner.fundingDepositIntent.ethAmount, '0.00125');
        calls++;
    });
    assert.deepEqual(authorizations, [{ kind: 'deposit', amount: '1250000', preparedOperationId: 'op-1',
        depositCommitment: 'commitment-1', feeLimitWei: '1234', feeQuoteExpiresAt: 42_000 }]);
    assert.equal(calls, 1);
});

test('a saved deposit cannot resume until its fee quote can be rechecked', async t => {
    const { owner, authorizations } = fixture(t, { config: { funding, pending_deposit: { amount: 4750000, phase: 'prepared' } } });
    owner.depositAmount = null;
    owner.fundingFlow = { verifyReady() { assert.fail('an unquotable saved deposit must not be re-prepared'); } };
    await assert.rejects(runAddressAction(owner, { kind: 'deposit', phase: 'wallet' }, () => {}, async () => {}), /Check the saved deposit status/);
    assert.deepEqual(authorizations, []);
});

test('failed readiness after fee or balance changes never enters signer authorization', async t => {
    const { owner, authorizations } = fixture(t, { config: { funding: { ...funding, billing_asset: 'native_eth' } } });
    const error = new Error('The address needs more ETH to cover current network fees.');
    owner.fundingFlow = { async verifyReady() { throw error; } };
    let sent = false;
    await assert.rejects(runAddressAction(owner, { kind: 'deposit', phase: 'wallet' }, () => {}, async () => { sent = true; }), error);
    assert.equal(sent, false);
    assert.deepEqual(authorizations, []);
});

test('fresh deposits require a prepared read-only funding flow', async t => {
    const { owner, authorizations } = fixture(t);
    zkapiClient.config = { funding: { ...funding, billing_asset: 'native_eth' } };
    owner.fundingFlow = null;
    await assert.rejects(runAddressAction(owner, { kind: 'deposit', phase: 'wallet' }, () => {}, async () => {}), /Enter a deposit amount before choosing Deposit/);
    assert.deepEqual(authorizations, []);
});

test('a locked address cannot start deposit authorization or balance polling', async t => {
    const { owner, authorizations } = fixture(t);
    addressFundingWallet.state.unlocked = false;
    const balance = t.mock.method(addressFundingWallet, 'getStatus', async () => { throw new Error('unexpected read'); });
    await assert.rejects(runAddressAction(owner, { kind: 'deposit', phase: 'wallet' }, () => {}, async () => {}), /not available in this browser/);
    assert.equal(balance.mock.callCount(), 0);
    assert.deepEqual(authorizations, []);
});

test('prepared withdrawal destination and mode take precedence over edited inputs', async t => {
    const { owner, authorizations } = fixture(t, { config: { funding, prepared_withdrawal: { destination: savedRecipient, mode: 'escape' } } });
    assert.equal(withdrawalDestination(owner), savedRecipient);
    await runAddressAction(owner, { kind: 'withdraw', phase: 'wallet' }, () => {}, async () => {});
    assert.deepEqual(authorizations, [{ kind: 'withdrawal', destination: savedRecipient, mode: 'escape', noteId: 7 }]);
});

test('background withdrawal retry uses its own persisted destination, note and mode', async t => {
    const { owner, authorizations } = fixture(t, {
        withdrawals: [{ recordId: 'background-9', destination: savedRecipient, noteId: 9, mode: 'escape' }]
    });
    await runAddressAction(owner, { kind: 'withdraw', phase: 'wallet', withdrawalRecordId: 'background-9' }, () => {}, async () => {});
    assert.deepEqual(authorizations, [{ kind: 'withdrawal', destination: savedRecipient, mode: 'escape', noteId: 9 }]);
});

test('explicit escape recovery authorizes escape while retaining the interrupted mutual destination', async t => {
    const { owner, authorizations } = fixture(t, { config: { funding,
        prepared_withdrawal: { destination: savedRecipient, mode: 'mutual', phase: 'reserving' } } });
    owner.withdrawMode = 'escape';
    await runAddressAction(owner, { kind: 'escape', phase: 'settling' }, () => {}, async () => {});
    assert.deepEqual(authorizations, [{ kind: 'withdrawal', destination: savedRecipient, mode: 'escape', noteId: 7 }]);
});

test('finalization authorizes the selected saved note rather than the active note', async t => {
    const { owner, authorizations } = fixture(t, {
        withdrawal: { note_id: 8, destination: savedRecipient },
        withdrawals: [{ recordId: 'background-9', noteId: 9, destination: savedRecipient }]
    });
    await runAddressAction(owner, { kind: 'escape-finalize', phase: 'wallet' }, () => {}, async () => {});
    await runAddressAction(owner, { kind: 'escape-finalize', phase: 'wallet', withdrawalRecordId: 'background-9' }, () => {}, async () => {});
    assert.deepEqual(authorizations, [{ kind: 'finalization', noteId: 8 }, { kind: 'finalization', noteId: 9 }]);
});

test('local cancellation never creates signer authorization', async t => {
    const { owner, authorizations } = fixture(t);
    let canceled = false;
    await runAddressAction(owner, { kind: 'deposit', phase: 'local' }, () => {}, async () => { canceled = true; });
    assert.equal(canceled, true);
    assert.deepEqual(authorizations, []);
});

test('explicit status checks authorize only recovery while an unlocked account is available', async t => {
    const { owner, authorizations } = fixture(t);
    let checked = 0;
    for (const details of [{ kind: 'withdraw-sync', phase: 'syncing' }, { kind: 'deposit', phase: 'syncing' }]) {
        await runAddressAction(owner, details, () => {}, async () => { checked++; });
    }
    assert.deepEqual(authorizations, [{ kind: 'recovery' }, { kind: 'recovery' }]);
    assert.equal(checked, 2);

    addressFundingWallet.state.unlocked = false;
    await runAddressAction(owner, { kind: 'withdraw-sync', phase: 'syncing' }, () => {}, async () => { checked++; });
    assert.equal(checked, 3, 'locked accounts can still perform read-only SDK checks');
    assert.equal(authorizations.length, 2, 'locked checks cannot rebroadcast');
});

test('a normal private-balance refresh does not authorize transaction recovery or signing', async t => {
    const { owner, authorizations } = fixture(t);
    await runAddressAction(owner, { kind: 'refresh', phase: 'syncing' }, () => {}, async () => {});
    assert.deepEqual(authorizations, []);
});


test('safe unsubmitted native resumes recheck and bind the same prepared operation and quoted fee', async t => {
    const { owner, authorizations } = fixture(t, { config: { funding: { ...funding, billing_asset: 'native_eth' },
        pending_deposit: { amount: 1250000, phase: 'prepared', operation_id: 'op-1', funding_quote_available: true } } });
    owner.fundingFlow = { async verifyReady() { return { amount: '1250000', preparedOperationId: 'op-1',
        depositCommitment: 'commitment-1', feeLimitWei: '1234', feeQuoteExpiresAt: 42_000 }; } };
    await runAddressAction(owner, { kind: 'deposit', phase: 'wallet' }, () => {}, async () => {});
    assert.deepEqual(authorizations, [{ kind: 'deposit', amount: '1250000', preparedOperationId: 'op-1',
        depositCommitment: 'commitment-1', feeLimitWei: '1234', feeQuoteExpiresAt: 42_000 }]);
});

test('unsafe native pending and changed prepared operations cannot fall back to an unquoted allowance', async t => {
    const { owner, authorizations } = fixture(t, { config: { funding: { ...funding, billing_asset: 'native_eth' },
        pending_deposit: { amount: 1250000, phase: 'prepared', operation_id: 'op-1' } } });
    owner.fundingFlow = { async verifyReady() { return { amount: '1250000', preparedOperationId: 'different' }; } };
    await assert.rejects(runAddressAction(owner, { kind: 'deposit', phase: 'wallet' }, () => {}, async () => {}), /saved deposit status/);
    zkapiClient.config.pending_deposit.funding_quote_available = true;
    await assert.rejects(runAddressAction(owner, { kind: 'deposit', phase: 'wallet' }, () => {}, async () => {}), /saved deposit changed/);
    assert.deepEqual(authorizations, []);
});

// -- Sponsored withdrawals -------------------------------------------------------
//
// A withdrawal that pays its network fee out of itself is bound to a holding
// address (its record's `destination`) and names who is paid in `payout`. The
// signer must hold the operation to the person's own address, never to the
// holding address, and to the figures that were shown.

const payee = '0x6666666666666666666666666666666666666666';
const holding = '0x7777777777777777777777777777777777777777';

test('a new sponsored withdrawal is authorized for the typed address, with the bounds that were shown', async t => {
    const { owner, authorizations } = fixture(t);
    await runAddressAction(owner, { kind: 'withdraw', sponsored: { feeCapWei: '10000000000000', maxCostWei: '49125000000000000' } },
        () => {}, async () => {});
    assert.equal(authorizations.length, 1);
    assert.deepEqual(authorizations[0], {
        kind: 'withdrawal', destination: recipient, mode: 'mutual', noteId: 7,
        sponsored: { feeCapWei: '10000000000000', maxCostWei: '49125000000000000' }
    });
    // Anything that is not a decimal amount is dropped: the signer then holds
    // to the paymaster's own pinned figures, not to a string it cannot read.
    authorizations.length = 0;
    await runAddressAction(owner, { kind: 'withdraw', sponsored: { feeCapWei: '1e9', maxCostWei: -1, extra: 'x' } }, () => {}, async () => {});
    assert.deepEqual(authorizations[0].sponsored, {});
    // A withdrawal with no sponsored plan carries no such field at all.
    authorizations.length = 0;
    await runAddressAction(owner, { kind: 'withdraw' }, () => {}, async () => {});
    assert.equal('sponsored' in authorizations[0], false);
});

test('a saved sponsored plan or record is authorized for its payee, not its holding address', async t => {
    const { owner, authorizations } = fixture(t);
    // The prepared plan of the page.
    zkapiClient.config = { funding, prepared_withdrawal: { mode: 'mutual', phase: 'prepared', note_id: 7, fee_payer: 'payout',
        destination: holding, payout: payee } };
    await runAddressAction(owner, { kind: 'withdraw', sponsored: {} }, () => {}, async () => {});
    assert.equal(authorizations[0].destination, payee);
    assert.equal(authorizations[0].mode, 'mutual');
    // A record of a sponsored escape: authorization to finish it names the
    // payee too, and is sponsored.
    zkapiClient.config = { funding };
    zkapiClient.withdrawals = [{ recordId: 'r-1', noteId: 7, mode: 'escape', feePayer: 'payout', destination: holding, payout: payee,
        transit: { account: holding } }];
    authorizations.length = 0;
    await runAddressAction(owner, { kind: 'escape-finalize', withdrawalRecordId: 'r-1' }, () => {}, async () => {});
    assert.deepEqual(authorizations[0], { kind: 'finalization', noteId: 7, destination: payee, sponsored: {} });
    // A wallet-paid record is as it was: no destination, nothing sponsored.
    zkapiClient.withdrawals = [{ recordId: 'r-2', noteId: 7, mode: 'escape', destination: recipient }];
    authorizations.length = 0;
    await runAddressAction(owner, { kind: 'escape-finalize', withdrawalRecordId: 'r-2' }, () => {}, async () => {});
    assert.deepEqual(authorizations[0], { kind: 'finalization', noteId: 7 });
});

test('collecting a payout is authorized for the record\'s payee and its own holding address, and only for such a record', async t => {
    const { owner, authorizations } = fixture(t);
    zkapiClient.withdrawals = [{ recordId: 'r-3', noteId: 7, mode: 'mutual', feePayer: 'payout', destination: holding, payout: payee,
        transit: { account: holding }, fundsWaitingInTransit: true }];
    await runAddressAction(owner, { kind: 'transit-collect', withdrawalRecordId: 'r-3', sponsored: { feeCapWei: '5' } }, () => {}, async () => {});
    assert.deepEqual(authorizations[0], { kind: 'collection', destination: payee,
        sponsored: { feeCapWei: '5', transitAccount: holding } });
    // A record without a holding address, or one that is wallet-paid, has none.
    zkapiClient.withdrawals = [{ recordId: 'r-4', noteId: 7, mode: 'mutual', destination: recipient }];
    await assert.rejects(runAddressAction(owner, { kind: 'transit-collect', withdrawalRecordId: 'r-4' }, () => {}, async () => {}),
        /Choose the withdrawal to collect first/);
    await assert.rejects(runAddressAction(owner, { kind: 'transit-collect', withdrawalRecordId: 'missing' }, () => {}, async () => {}),
        /Choose the withdrawal to collect first/);
});
