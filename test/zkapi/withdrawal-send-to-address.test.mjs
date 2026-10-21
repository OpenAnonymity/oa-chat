// "Send to address" withdrawals pay their network fee from the withdrawal
// (the sponsored, ERC-4337 path) and only that way.
//
// What is pinned:
//   - the form offers one fee answer ("Paid from this withdrawal"): no wallet
//     radio, no "Paid by your wallet", no funding-address fee line;
//   - Continue is the gesture that asks for the fee of the typed destination,
//     then opens the review; only the review's explicit confirmation starts
//     the sponsored withdrawal, signed by the browser-held key with no ETH
//     read, no wallet connected and no address-funded authorization;
//   - an invalid destination is refused before any quote, key or send;
//   - a balance whose version pins no reviewed sponsorship (mainnet version 1,
//     the earlier Sepolia versions), or a page without the facade, keeps the
//     Send to address route it always had: its funding address pays the fee,
//     with no fee choice, no "unavailable" notice and no relay;
//   - on a sponsored version a refused quote (escapes disabled) says so; a new
//     form offers the Ethereum wallet method only for a refusal a wallet can
//     cure, and a saved payout plan only checks again;
//   - a quote is never filed under a destination it was not asked for, even
//     when the destination changes while the signing key is being made;
//   - a saved wallet-paid withdrawal of this method still continues as it
//     started, from its funding address;
//   - the Ethereum wallet method keeps both choices, the wallet first.
import test from 'node:test';
import assert from 'node:assert/strict';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import vectors from '../fixtures/zkapi-sponsored-vectors.json' with { type: 'json' };
import AccountModal from '../../chat/zkapi/components/AccountModal.js';
import { renderSponsoredFee } from '../../chat/zkapi/components/SponsoredFee.js';
import { attachWalletMethodControls } from '../../chat/zkapi/components/WalletMethodControls.js';
import { needsWithdrawalFees, refreshWithdrawalFees, stopWithdrawalFees } from '../../chat/zkapi/components/WithdrawalFees.js';
import { addressFundingWallet } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { runAddressAction } from '../../chat/zkapi/services/addressFunding.js';
import { getWalletMethod, setWalletMethod } from '../../chat/zkapi/services/walletMethod.mjs';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { createSponsoredFees } from '../../chat/zkapi/versioning/sponsoredFees.mjs';
import { createDocument } from './_miniDom.mjs';

const signer = `0x${'1'.repeat(40)}`; // the browser-held key: signs, holds no ETH
const vault = `0x${'2'.repeat(40)}`;
const payee = `0x${'3'.repeat(40)}`;
const ORIGIN = 'https://app.example';
const PROXY = '/zkapi-deployment-v4/';
const GASLESS = Object.freeze({
    entry_point_address: vectors.entry_point,
    sender_creator_address: `0x${'51'.repeat(20)}`,
    withdrawal_paymaster_address: vectors.paymaster,
    withdrawal_account_factory_address: vectors.factory,
    entry_point_runtime_codehash: `0x${'61'.repeat(32)}`,
    sender_creator_runtime_codehash: `0x${'62'.repeat(32)}`,
    withdrawal_paymaster_runtime_codehash: `0x${'63'.repeat(32)}`,
    withdrawal_account_factory_runtime_codehash: `0x${'64'.repeat(32)}`,
    account_creation_code: vectors.account_creation_code,
    account_creation_code_keccak256: vectors.account_creation_code_keccak256,
    bundler_url: 'https://bundler.example/rpc',
    policy: { max_sponsored_cost_wei: vectors.policy.max_sponsored_cost, flat_fee_wei: vectors.policy.flat_fee_wei },
    fee_ceilings: { max_fee_wei: vectors.policy.max_fee_ceiling, priority_fee_wei: vectors.policy.priority_fee_ceiling },
    gas_policy: { call_floor: [1] }
});
const READY = Object.freeze({ available: true, maxCost: '100000000000', flatFeeWei: vectors.policy.flat_fee_wei,
    minimumReceivedWei: '890000000000', payoutWei: '1000000000000' });
const words = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const until = async (check, tries = 50) => {
    for (let i = 0; i < tries && !check(); i++) await new Promise(resolve => setImmediate(resolve));
};

// A withdrawal form over the real fee renderer and the real sponsored facade
// half, with a relay client that records every question it is asked.
function fixture(t, { method = 'address', sponsored = true, facade = true, quote = READY, prepared = null,
    address = signer, budget = null } = {}) {
    const original = { config: zkapiClient.config, wallet: zkapiClient.wallet, withdrawal: zkapiClient.withdrawal,
        withdrawals: zkapiClient.withdrawals, browserMode: zkapiClient.browserMode,
        hadFacade: Object.hasOwn(zkapiClient, 'oaVersioning'), facade: zkapiClient.oaVersioning };
    const methodBefore = getWalletMethod();
    const walletState = addressFundingWallet.state;
    addressFundingWallet.state = address ? { address, exists: true, backedUp: true, unlocked: true } : { exists: false };
    setWalletMethod(method);
    Object.assign(zkapiClient, {
        config: { funding: { chain_id: 1, contract_address: vault, billing_asset: 'native_eth' }, prepared_withdrawal: prepared },
        wallet: { note: { note_id: 7, current_balance: 1000 } }, withdrawal: null, withdrawals: [], browserMode: false
    });
    const relay = [];
    const client = {
        setWalletProvider(provider) { relay.push(['provider', provider === addressFundingWallet ? 'browser key' : 'other']); },
        async gaslessWithdrawalQuote(mode, options) {
            relay.push(['quote', mode, options]);
            return typeof quote === 'function' ? quote(mode) : quote;
        }
    };
    const fees = createSponsoredFees({
        getClient: () => client,
        getRuntime: () => ({ browserConfig: { trusted_deployment: { gasless: sponsored ? GASLESS : null } } }),
        getContext: () => ({ adapter: getAdapter('leaf-bound-v2'), version: { id: 'v4', proxyPath: PROXY } }),
        getOrigin: () => ORIGIN
    });
    if (facade) zkapiClient.oaVersioning = { sponsored: fees, ui: { sponsoredFee: options => renderSponsoredFee(options) } };
    else delete zkapiClient.oaVersioning;
    const owner = Object.assign(Object.create(AccountModal.prototype), {
        isOpen: true, view: 'withdraw', withdrawMode: 'mutual', busy: false, fundingBusy: false, walletMethodReady: true,
        status: '', statusError: false, fundingDestination: payee, privateBalanceHelpOpen: {}, render() {},
        escapeHtml: value => String(value ?? ''), overlay: { querySelector: () => null, querySelectorAll: () => [] }
    });
    const budgetRead = t.mock.method(addressFundingWallet, 'getWithdrawalFeeBudget', budget
        || (async () => assert.fail('a new Send to address withdrawal never reads its funding address for a fee')));
    const connect = t.mock.method(zkapiClient, 'connectWallet', async () => assert.fail('Send to address connects no wallet'));
    const ensure = t.mock.method(addressFundingWallet, 'ensureAddress', async () => {
        addressFundingWallet.state = { address: signer, exists: true, backedUp: true, unlocked: true };
        return signer;
    });
    t.after(() => {
        stopWithdrawalFees(owner);
        Object.assign(zkapiClient, { config: original.config, wallet: original.wallet, withdrawal: original.withdrawal,
            withdrawals: original.withdrawals, browserMode: original.browserMode });
        if (original.hadFacade) zkapiClient.oaVersioning = original.facade;
        else delete zkapiClient.oaVersioning;
        setWalletMethod(methodBefore);
        addressFundingWallet.state = walletState;
    });
    const quotes = () => relay.filter(entry => entry[0] === 'quote');
    return { owner, relay, quotes, budgetRead, connect, ensure, route: fees.bundlerUrl() };
}

// What starting the withdrawal does past the click: the dialog's own run is
// replaced by the authorization step the real one takes for Send to address,
// over a signer that records what it was authorized to do.
function startable(t, owner) {
    const authorizations = [];
    t.mock.method(addressFundingWallet, 'withAuthorizedAction', async (authorization, action) => {
        authorizations.push(authorization);
        return action();
    });
    t.mock.method(addressFundingWallet, 'init', async () => {});
    t.mock.method(addressFundingWallet, 'reload', async () => {});
    t.mock.method(zkapiClient, 'init', async () => {});
    t.mock.method(zkapiClient, 'setWalletProvider', () => {});
    t.mock.method(zkapiClient, 'settleActiveLease', async () => {});
    const runs = [];
    owner.run = async (action, details) => {
        runs.push(details);
        const report = () => {};
        return runAddressAction(owner, details, report, () => action(report));
    };
    const withdraw = t.mock.method(zkapiClient, 'withdraw', async () => ({ status: 'submitted' }));
    return { authorizations, runs, withdraw };
}

test('Send to address offers only paying from the withdrawal, and asks nobody until Continue', t => {
    const { owner, relay, budgetRead } = fixture(t);
    // Whatever the Ethereum wallet's own choice is, it does not reach this method.
    for (const choice of [undefined, 'wallet', 'payout']) {
        owner.sponsoredChoice = choice;
        assert.equal(owner.sponsoredChoiceNow(), 'payout');
        const form = owner.renderWithdrawal();
        const radios = form.match(/<input[^>]*name="zkapi-sponsored-fee"[^>]*>/g) || [];
        assert.equal(radios.length, 1);
        assert.match(radios[0], /value="payout"[^>]*checked/);
        assert.doesNotMatch(form, /value="wallet"|Paid by your wallet|address this app holds/);
        assert.match(words(form), /Paid from this withdrawal/);
        assert.match(words(form), /Continue checks the network fee first\. Nothing is sent until you confirm\./);
        // No funding-address fee line: no ETH to add, nothing paid from it.
        assert.doesNotMatch(form, /zkapi-withdraw-fee"|Show deposit address|to your deposit address|Paid from the ETH at your deposit address|Checking available ETH/);
        // The destination is asked for, and Continue is ready to check the fee.
        assert.match(form, /data-funding-withdrawal-destination/);
        assert.match(form, /id="zkapi-withdraw-btn" class="zkapi-primary-button w-full" type="button" >Continue</);
    }
    assert.equal(needsWithdrawalFees(owner), false);
    assert.deepEqual(relay, [], 'drawing the form asks the relay nothing');
    assert.equal(budgetRead.mock.callCount(), 0);
});

test('Continue quotes this withdrawal, the review confirms it, and only then the sponsored withdrawal starts', async t => {
    const { owner, quotes, budgetRead, connect, route } = fixture(t);
    const started = startable(t, owner);
    owner.requestWithdrawal();
    await until(() => owner.withdrawalConfirmation);
    // One question, for this destination, owned by the browser-held key, on
    // the app's own route.
    assert.equal(quotes().length, 1);
    assert.equal(quotes()[0][1], 'mutual');
    assert.deepEqual(quotes()[0][2], { destination: payee, owner: signer, bundlerUrl: route });
    assert.ok(owner.withdrawalConfirmation, 'the review opens on the answer');
    assert.equal(started.withdraw.mock.callCount(), 0, 'a quote sends nothing');
    assert.equal(started.runs.length, 0);
    const review = owner.renderWithdrawal();
    assert.match(review, /No ETH is needed in your signing account/);
    assert.match(review, /Estimates may change before signing/);
    assert.match(review, /zkapi-transfer-address">0x3333333…333333333</, 'the typed destination is the one confirmed');
    assert.match(review, /id="zkapi-withdraw-review-confirm"(?![^>]*disabled)/);
    // The explicit confirmation is what starts it.
    await owner.confirmWithdrawal();
    assert.equal(started.withdraw.mock.callCount(), 1);
    const [mode, , options] = started.withdraw.mock.calls[0].arguments;
    assert.equal(mode, 'mutual');
    assert.equal(options.destination, payee);
    assert.equal(options.fees, 'payout');
    assert.equal(options.bundlerUrl, route);
    assert.equal(options.allowExpensiveGas, false);
    assert.equal(options.feeCapWei, vectors.policy.flat_fee_wei);
    assert.equal(options.maxCostWei, vectors.policy.max_sponsored_cost);
    assert.equal('reviewedFunding' in options, false, 'no wallet-paid fee review');
    // The browser-held key is authorized for exactly this sponsored withdrawal:
    // the bounds shown, this destination, no transaction fee of its own.
    assert.equal(started.authorizations.length, 1);
    const [authorization] = started.authorizations;
    assert.equal(authorization.kind, 'withdrawal');
    assert.equal(authorization.destination.toLowerCase(), payee);
    assert.equal(authorization.mode, 'mutual');
    assert.deepEqual(authorization.sponsored, { feeCapWei: vectors.policy.flat_fee_wei, maxCostWei: vectors.policy.max_sponsored_cost });
    assert.equal('feeLimitWei' in authorization, false);
    assert.deepEqual(started.runs[0].sponsored, authorization.sponsored);
    assert.equal(budgetRead.mock.callCount(), 0, 'its funding address paid nothing and was not read');
    assert.equal(connect.mock.callCount(), 0, 'no wallet was connected');
    // The confirmation is single-use.
    await owner.confirmWithdrawal();
    assert.equal(started.withdraw.mock.callCount(), 1);
});

test('Back from the review approves nothing, and a changed destination needs its own quote and review', async t => {
    const { owner, quotes } = fixture(t);
    const started = startable(t, owner);
    owner.requestWithdrawal();
    await until(() => owner.withdrawalConfirmation);
    owner.withdrawalConfirmation = null; // Back
    await owner.confirmWithdrawal();
    assert.equal(started.withdraw.mock.callCount(), 0);
    owner.fundingDestination = `0x${'4'.repeat(40)}`;
    assert.equal(owner.withdrawalInputReady(), false, 'the quote was for another destination');
    assert.equal(owner.withdrawalContinueReady(), true, 'Continue asks again');
    owner.requestWithdrawal();
    await until(() => owner.withdrawalConfirmation);
    assert.equal(quotes().length, 2);
    assert.equal(quotes()[1][2].destination, `0x${'4'.repeat(40)}`);
    assert.equal(started.withdraw.mock.callCount(), 0, 'still waiting for the confirmation');
});

test('a destination changed while the chat settles cannot redirect a confirmed withdrawal', async t => {
    const { owner } = fixture(t);
    const started = startable(t, owner);
    owner.requestWithdrawal();
    await until(() => owner.withdrawalConfirmation);
    zkapiClient.settleActiveLease.mock.mockImplementation(async () => { owner.fundingDestination = `0x${'4'.repeat(40)}`; });
    await assert.rejects(owner.confirmWithdrawal(), /review the amount again/);
    assert.equal(started.withdraw.mock.callCount(), 0);
});

test('an invalid destination is refused before any quote, key or send', async t => {
    const { owner, relay, ensure, budgetRead } = fixture(t, { address: null });
    const run = t.mock.method(owner, 'run', async () => assert.fail('nothing starts'));
    for (const destination of ['', '0x123', `0x${'0'.repeat(40)}`, vault, 'not an address']) {
        owner.fundingDestination = destination;
        assert.equal(owner.withdrawalContinueReady(), false, destination);
        assert.match(owner.renderWithdrawal(), /id="zkapi-withdraw-btn"[^>]*disabled[^>]*>Continue</);
        owner.requestWithdrawal();
        // "Check again" is refused the same way, in words.
        await owner.refreshSponsoredQuote();
        assert.match(owner.outcome?.message || '', /valid Ethereum withdrawal address|not the vault contract/);
        await owner.submitWithdrawal();
        await until(() => false, 3);
        assert.ok(!owner.withdrawalConfirmation);
    }
    assert.deepEqual(relay, []);
    assert.equal(ensure.mock.callCount(), 0, 'no key is made for an address that is not valid');
    assert.equal(run.mock.callCount(), 0);
    assert.equal(budgetRead.mock.callCount(), 0);
});

test('a person new to Send to address enters the destination first, and Continue makes the signing key it needs', async t => {
    const { owner, quotes, ensure, budgetRead } = fixture(t, { address: null });
    const form = owner.renderWithdrawal();
    assert.match(form, /data-funding-withdrawal-destination/);
    assert.doesNotMatch(form, /Preparing your address/);
    owner.requestWithdrawal();
    await until(() => owner.withdrawalConfirmation);
    assert.equal(ensure.mock.callCount(), 1);
    assert.equal(quotes()[0][2].owner, signer);
    assert.ok(owner.withdrawalConfirmation);
    assert.equal(budgetRead.mock.callCount(), 0, 'the new key is never asked to hold ETH');
});

test('a balance whose version pins no sponsorship keeps the Send to address route it always had', async t => {
    const reserve = { address: signer, chainId: 1, mode: 'mutual', feeReserveWei: '1000', balanceWei: '5000', shortfallWei: '0',
        transactionFeeWei: '900', expiresAt: Date.now() + 60_000 };
    for (const setup of [{ sponsored: false }, { facade: false }]) {
        const { owner, relay, budgetRead, ensure } = fixture(t, { ...setup, budget: async mode => ({ ...reserve, mode }) });
        const started = startable(t, owner);
        assert.equal(owner.addressPayoutOnly(), false);
        assert.equal(owner.sponsoredChoiceNow(), 'wallet');
        assert.equal(needsWithdrawalFees(owner), true, 'its funding address pays, as before');
        assert.equal(await refreshWithdrawalFees(owner), true);
        const form = owner.renderWithdrawal();
        // The old form: the funding-address fee line, no fee choice, no notice.
        assert.match(form, /class="zkapi-withdraw-fee" aria-label="Withdrawal network fee"/);
        assert.match(words(form), /Paid from the ETH at your deposit address\./);
        assert.doesNotMatch(form, /name="zkapi-sponsored-fee"|Paid by your wallet|Paid from this withdrawal|data-zkapi-address-withdrawal-unavailable|isn’t available for this balance|data-wallet-method="metamask"[^>]*>Use Ethereum wallet/);
        assert.equal(owner.addressQuoteOnContinue(), false, 'Continue asks the relay nothing');
        assert.equal(owner.sponsoredPlanFor('mutual'), null, 'not a sponsored withdrawal');
        owner.requestWithdrawal();
        await until(() => owner.withdrawalConfirmation);
        assert.ok(owner.withdrawalConfirmation, 'the review opens as it always did');
        await owner.confirmWithdrawal();
        await until(() => started.withdraw.mock.callCount() > 0);
        assert.equal(started.withdraw.mock.callCount(), 1);
        const [, , options] = started.withdraw.mock.calls[0].arguments;
        assert.notEqual(options.fees, 'payout');
        assert.equal('bundlerUrl' in options, false);
        assert.equal(started.authorizations[0].feeLimitWei, '900', 'the funding address is authorized for its fee');
        assert.equal('sponsored' in started.authorizations[0], false);
        assert.ok(budgetRead.mock.callCount() >= 1);
        assert.equal(ensure.mock.callCount(), 0);
        assert.deepEqual(relay, [], 'the relay is never involved');
    }
});

test('a refused quote (escapes disabled) keeps Send to address closed for it and points at the Ethereum wallet', async t => {
    const refused = mode => (mode === 'escape'
        ? { available: false, reason: 'gasless_unavailable', data: { reason: 'escapes_disabled' } } : READY);
    const { owner, quotes, budgetRead } = fixture(t, { quote: refused });
    const started = startable(t, owner);
    owner.withdrawMode = 'escape';
    owner.requestWithdrawal();
    await until(() => quotes().length === 1 && owner.sponsoredQuote?.status !== 'loading');
    assert.equal(owner.withdrawalConfirmation, undefined, 'no review for a fee that cannot be paid this way');
    const form = owner.renderWithdrawal();
    assert.match(words(form), /doesn’t pay the network fee of an emergency exit\./);
    assert.match(words(form), /Use Ethereum wallet instead\./);
    assert.doesNotMatch(words(form), /from your wallet instead/);
    assert.match(form, /data-wallet-method="metamask"/);
    assert.match(form, /id="zkapi-withdraw-btn"[^>]*disabled[^>]*>Continue</);
    await owner.submitWithdrawal();
    assert.equal(started.withdraw.mock.callCount(), 0);
    assert.equal(started.runs.length, 0);
    assert.equal(budgetRead.mock.callCount(), 0);
});

test('Use Ethereum wallet switches the method, where both fee choices are back, the wallet first', async t => {
    const refused = mode => (mode === 'escape'
        ? { available: false, reason: 'gasless_unavailable', data: { reason: 'escapes_disabled' } } : READY);
    const { owner, quotes } = fixture(t, { quote: refused });
    owner.withdrawMode = 'escape';
    owner.requestWithdrawal();
    await until(() => quotes().length === 1 && owner.sponsoredQuote?.status !== 'loading');
    const document = createDocument();
    const root = document.createElement('div');
    document.body.append(root);
    root.innerHTML = owner.renderWithdrawal();
    owner.overlay = root;
    attachWalletMethodControls(owner);
    root.querySelector('[data-zkapi-sponsored-fieldset] [data-wallet-method="metamask"]').click();
    assert.equal(getWalletMethod(), 'metamask');
    // On a version that has sponsorship, the Ethereum wallet's choice is unchanged.
    const wallet = fixture(t, { method: 'metamask' });
    const form = wallet.owner.renderWithdrawal();
    assert.deepEqual([...form.matchAll(/name="zkapi-sponsored-fee" value="(\w+)"/g)].map(match => match[1]), ['wallet', 'payout']);
    assert.match(form, /value="wallet" checked/);
    assert.match(words(form), /Paid by your wallet/);
    assert.equal(wallet.owner.sponsoredChoiceNow(), 'wallet');
    assert.equal(wallet.owner.sponsoredPlanFor('mutual'), null, 'the wallet pays, as it always did');
    assert.deepEqual(wallet.relay, []);
});

test('a refusal a wallet cannot cure, or a saved payout plan, never offers switching the signer', () => {
    for (const reason of ['exits_paused', 'gasless_op_pending', 'wrong_owner_account']) {
        for (const locked of [false, true]) {
            const html = renderSponsoredFee({ method: 'address', choice: 'payout', status: 'unavailable', locked,
                quote: { available: false, reason, text: `The relay refused (${reason}). You can pay the network fee from your wallet instead.` } });
            assert.doesNotMatch(html, /data-wallet-method|Use Ethereum wallet/, `${reason} locked=${locked}`);
            assert.doesNotMatch(html, /from your wallet instead/, 'no wallet to fall back on here');
            assert.match(html, /data-zkapi-sponsored-retry/, 'checking again stays possible');
            assert.equal(/saved withdrawal keeps paying its network fee from the withdrawal/.test(html), locked);
        }
    }
    // A saved payout plan stays bound to the key that prepared it, even for a
    // refusal a wallet could cure on a new withdrawal.
    const curable = { available: false, reason: 'payout_below_gas', text: 'Too small. You can pay the network fee from your wallet instead.' };
    const saved = renderSponsoredFee({ method: 'address', choice: 'payout', status: 'unavailable', locked: true, quote: curable });
    assert.doesNotMatch(saved, /data-wallet-method|Use Ethereum wallet/);
    assert.match(saved, /data-zkapi-sponsored-retry/);
    const fresh = renderSponsoredFee({ method: 'address', choice: 'payout', status: 'unavailable', locked: false, quote: curable });
    assert.match(fresh, /<button[^>]*data-wallet-method="metamask"[^>]*>Use Ethereum wallet<\/button>/);
});

test('a destination changed while the signing key is made gets no quote asked for another one', async t => {
    const { owner, quotes, ensure } = fixture(t, { address: null });
    let release;
    ensure.mock.mockImplementation(() => new Promise(resolve => {
        release = () => {
            addressFundingWallet.state = { address: signer, exists: true, backedUp: true, unlocked: true };
            resolve(signer);
        };
    }));
    const destinationA = payee;
    const destinationB = `0x${'4'.repeat(40)}`;
    owner.fundingDestination = destinationA;
    const pending = owner.refreshSponsoredQuote('mutual');
    await until(() => typeof release === 'function');
    owner.fundingDestination = destinationB; // typed while the key is being made
    release();
    await pending;
    assert.equal(quotes().length, 0, 'nothing was asked for A once the form said B');
    assert.equal(owner.sponsoredViewState('mutual').status, 'idle', 'B has no quote: Continue asks for it');
    assert.equal(owner.sponsoredQuote, null, 'the stale "Checking…" is cleared');
    // The normal path then asks for B, under B.
    ensure.mock.mockImplementation(async () => signer);
    await owner.refreshSponsoredQuote('mutual');
    assert.equal(quotes().length, 1);
    assert.equal(quotes()[0][2].destination, destinationB);
    assert.equal(owner.sponsoredViewState('mutual').status, 'ready');
});

test('a destination changed while the quote is out files no answer under the new one', async t => {
    let answer;
    const { owner, quotes } = fixture(t, { quote: () => new Promise(resolve => { answer = resolve; }) });
    const pending = owner.refreshSponsoredQuote('mutual');
    await until(() => typeof answer === 'function');
    owner.fundingDestination = `0x${'4'.repeat(40)}`;
    answer(READY);
    await pending;
    assert.equal(quotes()[0][2].destination, payee);
    assert.equal(owner.sponsoredViewState('mutual').status, 'idle', 'A’s fee is never shown for B');
});

test('a saved wallet-paid Send to address withdrawal still continues the way it started', async t => {
    const prepared = { note_id: 7, mode: 'mutual', phase: 'prepared', destination: payee, operation_id: 'withdraw-7', clearance_reserved: true };
    const reserve = { address: signer, chainId: 1, mode: 'mutual', feeReserveWei: '1000', balanceWei: '5000', shortfallWei: '0',
        transactionFeeWei: '900', expiresAt: Date.now() + 60_000 };
    const { owner, relay, budgetRead } = fixture(t, { prepared, budget: async mode => ({ ...reserve, mode }) });
    const started = startable(t, owner);
    assert.equal(needsWithdrawalFees(owner), true, 'its funding address still pays for it');
    assert.equal(await refreshWithdrawalFees(owner), true);
    const page = owner.renderWithdrawal();
    assert.match(page, /ETH for network fees/);
    assert.doesNotMatch(page, /name="zkapi-sponsored-fee"|data-zkapi-address-withdrawal-unavailable/);
    assert.equal(owner.sponsoredPlanFor('mutual'), null);
    owner.requestWithdrawal();
    await until(() => started.withdraw.mock.callCount() > 0);
    assert.equal(started.withdraw.mock.callCount(), 1);
    const [, , options] = started.withdraw.mock.calls[0].arguments;
    assert.deepEqual(options, { destination: payee, expectedWithdrawalOperationId: 'withdraw-7' });
    assert.equal(started.authorizations[0].kind, 'withdrawal');
    assert.equal(started.authorizations[0].feeLimitWei, '900');
    assert.equal('sponsored' in started.authorizations[0], false);
    assert.ok(budgetRead.mock.callCount() >= 2, 'reviewed, then checked again as it starts');
    assert.deepEqual(relay, [], 'the relay is never involved');
});
