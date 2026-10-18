// Paying a withdrawal's network fee out of the withdrawal: the facade's half
// (versioning/sponsoredFees.mjs), the route and profile rules it stands on
// (versioning/sponsored.mjs), the words (components/SponsoredFee.js) and the
// route the build generates for it.
//
// What is pinned:
//   - it is offered only when the loaded protocol has it, the client can
//     quote it, the reviewed profile pins it completely and the page has an
//     origin to route through;
//   - the relay is reached only through the app's own route, which the
//     generated configuration forwards to the pinned URL, before the
//     version's own proxy rewrite;
//   - a quote is normalized: nothing of the SDK's object is passed on, an
//     unavailable one carries plain words and an available one decimal wei;
//   - the options a withdrawal starts with are exactly the ones that were
//     shown, with a bounded headroom for the signer;
//   - the words are the product's: no protocol names.
import assert from 'node:assert/strict';
import test from 'node:test';
import vectors from '../fixtures/zkapi-sponsored-vectors.json' with { type: 'json' };
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import {
    BUNDLER_ROUTE_SEGMENT, bundlerRoutePath, bundlerRouteUrl, pinnedBundlerUrl, profilePinsSponsored, sponsoredProfileProblem
} from '../../chat/zkapi/versioning/sponsored.mjs';
import {
    SPONSORED_REASON_COPY, createSponsoredFees, normalizeQuote, sponsoredReasonText, weiToEthText, weiToUnits
} from '../../chat/zkapi/versioning/sponsoredFees.mjs';
import { SPONSORED_FEE_WORDS, renderSponsoredFee } from '../../chat/zkapi/components/SponsoredFee.js';
import { zkapiProxyRewrites } from '../../scripts/generate-zkapi-vercel-config.mjs';
import { concessionProfile } from './_registryFixtures.mjs';

const V = vectors;
const ORIGIN = 'https://app.example';
const PROXY = '/zkapi-deployment-v2c/';
const ROUTE = `${ORIGIN}${PROXY}${BUNDLER_ROUTE_SEGMENT}`;

const gasless = (overrides = {}) => ({
    entry_point_address: V.entry_point,
    sender_creator_address: `0x${'51'.repeat(20)}`,
    withdrawal_paymaster_address: V.paymaster,
    withdrawal_account_factory_address: V.factory,
    entry_point_runtime_codehash: `0x${'61'.repeat(32)}`,
    sender_creator_runtime_codehash: `0x${'62'.repeat(32)}`,
    withdrawal_paymaster_runtime_codehash: `0x${'63'.repeat(32)}`,
    withdrawal_account_factory_runtime_codehash: `0x${'64'.repeat(32)}`,
    account_creation_code: V.account_creation_code,
    account_creation_code_keccak256: V.account_creation_code_keccak256,
    bundler_url: 'https://bundler.example/rpc',
    policy: { max_sponsored_cost_wei: V.policy.max_sponsored_cost, flat_fee_wei: V.policy.flat_fee_wei },
    fee_ceilings: { max_fee_wei: V.policy.max_fee_ceiling, priority_fee_wei: V.policy.priority_fee_ceiling },
    gas_policy: { call_floor: [1] },
    ...overrides
});

// -- the route and the profile -----------------------------------------------

test('the bundler route sits under the version\'s proxy path and is an absolute URL on the page\'s own origin', () => {
    assert.equal(bundlerRoutePath(PROXY), '/zkapi-deployment-v2c/_bundler');
    assert.equal(bundlerRouteUrl(ORIGIN, PROXY), ROUTE);
    assert.equal(bundlerRouteUrl('http://localhost:8080', PROXY), `http://localhost:8080${PROXY}_bundler`);
    for (const proxy of ['', 'zkapi/', '/zkapi', '/zkapi//x/', '/a/../b/', null, undefined, 7, '/spa ce/']) {
        assert.equal(bundlerRoutePath(proxy), null, String(proxy));
    }
    // A page that is not on https (and not loopback), or whose origin is not a bare origin, has no route.
    for (const origin of ['http://app.example', 'https://user:pw@app.example', 'https://app.example/path', 'https://app.example/?q',
        'ftp://app.example', '', null, undefined, 'app.example']) {
        assert.equal(bundlerRouteUrl(origin, PROXY), null, String(origin));
    }
});

test('a pinned bundler URL is a credential-free HTTPS URL, and the profile is judged as a whole', () => {
    assert.equal(pinnedBundlerUrl(gasless()), 'https://bundler.example/rpc');
    for (const bad of [{ bundler_url: 'http://bundler.example/rpc' }, { bundler_url: 'https://u:p@bundler.example/rpc' },
        { bundler_url: 'https://bundler.example/rpc?key=1' }, { bundler_url: 'https://bundler.example/rpc#x' },
        { bundler_url: 'not a url' }, { bundler_url: null }, { bundler_url: 5 }]) {
        assert.equal(pinnedBundlerUrl(gasless(bad)), null, JSON.stringify(bad));
        assert.match(sponsoredProfileProblem(gasless(bad)), /bundler_url/);
    }
    // Absent, null and placeholders are not problems: they offer nothing.
    for (const value of [undefined, null, gasless({ deployment_status: 'not_deployed' })]) assert.equal(sponsoredProfileProblem(value), null);
    assert.equal(sponsoredProfileProblem(gasless()), null);
    assert.equal(profilePinsSponsored({ gasless: gasless() }), true);
    assert.equal(profilePinsSponsored({ gasless: null }), false);
    assert.equal(profilePinsSponsored({ deployment_status: 'not_deployed', gasless: gasless() }), false);
    assert.equal(profilePinsSponsored({ gasless: gasless({ deployment_status: 'not_deployed' }) }), false);
    // Incomplete pins are a mistake of the review, found at build time.
    for (const [change, pattern] of [
        [{ entry_point_address: '0x12' }, /entry_point_address/],
        [{ withdrawal_paymaster_address: null }, /withdrawal_paymaster_address/],
        [{ withdrawal_paymaster_runtime_codehash: '0x12' }, /withdrawal_paymaster_runtime_codehash/],
        [{ account_creation_code: '0xzz' }, /account_creation_code/],
        [{ account_creation_code_keccak256: null }, /account_creation_code_keccak256/],
        [{ policy: null }, /policy/],
        [{ policy: { max_sponsored_cost_wei: 'many', flat_fee_wei: '1' } }, /policy/],
        [{ fee_ceilings: { max_fee_wei: '1' } }, /fee_ceilings/],
        [{ gas_policy: null }, /gas_policy/],
        [{ deployment_status: 'pending' }, /deployment_status/]
    ]) {
        assert.match(sponsoredProfileProblem(gasless(change)) || '', pattern, JSON.stringify(change));
    }
    assert.match(sponsoredProfileProblem([]), /object or null/);
    assert.match(sponsoredProfileProblem('x'), /object or null/);
});

test('the concession adapter refuses a profile that pins sponsored withdrawals badly and takes one that pins them or none', () => {
    const adapter = getAdapter('concession-v1');
    const base = concessionProfile('sepolia', { slot: 2 });
    const withGasless = value => {
        const copy = structuredClone(base);
        copy.trusted_deployment.gasless = value;
        return copy;
    };
    const ctx = { network: 'sepolia', proxyPath: PROXY, strict: false };
    assert.doesNotThrow(() => adapter.validateProfile(base, ctx));
    assert.doesNotThrow(() => adapter.validateProfile(withGasless(null), ctx));
    assert.doesNotThrow(() => adapter.validateProfile(withGasless(gasless()), ctx));
    assert.throws(() => adapter.validateProfile(withGasless(gasless({ bundler_url: 'http://bundler.example' })), ctx), /bundler_url/);
    assert.throws(() => adapter.validateProfile(withGasless({ entry_point_address: V.entry_point }), ctx), /gasless/);
    // The legacy family has none and never reads the field.
    assert.equal(getAdapter('note-bound-v1').callProfile.sponsored, undefined);
    assert.ok(adapter.callProfile.sponsored);
});

test('the generated routes carry the bundler route first, to the pinned URL, and nothing for a version without one', () => {
    const live = (proxyPath, protocol, trusted) => ({
        proxyPath, config: { trusted_deployment: { protocol_server_url: protocol, ...trusted } }
    });
    const plan = { versions: [
        live('/zkapi-deployment/', 'https://v1.example', {}),
        live('/zkapi-deployment-v2c/', 'https://v2.example', { gasless: gasless() })
    ] };
    assert.deepEqual(zkapiProxyRewrites(plan), [
        { source: '/zkapi-deployment/:path*', destination: 'https://v1.example/:path*' },
        { source: '/zkapi-deployment-v2c/_bundler', destination: 'https://bundler.example/rpc' },
        { source: '/zkapi-deployment-v2c/:path*', destination: 'https://v2.example/:path*' }
    ]);
    // The exact route comes before the version's catch-all, which would
    // otherwise send it to the operator's service.
    const rewrites = zkapiProxyRewrites(plan);
    assert.ok(rewrites.findIndex(entry => entry.source.endsWith('_bundler')) < rewrites.findIndex(entry => entry.source === '/zkapi-deployment-v2c/:path*'));
    // No route for a pin the host cannot route to, or for a placeholder.
    for (const trusted of [{ gasless: null }, { gasless: gasless({ bundler_url: 'http://x.example' }) }, {}]) {
        const single = { versions: [live('/zkapi-deployment-v2c/', 'https://v2.example', trusted)] };
        assert.deepEqual(zkapiProxyRewrites(single), [{ source: '/zkapi-deployment-v2c/:path*', destination: 'https://v2.example/:path*' }]);
    }
});

// -- quotes ----------------------------------------------------------------------

test('wei is shown as ETH with at most six decimals, never rounded to nothing, and as ledger units rounded down', () => {
    assert.equal(weiToEthText('1500000000000000'), '0.0015');
    assert.equal(weiToEthText('1000000000000000000'), '1');
    assert.equal(weiToEthText('1234567890123456789'), '1.234567');
    assert.equal(weiToEthText('0'), '0');
    assert.equal(weiToEthText('1'), '< 0.000001');
    assert.equal(weiToEthText(10n ** 18n), '1');
    assert.equal(weiToEthText('abc'), '');
    assert.equal(weiToEthText(-1), '');
    assert.equal(weiToUnits('1999999999'), '1');
    assert.equal(weiToUnits('999999999'), '0');
    assert.equal(weiToUnits('x'), null);
});

test('an available quote keeps only amounts; an unavailable one keeps a code and plain words', () => {
    const raw = {
        available: true, mode: 'mutual', owner: V.owner, payout: V.payee, transitAccount: V.transit_account, bundlerUrl: 'https://bundler.example/rpc',
        maxCost: '32750000000000000', flatFeeWei: '10000000000000', minimumReceivedWei: '1467250000000000', estimatedReceivedWei: null,
        payoutWei: '1500000000000000', owedWei: '0', payoutHasCode: true, transitExists: true, secret: 'SECRET', amounts: { x: 1 }
    };
    const quote = normalizeQuote(raw, { mode: 'mutual' });
    assert.deepEqual(quote, {
        available: true, mode: 'mutual', payoutWei: '1500000000000000', minimumReceivedWei: '1467250000000000', estimatedReceivedWei: null,
        maxCostWei: '32750000000000000', flatFeeWei: '10000000000000', creditSurchargeWei: '0', owedWei: '0', payoutHasCode: true, transitExists: true
    });
    assert.doesNotMatch(JSON.stringify(quote), /SECRET|bundler\.example|0x/);
    // An exit is an estimate, not a floor.
    assert.equal(normalizeQuote({ ...raw, mode: 'escape', minimumReceivedWei: null, estimatedReceivedWei: '1400000000000000' },
        { mode: 'escape' }).estimatedReceivedWei, '1400000000000000');
    for (const broken of [null, undefined, 'yes', [], { available: true }, { available: true, maxCost: 'x', flatFeeWei: '1' },
        { available: true, maxCost: '1', flatFeeWei: -1 }]) {
        const result = normalizeQuote(broken);
        assert.equal(result.available, false, JSON.stringify(broken));
        assert.ok(result.text.length > 10);
    }
    const refused = normalizeQuote({ available: false, reason: 'paymaster_underfunded', message: 'SDK words with 0xabc' });
    assert.deepEqual(refused, { available: false, reason: 'paymaster_underfunded', text: sponsoredReasonText('paymaster_underfunded') });
    // `gasless_unavailable` carries its cause: that is what is told.
    const unavailable = normalizeQuote({ available: false, reason: 'gasless_unavailable', data: { reason: 'not_pinned' } });
    assert.equal(unavailable.reason, 'not_pinned');
    // A code that is not a code is "unknown", never echoed.
    assert.equal(normalizeQuote({ available: false, reason: '<script>' }).reason, 'unknown');
});

test('every refusal of the SDK has a line in the product\'s words, ending where the person can go on', () => {
    // The pre-flight's refusals and the pins' (the SDK README's table).
    const codes = ['gasless_unavailable', 'gasless_policy_mismatch', 'bundler_unavailable', 'bundler_wrong_chain',
        'bundler_unsupported_entry_point', 'bundler_url_invalid', 'sponsorship_paused', 'escapes_disabled', 'escape_already_sponsored',
        'paymaster_underfunded', 'exits_paused', 'gas_above_paymaster_ceiling', 'max_cost_above_policy', 'payout_below_gas',
        'gasless_uneconomic', 'gasless_attempts_exhausted', 'gasless_fee_above_cap', 'gasless_estimate_above_cap',
        'gas_limit_out_of_range', 'gasless_plan_mismatch', 'gasless_record_not_pinned', 'wrong_owner_account',
        'entry_point_hash_mismatch', 'not_pinned', 'gasless_profile_invalid', 'gasless_deployment_mismatch',
        // What can stop a sponsored withdrawal once it has started.
        'gasless_op_expired', 'gasless_op_pending', 'user_op_pending', 'withdrawal_wallet_pending', 'escape_not_due',
        'gasless_fee_bump_exhausted', 'gasless_op_reverted', 'signature_rejected', 'bundler_hash_mismatch', 'bundler_rejected',
        'paymaster_time_window', 'transit_funds_waiting', 'transit_sweep_needed', 'transit_not_stranded', 'transit_balance_empty'];
    const FORBIDDEN = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|note\s*#|#\s*\d|unlinkable|untraceable|anonymous|zero.knowledge|proof\b|escape hatch|mutual close|paymaster|bundler|userop|user operation|4337|entry ?point|transit|nothing is lost|\bsafe(ly)?\b/i;
    for (const code of codes) {
        assert.ok(Object.hasOwn(SPONSORED_REASON_COPY, code), `${code} has a line`);
        const text = sponsoredReasonText(code);
        assert.doesNotMatch(text, FORBIDDEN, `${code}: ${text}`);
        assert.doesNotMatch(text, /'/, `${code}: straight apostrophe`);
        assert.doesNotMatch(text, /!/, `${code}: exclamation`);
        assert.match(text, /\.$/, code);
        assert.match(text, /^[A-Z]/, code);
    }
    // The ones a wallet can cure say so; the ones it cannot do not.
    assert.match(sponsoredReasonText('paymaster_underfunded'), /pay the network fee from your wallet instead\.$/);
    assert.doesNotMatch(sponsoredReasonText('wrong_owner_account'), /wallet instead/);
    assert.doesNotMatch(sponsoredReasonText('gasless_plan_mismatch'), /wallet instead/);
    // A code nobody listed still gets words.
    assert.equal(sponsoredReasonText('something_new'), sponsoredReasonText('unknown'));
    assert.equal(sponsoredReasonText(undefined), sponsoredReasonText('unknown'));
});

// -- the facade's half -----------------------------------------------------------

function facadeFor({ sponsored = true, client = { gaslessWithdrawalQuote: async () => ({}) }, trusted = { gasless: gasless() },
    origin = ORIGIN, proxyPath = PROXY, quoteResult = null } = {}) {
    const calls = [];
    const clientObject = client === null ? null : { ...client };
    if (clientObject?.gaslessWithdrawalQuote) {
        const original = clientObject.gaslessWithdrawalQuote;
        clientObject.gaslessWithdrawalQuote = async (...args) => {
            calls.push(args);
            return quoteResult ?? original(...args);
        };
    }
    const fees = createSponsoredFees({
        getClient: () => clientObject,
        getRuntime: () => ({ browserConfig: { trusted_deployment: trusted } }),
        getContext: () => ({ adapter: getAdapter(sponsored ? 'concession-v1' : 'note-bound-v1'), version: { id: 'v2', proxyPath } }),
        getOrigin: () => origin
    });
    return { fees, calls, client: clientObject };
}

test('it is offered only with a protocol that has it, a client that can quote, a complete profile and a route', () => {
    assert.equal(facadeFor().fees.supported(), true);
    assert.equal(facadeFor().fees.bundlerUrl(), ROUTE);
    assert.equal(facadeFor({ sponsored: false }).fees.supported(), false);
    assert.equal(facadeFor({ client: {} }).fees.supported(), false);
    assert.equal(facadeFor({ client: null }).fees.supported(), false);
    assert.equal(facadeFor({ trusted: { gasless: null } }).fees.supported(), false);
    assert.equal(facadeFor({ trusted: { gasless: gasless({ bundler_url: 'http://insecure' }) } }).fees.supported(), false);
    assert.equal(facadeFor({ origin: null }).fees.supported(), false);
    assert.equal(facadeFor({ proxyPath: null }).fees.supported(), false);
    // Not supported means no route either: nothing is routed for a page that does not offer it.
    assert.equal(facadeFor({ sponsored: false }).fees.bundlerUrl(), null);
    // Nothing throws, whatever the context says.
    const broken = createSponsoredFees({ getClient: () => { throw new Error('x'); }, getRuntime: () => { throw new Error('x'); },
        getContext: () => { throw new Error('x'); } });
    assert.equal(broken.supported(), false);
    assert.equal(broken.bundlerUrl(), null);
    assert.equal(createSponsoredFees().supported(), false);
});

test('a quote asks the client with the app\'s own route and the owner, and never rejects', async () => {
    const quoted = { available: true, maxCost: '10', flatFeeWei: '1', minimumReceivedWei: '5', payoutWei: '20' };
    const f = facadeFor({ quoteResult: quoted });
    const quote = await f.fees.quote({ mode: 'mutual', destination: V.payee, owner: V.owner });
    assert.equal(quote.available, true);
    assert.deepEqual(f.calls, [['mutual', { destination: V.payee, owner: V.owner, bundlerUrl: ROUTE }]]);
    // With no owner the destination stands in (the transit account's cost
    // is then an upper bound); with neither, the client is asked with none.
    const standIn = facadeFor({ quoteResult: quoted });
    await standIn.fees.quote({ mode: 'escape', destination: V.payee });
    assert.equal(standIn.calls[0][0], 'escape');
    assert.equal(standIn.calls[0][1].owner, V.payee);
    // A mode that is not one is a close.
    const odd = facadeFor({ quoteResult: quoted });
    await odd.fees.quote({ mode: 'drain', destination: 'not an address' });
    assert.equal(odd.calls[0][0], 'mutual');
    assert.equal(odd.calls[0][1].destination, null);
    // A client that throws is an unavailable quote with words, not an error.
    const failing = facadeFor({ client: { gaslessWithdrawalQuote: async () => { throw Object.assign(new Error('0xdeadbeef'), { code: 'bundler_unavailable' }); } } });
    const refused = await failing.fees.quote({ destination: V.payee });
    assert.equal(refused.available, false);
    assert.equal(refused.reason, 'bundler_unavailable');
    assert.doesNotMatch(refused.text, /0xdeadbeef/);
    // A page that does not offer it quotes nothing.
    const none = facadeFor({ sponsored: false });
    assert.equal((await none.fees.quote({ destination: V.payee })).available, false);
    assert.deepEqual(none.calls, []);
});

test('a quote for the Send Ethereum method is read with that wallet installed, after a busy one finishes', async () => {
    const events = [];
    let busy = 2;
    const client = {
        setWalletProvider(provider) {
            if (busy > 0) { busy -= 1; throw Object.assign(new Error('busy'), { code: 'wallet_provider_busy' }); }
            events.push(['set', provider.name]);
        },
        async gaslessWithdrawalQuote() { events.push(['quote']); return { available: true, maxCost: '10', flatFeeWei: '1', payoutWei: '2' }; }
    };
    const f = facadeFor({ client });
    const provider = { name: 'address-wallet' };
    const quote = await f.fees.quote({ destination: V.payee, owner: V.owner, provider });
    assert.equal(quote.available, true);
    // Activated, then asked in the same turn.
    assert.deepEqual(events, [['set', 'address-wallet'], ['quote']]);
    // Any other failure to install it is the quote's failure.
    const wrong = facadeFor({ client: { setWalletProvider() { throw new TypeError('not a wallet'); }, gaslessWithdrawalQuote: async () => ({}) } });
    const refused = await wrong.fees.quote({ destination: V.payee, owner: V.owner, provider });
    assert.equal(refused.available, false);
});

test('the options and signer cap exactly match the fee shown, with no hidden headroom', () => {
    const f = facadeFor();
    const quote = normalizeQuote({ available: true, mode: 'mutual', maxCost: '1000', flatFeeWei: '77', minimumReceivedWei: '5', payoutWei: '2000' });
    const plan = f.fees.plan(quote);
    assert.deepEqual(plan.options, { fees: 'payout', bundlerUrl: ROUTE, feeCapWei: '77', maxCostWei: '1000', maxTotalFeeWei: '1077', allowExpensiveGas: false });
    assert.deepEqual(plan.sponsored, { feeCapWei: '77', maxCostWei: '1000' });
    // Never "expensive gas allowed": that is a decision of its own.
    assert.equal(plan.options.allowExpensiveGas, false);
    for (const unavailable of [null, undefined, { available: false }, 'x', { available: true, maxCostWei: '1' }]) {
        if (unavailable && unavailable.available === true) continue;
        assert.equal(f.fees.plan(unavailable), null);
    }
    // And never for a page that does not offer it.
    assert.equal(facadeFor({ sponsored: false }).fees.plan(quote), null);
});

// -- the words -----------------------------------------------------------------

const FORBIDDEN_WORDS = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|note\s*#|#\s*\d|unlinkable|untraceable|anonymous|zero.knowledge|proof\b|escape hatch|mutual close|paymaster|bundler|user operation|4337|entry ?point|transit|nothing is lost/i;
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, ' ').replace(/\s+/g, ' ').trim();

test('the fee choice says its words plainly, for every state, with and without prices', () => {
    for (const [key, template] of Object.entries(SPONSORED_FEE_WORDS)) {
        assert.doesNotMatch(template, FORBIDDEN_WORDS, key);
        assert.doesNotMatch(template, /!/, key);
        assert.doesNotMatch(template, /'/, `${key}: straight apostrophe`);
        assert.doesNotMatch(template, /[<>&"]/, `${key}: markup`);
    }
    const ready = normalizeQuote({ available: true, mode: 'mutual', maxCost: '32750000000000000', flatFeeWei: '10000000000000',
        minimumReceivedWei: '1467250000000000', payoutWei: '1500000000000000', payoutHasCode: true });
    const escape = normalizeQuote({ available: true, mode: 'escape', maxCost: '32750000000000000', flatFeeWei: '0',
        minimumReceivedWei: null, estimatedReceivedWei: '1400000000000000', payoutWei: '1500000000000000' }, { mode: 'escape' });
    const states = [
        { choice: 'wallet', status: 'idle' },
        { choice: 'payout', status: 'loading' },
        { choice: 'payout', status: 'ready', quote: ready },
        { choice: 'payout', status: 'ready', quote: escape },
        { choice: 'payout', status: 'unavailable', quote: normalizeQuote({ available: false, reason: 'payout_below_gas' }) },
        { choice: 'payout', status: 'ready', quote: ready, busy: true },
        { choice: 'wallet', status: 'idle', method: 'address' }
    ];
    for (const format of [units => `$${Number(units) / 1e9 * 3000}`, () => '', () => '—']) {
        for (const state of states) {
            const html = renderSponsoredFee({ ...state, format });
            assert.match(html, /<fieldset[^>]*data-zkapi-sponsored-fieldset/);
            assert.doesNotMatch(text(html), FORBIDDEN_WORDS, text(html));
            assert.doesNotMatch(text(html), /\bundefined\b|\bnull\b|NaN|\[object/, text(html));
            assert.equal((html.match(/name="zkapi-sponsored-fee"/g) || []).length, 2);
        }
    }
    // The figures: a floor for a close, an estimate for an exit, the fee, and the relay's disclosure.
    const closeText = text(renderSponsoredFee({ choice: 'payout', status: 'ready', quote: ready, format: () => '$4.40' }));
    assert.match(closeText, /You’ll receive at least \$4\.40 \(0\.001467 ETH\)\./);
    assert.match(closeText, /network fee is at most/);
    assert.match(closeText, /the service’s fee of/);
    assert.match(closeText, /goes through this app to the service’s relay/);
    assert.match(closeText, /receiving address is a contract/);
    const exitText = text(renderSponsoredFee({ choice: 'payout', status: 'ready', quote: escape, format: () => '' }));
    assert.match(exitText, /about 0\.0014 ETH/);
    assert.doesNotMatch(exitText, /at least/);
    // The choice is disabled while work runs, and a refused quote cannot be re-chosen.
    assert.match(renderSponsoredFee({ choice: 'wallet', status: 'idle', busy: true }), /<fieldset[^>]* disabled>/);
    assert.match(renderSponsoredFee({ choice: 'payout', status: 'unavailable', quote: states[4].quote }),
        /value="payout"\s+checked\s+disabled/);
    // Nothing from a quote reaches the markup unescaped.
    const hostile = { available: false, reason: 'unknown', text: '<img src=x onerror=alert(1)>' };
    assert.doesNotMatch(renderSponsoredFee({ choice: 'payout', status: 'unavailable', quote: hostile }), /<img/);
});
