import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { addressFundingWallet } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { fundingAmount, fundingEthAmount, fundingDestination, runAddressAction, withdrawalDestination } from '../../chat/zkapi/services/addressFunding.js';

const recipient = '0x2222222222222222222222222222222222222222';
const savedRecipient = '0x3333333333333333333333333333333333333333';
const funding = {
    chain_id: 11155111,
    contract_address: '0x4444444444444444444444444444444444444444',
    demo_billing_token_address: '0x5555555555555555555555555555555555555555'
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
    t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', async () => ({ shortfallWei: '0', transactionFeeWei: '100', feeReserveWei: '200' }));
    const authorizations = [];
    t.mock.method(addressFundingWallet, 'withAuthorizedAction', async (authorization, action) => {
        authorizations.push(authorization);
        return action();
    });
    t.mock.method(addressFundingWallet, 'getStatus', async () => ({ tokenBalance: '100000000', ethBalance: '1000000000000000' }));
    const owner = { depositAmount: '2.50', fundingDestination: recipient, withdrawMode: 'mutual', render() {} };
    return { owner, authorizations };
}

test('amount parsing preserves six-decimal units and rejects ambiguous or excessive values', () => {
    assert.equal(fundingAmount(' 2.123456 '), '2123456');
    assert.equal(fundingAmount('0.000001'), '1');
    for (const invalid of ['', '0', '-1', '1e2', '1,000', '1.0000001', '1000000.000001', 'NaN']) {
        assert.throws(() => fundingAmount(invalid), undefined, invalid);
    }
});

test('exact ETH returns preserve 18-decimal precision and reject rounding or exponent notation', () => {
    assert.equal(fundingEthAmount('0.000000000000000001'), '1');
    assert.equal(fundingEthAmount(' 1.123456789012345678 '), '1123456789012345678');
    for (const invalid of ['', '0', '-1', '1e-18', '0.0000000000000000001', 'NaN', (2n ** 256n).toString()]) {
        assert.throws(() => fundingEthAmount(invalid), undefined, invalid);
    }
});

test('destinations reject zero, token and vault addresses before any signer action', () => {
    assert.equal(fundingDestination(recipient, funding), recipient);
    for (const invalid of ['', 'not an address', `0x${'0'.repeat(40)}`, funding.contract_address, funding.demo_billing_token_address]) {
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

test('resuming a saved deposit authorizes the SDK public pending_deposit amount', async t => {
    const { owner, authorizations } = fixture(t, { config: { funding, pending_deposit: { amount: 4750000, phase: 'prepared' } } });
    owner.depositAmount = null;
    owner.fundingFlow = { verifyReady() { assert.fail('a saved SDK deposit must keep its original amount'); } };
    await runAddressAction(owner, { kind: 'deposit', phase: 'wallet' }, () => {}, async () => {});
    assert.deepEqual(authorizations, [{ kind: 'deposit', amount: '4750000' }]);
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

test('fresh deposits require a native deployment and a prepared read-only funding flow', async t => {
    const { owner, authorizations } = fixture(t);
    owner.fundingFlow = { verifyReady() { assert.fail('an ERC20 deployment cannot authorize an ETH deposit'); } };
    await assert.rejects(runAddressAction(owner, { kind: 'deposit', phase: 'wallet' }, () => {}, async () => {}), /Enter a deposit amount before choosing Deposit/);
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
    assert.deepEqual(authorizations, [{ kind: 'withdrawal', feeLimitWei: '100', destination: savedRecipient, mode: 'escape', noteId: 7 }]);
});

test('background withdrawal retry uses its own persisted destination, note and mode', async t => {
    const { owner, authorizations } = fixture(t, {
        withdrawals: [{ recordId: 'background-9', destination: savedRecipient, noteId: 9, mode: 'escape' }]
    });
    await runAddressAction(owner, { kind: 'withdraw', phase: 'wallet', withdrawalRecordId: 'background-9' }, () => {}, async () => {});
    assert.deepEqual(authorizations, [{ kind: 'withdrawal', feeLimitWei: '100', destination: savedRecipient, mode: 'escape', noteId: 9 }]);
});

test('explicit escape recovery authorizes escape while retaining the interrupted mutual destination', async t => {
    const { owner, authorizations } = fixture(t, { config: { funding,
        prepared_withdrawal: { destination: savedRecipient, mode: 'mutual', phase: 'reserving' } } });
    owner.withdrawMode = 'escape';
    await runAddressAction(owner, { kind: 'escape', phase: 'settling' }, () => {}, async () => {});
    assert.deepEqual(authorizations, [{ kind: 'withdrawal', feeLimitWei: '100', destination: savedRecipient, mode: 'escape', noteId: 7 }]);
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

test('an unfunded withdrawal is rejected before settlement, proof or signer authorization', async t => {
    const { owner, authorizations } = fixture(t);
    t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', async () => ({ shortfallWei: '50', chainId: 1, address: recipient }));
    let starts = 0;
    await assert.rejects(runAddressAction(owner, { kind: 'withdraw' }, () => {}, async () => { starts++; }), /ETH more/);
    assert.equal(starts, 0);
    assert.deepEqual(authorizations, []);
});

test('a fee increase requires review before any withdrawal work starts', async t => {
    const { owner, authorizations } = fixture(t);
    owner.withdrawalFees = { quote: { feeReserveWei: '150' } };
    let starts = 0;
    await assert.rejects(runAddressAction(owner, { kind: 'withdraw' }, () => {}, async () => { starts++; }), /fees changed/);
    assert.equal(starts, 0);
    assert.deepEqual(authorizations, []);
});
