import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import codec from '@openanonymity/zkapi-browser-sdk/wallet';
import {
    getActiveAdapter,
    installActiveVersion,
    resetActiveVersionForTests
} from '../../chat/zkapi/versioning/activeVersion.mjs';
import { ADAPTER_IDS, getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import concessionV1, {
    ACCEPTED_SETUP_IDS,
    CEREMONY_SETUP_ID,
    DEVELOPMENT_SETUP_ID,
    proofSetupKind
} from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import noteBoundV1, {
    SERVICE_MESSAGE_LIMIT,
    emptyNormalizedSnapshot,
    normalizeCommonSnapshot
} from '../../chat/zkapi/versioning/adapters/noteBoundV1.mjs';
import {
    activatedRegistry,
    concessionClientSnapshot,
    concessionProfile,
    legacyClientSnapshot,
    noteBoundProfile,
    resolvedTable
} from './_registryFixtures.mjs';

const DAY = 86_400;
const NOW_SECONDS = Math.floor(Date.UTC(2026, 10, 15, 12) / 1000);
const NOW_MS = NOW_SECONDS * 1000;
const LEGACY_DEPLOYMENT = 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930';
const NEW_DEPLOYMENT = 'zkapi-native-eth-mainnet-concession-v1-fixture-v2c';
const VAULT = '0x4386FDbdA35D995beB3BF8625118Ec5982ec81fe';
const DESTINATION = '0x3434343434343434343434343434343434343434';

const normalized = (adapter, snapshot) => adapter.normalizeSnapshot(snapshot, { nowMs: NOW_MS });
const withFields = overrides => ({ ...emptyNormalizedSnapshot(), ...overrides });
// What the concession family reports when it has nothing to report: the base
// shape plus the fields only its SDK generation knows. The legacy family and
// emptyNormalizedSnapshot() carry none of them (consumers read absent keys as
// empty).
const CONCESSION_EXTRAS = Object.freeze({
    ownCredits: [], payoutAlerts: [], deviceNotNewestRecords: [], setAsideNear: [], unresolvedRequests: 0
});
const concessionFields = overrides => ({ ...withFields({}), ...structuredClone(CONCESSION_EXTRAS), ...overrides });
// A set-aside deadline entry as the concession family annotates it.
const asideDeadline = (expiryTs, recordId = null, deviceFlagged = false) => ({
    source: 'set-aside', expiryTs, recordId, deviceFlagged
});

// ---------------------------------------------------------------------------
// The adapter interface
// ---------------------------------------------------------------------------

test('adapters expose the documented interface and are immutable', () => {
    assert.deepEqual([...ADAPTER_IDS], ['note-bound-v1', 'concession-v1', 'concession-v2']);
    for (const adapter of ADAPTER_IDS.map(getAdapter)) {
        assert.equal(getAdapter(adapter.id), adapter);
        for (const method of ['validateProfile', 'fundingFromProfile', 'normalizeSnapshot', 'closeBy']) {
            assert.equal(typeof adapter[method], 'function', `${adapter.id}.${method}`);
        }
        assert.equal(typeof adapter.id, 'string');
        assert.equal(typeof adapter.circuitId, 'string');
        assert.ok(Number.isInteger(adapter.vaultRevision));
        assert.ok(Array.isArray(adapter.sweepablePhases));
        assert.ok(Array.isArray(adapter.requiredWiring));
        assert.ok(adapter.chatCutoffSeconds === null || Number.isInteger(adapter.chatCutoffSeconds));
        for (const key of ['depositEntryPoints', 'recoveryEntryPoints']) {
            assert.deepEqual(Object.keys(adapter[key]).sort(), ['client', 'runtime']);
            for (const side of ['client', 'runtime']) {
                assert.ok(adapter[key][side].every(name => typeof name === 'string' && name));
                assert.equal(new Set(adapter[key][side]).size, adapter[key][side].length);
            }
        }
        assert.ok(Object.isFrozen(adapter));
        assert.ok(Object.isFrozen(adapter.callProfile));
        assert.ok(Object.isFrozen(adapter.callProfile.exits[0]));
        assert.ok(Object.isFrozen(adapter.depositEntryPoints.client));
        assert.throws(() => { adapter.callProfile.deposit.selector = 'deadbeef'; }, TypeError);
        // beforeWithdraw is a seam: absent until a family needs it.
        assert.equal(adapter.beforeWithdraw, undefined);
    }
    // watchFacts narrows what the holdings watcher fingerprints. Only the
    // family whose reading carries per-chat facts has one; the other is read
    // whole, exactly as before.
    assert.equal(typeof concessionV1.watchFacts, 'function');
    assert.equal(noteBoundV1.watchFacts, undefined);
    assert.equal(noteBoundV1.circuitId, 'zkapi-v2-note-bound-v1');
    assert.equal(noteBoundV1.vaultRevision, 1);
    assert.equal(concessionV1.circuitId, 'zkapi-v2-concession-v1');
    assert.equal(concessionV1.vaultRevision, 3);
    assert.equal(noteBoundV1.chatCutoffSeconds, 23_700);
    assert.equal(concessionV1.chatCutoffSeconds, null);
    assert.deepEqual(noteBoundV1.requiredWiring, []);
    assert.ok(concessionV1.requiredWiring.length >= 8);
    assert.ok(concessionV1.requiredWiring.every(name => /^[a-z][a-z0-9-]*$/.test(name)));
    assert.equal(new Set(concessionV1.requiredWiring).size, concessionV1.requiredWiring.length);
    for (const name of ['service-message', 'credited-payouts', 'exit-kit', 'ownership-proof-wait', 'near-expiry',
        'withdrawal-operation-recheck', 'other-deployment-withdrawals', 'other-deployment-credits']) {
        assert.ok(concessionV1.requiredWiring.includes(name), name);
    }
});

// ---------------------------------------------------------------------------
// Amount and give-up data
// ---------------------------------------------------------------------------

// The adapters carry the facts the host formats and bounds amounts with. They
// are checked against both SDK generations so a changed unit or chat tier
// fails here and not in front of a person.
test('adapter billing and abandon data match both SDK generations and the profile', async () => {
    const { CHAT_SPENDING_TIER_USD } = await import('@openanonymity/zkapi-browser-sdk/request-compat');
    const vectors = JSON.parse(fs.readFileSync(
        new URL('../fixtures/zkapi-v2-real-shapes/oracle-vectors.json', import.meta.url), 'utf8'));
    const require = createRequire(import.meta.url);
    const directory = path.dirname(require.resolve('@openanonymity/zkapi-browser-sdk/package.json'));
    const legacyNative = fs.readFileSync(path.join(directory, 'sdk/services/zkapiNativeEth.mjs'), 'utf8');
    assert.match(legacyNative, /NATIVE_UNITS_PER_ETH = 1_000_000_000n;/);
    assert.equal(vectors.nativeUnitsPerEth, '1000000000');
    assert.deepEqual(vectors.chatSpendingTierUsd, [...CHAT_SPENDING_TIER_USD]);

    for (const adapter of ADAPTER_IDS.map(getAdapter)) {
        assert.deepEqual(adapter.billing, { asset: 'native_eth', unit: 'gwei', perEth: 1e9 }, adapter.id);
        assert.ok(Object.isFrozen(adapter.billing));
        // Ledger units per ETH is the profile's pin read the other way round.
        const funding = adapter.fundingFromProfile(concessionProfile('mainnet'));
        assert.equal(10n ** 18n / BigInt(funding.native_asset_wei_per_unit), BigInt(adapter.billing.perEth));
        assert.equal(funding.billing_asset, adapter.billing.asset);
        assert.equal(funding.billing_unit, adapter.billing.unit);

        // The default dust threshold and the bound of a registry override is
        // exactly the smallest chat key the SDKs issue, in millionths of a dollar.
        assert.deepEqual(Object.keys(adapter.abandon).sort(), ['dustCeilingUnits', 'smallestChatTierUsdMicros', 'supported']);
        assert.ok(Object.isFrozen(adapter.abandon));
        assert.equal(adapter.abandon.smallestChatTierUsdMicros, CHAT_SPENDING_TIER_USD[0] * 1_000_000);
        assert.equal(adapter.abandon.smallestChatTierUsdMicros, vectors.chatSpendingTierUsd[0] * 1_000_000);
        // 0.005 ETH in gwei: a bound that does not depend on a price quote.
        assert.equal(adapter.abandon.dustCeilingUnits, 5_000_000);
        assert.equal(adapter.abandon.dustCeilingUnits, adapter.billing.perEth / 200);
    }
    // Only the family whose archive was reviewed for it offers the action.
    assert.equal(noteBoundV1.abandon.supported, true);
    assert.equal(concessionV1.abandon.supported, false);
});

// ---------------------------------------------------------------------------
// Profile validation: note-bound-v1 behaves exactly as validateZkapiDeploymentPins did
// ---------------------------------------------------------------------------

// Verbatim copy of scripts/zkapiBuild.mjs validateZkapiDeploymentPins as it was
// before the registry moved its checks into the adapter. It is the oracle for
// "identical accept/reject behavior and error messages".
function legacyPublicOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('[build] Deployment pins must use credential-free HTTPS origins.');
    }
    return url.origin;
}

function legacyValidateZkapiDeploymentPins(config, { network, circuitId, files }) {
    const pins = config?.trusted_deployment;
    if (!['mainnet', 'sepolia'].includes(network)
        || pins?.chain_id !== (network === 'mainnet' ? 1 : 11155111)) {
        throw new Error('[build] Deployment pins do not match the selected network.');
    }
    if (circuitId !== 'zkapi-v2-note-bound-v1' || pins.circuit_id !== circuitId) {
        throw new Error('[build] Deployment pins do not match the SDK proof circuit.');
    }
    for (const kind of ['request', 'withdrawal']) {
        const expected = pins[`${kind}_proving_key_sha256`];
        if (!/^[a-f0-9]{64}$/.test(expected || '') || expected !== files?.[`proofs/${kind}.pk`]) {
            throw new Error(`[build] ${kind} proving key does not match the selected deployment pins.`);
        }
    }
    const origin = legacyPublicOrigin(pins.protocol_server_url);
    if (legacyPublicOrigin(pins.indexer_url) !== origin
        || config.deployment_manifest_url !== `${origin}/config.json`
        || JSON.stringify(config.allowed_deployment_manifest_urls) !== JSON.stringify([config.deployment_manifest_url])
        || config.deployment_api_proxy_path !== '/zkapi-deployment/'
        || config.proving_keys_base_url !== './proofs/') {
        throw new Error('[build] Deployment manifest, proxy and proof routes must match the reviewed pins.');
    }
    if (typeof pins.deployment_id !== 'string' || !pins.deployment_id
        || !/^0x[0-9a-fA-F]{40}$/.test(pins.contract_address || '')
        || pins.billing_asset !== 'native_eth' || pins.billing_unit !== 'gwei'
        || pins.billing_token_address !== null || pins.native_asset_wei_per_unit !== '1000000000'
        || config.billing_token_symbol !== 'ETH' || config.billing_token_decimals !== 9
        || config.credits_per_usd !== null || config.require_oa_key_source !== true) {
        throw new Error('[build] Fresh deployment pins must identify a native ETH vault and verified OA keys.');
    }
    return config;
}

function outcome(fn) {
    try {
        fn();
        return { accepted: true };
    } catch (error) {
        return { accepted: false, name: error?.name, message: error?.message };
    }
}

test('note-bound-v1 validateProfile accepts and rejects exactly what validateZkapiDeploymentPins did', () => {
    const mutations = [
        config => { config.trusted_deployment.chain_id = 11155111; },
        config => { config.trusted_deployment.chain_id = 1; },
        config => { config.trusted_deployment.chain_id = '1'; },
        config => { config.trusted_deployment.circuit_id = 'legacy'; },
        config => { config.trusted_deployment.circuit_id = 'zkapi-v2-concession-v1'; },
        config => { config.trusted_deployment.request_proving_key_sha256 = 'a'.repeat(64); },
        config => { config.trusted_deployment.withdrawal_proving_key_sha256 = 'b'.repeat(64); },
        config => { config.trusted_deployment.request_proving_key_sha256 = 'A'.repeat(64); },
        config => { delete config.trusted_deployment.request_proving_key_sha256; },
        config => { config.deployment_manifest_url = 'https://untrusted.test/config.json'; },
        config => { config.allowed_deployment_manifest_urls.push('https://untrusted.test/config.json'); },
        config => { config.allowed_deployment_manifest_urls = []; },
        config => { config.trusted_deployment.protocol_server_url = 'https://user:password@example.test'; },
        config => { config.trusted_deployment.protocol_server_url = 'http://zkapi-mainnet.openanonymity.ai'; },
        // A path prefix is the one deliberate extension of the former rule
        // (serviceBase.mjs); its own test follows this one.
        config => { config.trusted_deployment.protocol_server_url = 'not a url'; },
        config => { delete config.trusted_deployment.protocol_server_url; },
        config => { config.trusted_deployment.indexer_url = 'https://other.example.test'; },
        config => { delete config.trusted_deployment.indexer_url; },
        config => { config.deployment_api_proxy_path = '/other/'; },
        config => { config.deployment_api_proxy_path = '/zkapi-deployment-v2c/'; },
        config => { config.proving_keys_base_url = 'https://untrusted.test/proofs/'; },
        config => { config.trusted_deployment.billing_asset = 'erc20'; },
        config => { config.trusted_deployment.billing_unit = 'wei'; },
        config => { config.trusted_deployment.billing_token_address = '0x' + '11'.repeat(20); },
        config => { config.trusted_deployment.native_asset_wei_per_unit = '1'; },
        config => { config.trusted_deployment.contract_address = '0x1234'; },
        config => { config.trusted_deployment.contract_address = null; },
        config => { config.trusted_deployment.deployment_id = ''; },
        config => { config.trusted_deployment.deployment_id = 7; },
        config => { config.billing_token_symbol = 'USDC'; },
        config => { config.billing_token_decimals = 6; },
        config => { config.credits_per_usd = 1_000_000; },
        config => { config.require_oa_key_source = false; },
        config => { delete config.require_oa_key_source; },
        // Extra keys are ignored, as before.
        config => { config.trusted_deployment.extra = true; },
        config => { config.trusted_deployment.rpc_url = 'http://localhost:8545'; },
        config => { config.trusted_deployment.openrouter_inference_base = 'https://example.test/v1'; },
        config => { config.trusted_deployment.deposits = 'closed'; },
        config => { config.trusted_deployment = null; },
        config => { delete config.trusted_deployment; }
    ];
    for (const network of ['mainnet', 'sepolia']) {
        const pristine = noteBoundProfile(network);
        const files = {
            'proofs/request.pk': pristine.trusted_deployment.request_proving_key_sha256,
            'proofs/withdrawal.pk': pristine.trusted_deployment.withdrawal_proving_key_sha256
        };
        const circuitId = 'zkapi-v2-note-bound-v1';
        const contexts = [
            { network, circuitId, files },
            { network, circuitId, files: {} },
            { network, circuitId: 'legacy', files },
            { network, circuitId: undefined, files },
            { network: network === 'mainnet' ? 'sepolia' : 'mainnet', circuitId, files },
            { network: 'goerli', circuitId, files }
        ];
        for (const context of contexts) {
            const subjects = [pristine, ...mutations.map(mutate => noteBoundProfile(network, mutate))];
            for (const config of subjects) {
                const expected = outcome(() => legacyValidateZkapiDeploymentPins(config, context));
                const actual = outcome(() => noteBoundV1.validateProfile(config, context));
                assert.deepEqual(actual, expected, JSON.stringify(context.network + String(context.circuitId)));
            }
        }
        assert.equal(noteBoundV1.validateProfile(pristine, { network, circuitId, files }), pristine);
    }
    // A missing config fails with the same message as before.
    assert.deepEqual(outcome(() => noteBoundV1.validateProfile(undefined, { network: 'mainnet', circuitId: 'zkapi-v2-note-bound-v1', files: {} })),
        outcome(() => legacyValidateZkapiDeploymentPins(undefined, { network: 'mainnet', circuitId: 'zkapi-v2-note-bound-v1', files: {} })));
});

test('a service URL may carry a plain path prefix; every other part of the old rule stands', () => {
    const prefixed = (prefix, mutate = null) => noteBoundProfile('mainnet', config => {
        const base = `${config.trusted_deployment.protocol_server_url}${prefix}`;
        config.trusted_deployment.protocol_server_url = base;
        config.trusted_deployment.indexer_url = base;
        config.deployment_manifest_url = `${base}/config.json`;
        config.allowed_deployment_manifest_urls = [`${base}/config.json`];
        if (mutate) mutate(config);
    });
    // The prefix is data of the deployment, for both families.
    noteBoundV1.validateProfile(prefixed('/c'), { network: 'mainnet' });
    noteBoundV1.validateProfile(prefixed('/zkapi/c'), { network: 'mainnet', strict: true });
    const concession = concessionProfile('mainnet', { slot: 2, mutate: config => {
        const base = `${config.trusted_deployment.protocol_server_url}/c`;
        config.trusted_deployment.protocol_server_url = base;
        config.trusted_deployment.indexer_url = base;
        config.deployment_manifest_url = `${base}/config.json`;
        config.allowed_deployment_manifest_urls = [`${base}/config.json`];
    } });
    concessionV1.validateProfile(concession, { network: 'mainnet', strict: true });
    // The indexer and the manifest are at the same base, exactly.
    assert.throws(() => noteBoundV1.validateProfile(prefixed('/c', config => {
        config.trusted_deployment.indexer_url = 'https://zkapi-mainnet.openanonymity.ai';
    }), { network: 'mainnet' }), /routes must match/);
    assert.throws(() => noteBoundV1.validateProfile(prefixed('/c', config => {
        config.deployment_manifest_url = 'https://zkapi-mainnet.openanonymity.ai/config.json';
        config.allowed_deployment_manifest_urls = [config.deployment_manifest_url];
    }), { network: 'mainnet' }), /routes must match/);
    // The shape rules: no trailing slash, no route names of the protocol, no
    // escapes, no query, no credentials, no deep paths.
    for (const prefix of ['/c/', '/v2', '/v1/x', '/config.json', '/_bundler', '/%2e%2e', '/a/b/c/d', '//c']) {
        assert.throws(() => noteBoundV1.validateProfile(prefixed(prefix), { network: 'mainnet' }), /\[build\]/, prefix);
    }
    assert.throws(() => noteBoundV1.validateProfile(prefixed('/c', config => {
        config.trusted_deployment.protocol_server_url = 'https://user:pw@zkapi-mainnet.openanonymity.ai/c';
    }), { network: 'mainnet' }), /credential-free/);
    // What the runtime reads as an origin stays an origin.
    assert.throws(() => noteBoundV1.validateProfile(prefixed('/c', config => {
        config.trusted_deployment.rpc_url = 'https://rpc.example.test/path';
    }), { network: 'mainnet', strict: true }), /credential-free/);
});

test('static validation omits emitted file hashes but still requires well formed pins', () => {
    const config = noteBoundProfile('mainnet');
    assert.equal(noteBoundV1.validateProfile(config, { network: 'mainnet' }), config);
    assert.throws(() => noteBoundV1.validateProfile(noteBoundProfile('mainnet', c => {
        c.trusted_deployment.request_proving_key_sha256 = 'short';
    }), { network: 'mainnet' }), /request proving key/);
    // Present hashes must match the pins: [] is "no file emitted".
    assert.throws(() => noteBoundV1.validateProfile(config, { network: 'mainnet', files: {} }), /request proving key/);
    assert.throws(() => noteBoundV1.validateProfile(config, { network: 'mainnet', circuitId: 'zkapi-v2-concession-v1' }), /proof circuit/);
});

test('strict validation adds the registry origin and inference-base rules without touching the default', () => {
    const base = (mutate) => noteBoundProfile('mainnet', mutate);
    const cases = [
        [c => { c.trusted_deployment.rpc_url = 'http://insecure.example.test'; }, /credential-free/],
        [c => { c.trusted_deployment.rpc_url = 'https://user:pw@rpc.example.test'; }, /credential-free/],
        [c => { c.trusted_deployment.rpc_url = 'https://rpc.example.test/key'; }, /credential-free/],
        [c => { delete c.trusted_deployment.rpc_url; }, /credential-free/],
        [c => { c.trusted_deployment.verifier_url = 'https://verifier.example.test/?key=1'; }, /credential-free/],
        [c => { c.trusted_deployment.openrouter_inference_base = 'https://openrouter.ai/api/v1/'; }, /OpenRouter/]
    ];
    for (const [mutate, pattern] of cases) {
        const config = base(mutate);
        noteBoundV1.validateProfile(config, { network: 'mainnet' });
        assert.throws(() => noteBoundV1.validateProfile(config, { network: 'mainnet', strict: true }), pattern);
    }
    noteBoundV1.validateProfile(base(), { network: 'mainnet', strict: true });
    // The proxy path is data of the row.
    const v2Routes = base(c => { c.deployment_api_proxy_path = '/zkapi-deployment-v2c/'; });
    assert.throws(() => noteBoundV1.validateProfile(v2Routes, { network: 'mainnet' }), /routes/);
    noteBoundV1.validateProfile(v2Routes, { network: 'mainnet', proxyPath: '/zkapi-deployment-v2c/' });
});

test('concession-v1 validateProfile checks the shared base and the revision 3 pins', () => {
    for (const network of ['mainnet', 'sepolia']) {
        const config = concessionProfile(network, { slot: 2 });
        const files = {
            'proofs/request.pk': config.trusted_deployment.request_proving_key_sha256,
            'proofs/withdrawal.pk': config.trusted_deployment.withdrawal_proving_key_sha256,
            'proofs/request.vk': config.trusted_deployment.request_verifying_key_sha256
        };
        assert.equal(concessionV1.validateProfile(config, { network, files, strict: true }), config);
        assert.equal(concessionV1.validateProfile(config, { network, circuitId: 'zkapi-v2-concession-v1' }), config);
        assert.throws(() => concessionV1.validateProfile(config, { network, circuitId: 'zkapi-v2-note-bound-v1' }), /proof circuit/);
        assert.throws(() => concessionV1.validateProfile(config, { network, files: { ...files, 'proofs/request.vk': 'f'.repeat(64) } }),
            /verifying key does not match/);
        assert.throws(() => concessionV1.validateProfile(config, { network, files: { ...files, 'proofs/request.pk': 'f'.repeat(64) } }),
            /request proving key/);
        // The default proxy path of the family is not the legacy one.
        assert.throws(() => concessionV1.validateProfile(concessionProfile(network, { slot: 3 }), { network }), /routes/);
        concessionV1.validateProfile(concessionProfile(network, { slot: 3 }), { network, proxyPath: '/zkapi-deployment-v3c/' });
    }
    // A legacy profile is not a concession profile and vice versa.
    assert.throws(() => concessionV1.validateProfile(noteBoundProfile('mainnet'), { network: 'mainnet' }), /proof circuit/);
    assert.throws(() => noteBoundV1.validateProfile(concessionProfile('mainnet'), { network: 'mainnet' }), /proof circuit/);
    // Placeholders and unknown states never validate, whatever the network.
    for (const config of [{ deployment_status: 'not_deployed' }, { trusted_deployment: { deployment_status: 'not_deployed' } }]) {
        assert.throws(() => concessionV1.validateProfile(config, { network: 'sepolia' }), /placeholder/);
    }
});

test('concession-v1 accepts the ceremony and the development setup alike, on every network', () => {
    const outcomes = new Map();
    for (const network of ['mainnet', 'sepolia']) {
        const profile = (mutate = null) => concessionProfile(network, { mutate: mutate && (config => mutate(config.trusted_deployment)) });
        const refusal = (config, ctx = {}) => {
            try {
                concessionV1.validateProfile(config, { network, ...ctx });
            } catch (error) {
                return error.message;
            }
            return assert.fail('the profile was accepted');
        };
        // What each input did, keyed by a name that is the same on both
        // networks: a rule keyed on the network shows up as a difference.
        const note = (key, value) => {
            if (!outcomes.has(key)) outcomes.set(key, new Set());
            outcomes.get(key).add(value);
        };

        // Both setups validate, whatever the retired switch says (the field
        // means nothing to the host).
        for (const setup of ['mpc-1', 'dev']) {
            for (const switchValue of [undefined, false, true, null, 0, 'false', {}]) {
                const config = profile(pins => {
                    pins.setup_id = setup;
                    if (switchValue === undefined) delete pins.allow_dev_setup;
                    else pins.allow_dev_setup = switchValue;
                });
                assert.equal(concessionV1.validateProfile(config, { network }), config);
                // The same pair with the bundle built for that setup.
                assert.equal(concessionV1.validateProfile(config, { network, setupId: setup }), config);
                note(`accepted:${setup}:${String(switchValue)}`, 'accepted');
            }
        }

        // Any other value, and a missing one, is refused with the accepted
        // ids named; the message names no network.
        for (const setup of ['rehearsal', 'mpc-2', 'DEV', 'MPC-1', ' dev', '', null, 0, true, {}, ['dev']]) {
            const message = refusal(profile(pins => { pins.setup_id = setup; }));
            assert.match(message, /must pin an accepted proof setup \(mpc-1 or dev\)/);
            note(`refused:${JSON.stringify(setup)}`, message);
        }
        const missing = refusal(profile(pins => { delete pins.setup_id; }));
        assert.match(missing, /must pin an accepted proof setup \(mpc-1 or dev\)/);
        note('refused:missing', missing);
        // A refused profile stays refused when the bundle names an accepted setup.
        assert.match(refusal(profile(pins => { pins.setup_id = 'rehearsal'; }), { setupId: 'dev' }), /must pin an accepted proof setup/);

        // The SDK bundle's own setup, when the caller has one: the key present
        // must be one of the two even when its value is undefined (as circuitId
        // is), and must equal the profile's.
        const config = profile();
        assert.equal(concessionV1.validateProfile(config, { network }), config);
        for (const setupId of ['rehearsal', 'mpc-2', '', null, undefined, 1]) {
            const message = refusal(config, { setupId });
            assert.match(message, /SDK bundle must be built for an accepted proof setup \(mpc-1 or dev\)/);
            note(`bundle:${String(setupId)}`, message);
        }
        for (const [pinned, built] of [['mpc-1', 'dev'], ['dev', 'mpc-1']]) {
            const message = refusal(profile(pins => { pins.setup_id = pinned; }), { setupId: built });
            assert.equal(message, `[build] The SDK bundle is built for the ${built} proof setup, but the profile pins the ${pinned} proof setup.`);
            note(`mismatch:${pinned}:${built}`, message);
        }
    }
    // Every input gave one outcome on both networks, none naming a network.
    assert.ok(outcomes.size > 0);
    for (const [key, set] of outcomes) {
        assert.equal(set.size, 1, `${key}: ${[...set].join(' | ')}`);
        for (const value of set) assert.doesNotMatch(value, /mainnet|sepolia|rehearsal entry/i);
    }

    // The legacy family has no setup in its profile or its manifest and never
    // reads the key, so a v1 build is unaffected by the bundle rule.
    for (const network of ['mainnet', 'sepolia']) {
        const legacy = noteBoundProfile(network);
        assert.equal(noteBoundV1.validateProfile(legacy, { network, setupId: 'dev' }), legacy);
        assert.equal(noteBoundV1.validateProfile(legacy, { network, setupId: undefined }), legacy);
        assert.equal(noteBoundV1.validateProfile(legacy, { network, allowDevSetup: true }), legacy);
    }
});

test('proofSetupKind tells the two accepted setups apart and nothing else', () => {
    assert.equal(proofSetupKind('mpc-1'), 'ceremony');
    assert.equal(proofSetupKind('dev'), 'development');
    assert.equal(CEREMONY_SETUP_ID, 'mpc-1');
    assert.equal(DEVELOPMENT_SETUP_ID, 'dev');
    assert.deepEqual([...ACCEPTED_SETUP_IDS], ['mpc-1', 'dev']);
    assert.ok(Object.isFrozen(ACCEPTED_SETUP_IDS));
    // A family with no setup id (the legacy one), an unknown id and a value
    // that is not a string are all "no kind", never a guess.
    for (const value of [undefined, null, '', 'rehearsal', 'mpc-2', 'DEV', 0, false, {}, ['dev'], 'constructor', '__proto__']) {
        assert.equal(proofSetupKind(value), null, String(value));
    }
});

test('fundingFromProfile returns the vault identity and refuses a non native-ETH profile', () => {
    const legacy = noteBoundV1.fundingFromProfile(noteBoundProfile('mainnet'));
    assert.deepEqual(legacy, {
        chain_id: 1,
        contract_address: VAULT,
        billing_asset: 'native_eth',
        billing_unit: 'gwei',
        native_asset_wei_per_unit: '1000000000',
        demo_rpc_url: 'https://ethereum-rpc.publicnode.com'
    });
    const next = concessionV1.fundingFromProfile(concessionProfile('sepolia', { slot: 2 }));
    assert.equal(next.chain_id, 11155111);
    assert.equal(next.contract_address, `0x${'2'.repeat(40)}`);
    assert.equal(next.demo_rpc_url, 'https://ethereum-sepolia-rpc.publicnode.com');
    for (const adapter of ADAPTER_IDS.map(getAdapter)) {
        for (const mutate of [
            c => { c.trusted_deployment.billing_asset = 'erc20'; },
            c => { c.trusted_deployment.billing_unit = 'wei'; },
            c => { c.trusted_deployment.native_asset_wei_per_unit = '1'; },
            c => { c.trusted_deployment.contract_address = 'nope'; },
            c => { c.trusted_deployment.chain_id = 'one'; },
            c => { c.trusted_deployment.rpc_url = null; }
        ]) {
            assert.throws(() => adapter.fundingFromProfile(noteBoundProfile('mainnet', mutate)), /native ETH vault/);
        }
        assert.throws(() => adapter.fundingFromProfile(null), /native ETH vault/);
    }
});

// ---------------------------------------------------------------------------
// closeBy and chat cutoff
// ---------------------------------------------------------------------------

test('closeBy is the note expiry minus the version margin, in epoch milliseconds', () => {
    const version = { transition: { closeByMarginSeconds: 259_200, reminderDays: [7, 3, 1], promptWindowDays: 14 } };
    const expiry = NOW_SECONDS + 30 * DAY;
    for (const adapter of ADAPTER_IDS.map(getAdapter)) {
        assert.equal(adapter.closeBy(expiry, version), (expiry - 259_200) * 1000);
        assert.equal(adapter.closeBy(expiry, { transition: { ...version.transition, closeByMarginSeconds: 0 } }), expiry * 1000);
        for (const bad of [null, undefined, 0, -5, 'soon', NaN, 1.5, {}]) {
            assert.equal(adapter.closeBy(bad, version), null, String(bad));
        }
        for (const transition of [null, {}, { closeByMarginSeconds: -1 }, { closeByMarginSeconds: 1.5 }]) {
            assert.equal(adapter.closeBy(expiry, { transition }), null);
        }
        assert.equal(adapter.closeBy(expiry, null), null);
        // A margin larger than the note's whole life has no meaningful close-by.
        assert.equal(adapter.closeBy(100, { transition: { closeByMarginSeconds: 259_200 } }), null);
    }
    assert.equal(String(expiry), String(noteBoundV1.closeBy(String(expiry), version) / 1000 + 259_200));
});

// ---------------------------------------------------------------------------
// Call profiles against the real encoders
// ---------------------------------------------------------------------------

// The legacy encoder leaves the vault address in checksum case; the signer
// lower-cases calldata before reading it, and so does this decoder.
function decodeCalldata(calldata) {
    assert.match(calldata, /^0x(?:[0-9a-fA-F]{2})+$/);
    const body = calldata.slice(2).toLowerCase();
    assert.equal((body.length - 8) % 64, 0, 'calldata is selector plus whole words');
    return { selector: body.slice(0, 8), words: body.slice(8).match(/.{64}/g) || [] };
}
const word = (decoded, index) => BigInt(`0x${decoded.words[index]}`);
const addressWord = (decoded, index) => `0x${decoded.words[index].slice(24)}`;

function assertExitLayout(profile, mode, calldata, expected) {
    const exit = profile.exits.find(entry => entry.mode === mode);
    assert.ok(exit, `${profile.id} has a ${mode} exit`);
    const decoded = decodeCalldata(calldata);
    assert.equal(decoded.selector, exit.selector);
    assert.equal(decoded.words.length, exit.words);
    assert.equal(word(decoded, exit.kind.word), exit.kind.value);
    assert.equal(word(decoded, exit.bytesOffset.word), exit.bytesOffset.value);
    assert.equal(word(decoded, exit.proofLength.word), exit.proofLength.value);
    // The bytes offset is where the proof length word sits.
    assert.equal(exit.bytesOffset.value, BigInt(exit.proofLength.word * 32));
    // The proof is the eight words after its length, the end of the calldata.
    assert.equal(exit.proofLength.word + 1 + 8, exit.words);
    const { fields } = profile;
    assert.equal(word(decoded, fields.chainId), BigInt(expected.chainId));
    assert.equal(addressWord(decoded, fields.vault).toLowerCase(), expected.vault.toLowerCase());
    assert.equal(word(decoded, fields.noteId), BigInt(expected.noteId));
    assert.equal(word(decoded, fields.finalBalance), BigInt(expected.finalBalance));
    assert.equal(addressWord(decoded, fields.destination).toLowerCase(), expected.destination.toLowerCase());
    assert.equal(word(decoded, fields.nullifier), BigInt(expected.nullifier));
    for (const index of exit.zeroWords) assert.equal(word(decoded, index), 0n, `word ${index} is zero`);
    for (const index of exit.nonZeroWords) {
        assert.notEqual(word(decoded, index), 0n, `word ${index} is not zero`);
        assert.notEqual(word(decoded, index), word(decoded, fields.nullifier), `word ${index} differs from the nullifier`);
    }
    if (exit.concededWord !== null) assert.equal(word(decoded, exit.concededWord), BigInt(expected.conceded));
    return decoded;
}

function legacyPlan(mode) {
    return {
        mode,
        siblings: Array(32).fill('0x0'),
        proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256).toString('base64') },
        public_inputs: {
            protocol_version: 2, chain_id: 1, contract_address: VAULT, active_root: '0x1',
            state_signing_key_x: '0x1', state_signing_key_y: '0x1', clearance_signing_key_x: '0x1', clearance_signing_key_y: '0x1',
            note_id: 7, final_balance: 1_500_000, destination: DESTINATION, withdrawal_nullifier: '0x2a',
            has_clearance: mode === 'mutual', withdrawal_tag: '0x8'
        }
    };
}

test('the note-bound-v1 call profile equals what the installed legacy SDK encodes', () => {
    const profile = noteBoundV1.callProfile;
    assert.equal(profile.id, 'note-bound-v1');
    const expected = { chainId: 1, vault: VAULT, noteId: 7, finalBalance: 1_500_000, destination: DESTINATION, nullifier: 0x2a };
    for (const mode of ['mutual', 'escape']) {
        const calldata = codec.encodeWithdrawal(legacyPlan(mode), mode, DESTINATION, VAULT);
        assertExitLayout(profile, mode, calldata, { ...expected, conceded: 0 });
    }
    assert.equal(profile.exits.find(exit => exit.mode === 'mutual').selector, codec.ABI.mutualClose);
    assert.equal(profile.exits.find(exit => exit.mode === 'escape').selector, codec.ABI.initiateEscapeWithdrawal);

    const deposit = decodeCalldata(codec.encodeDeposit({ commitment: '0x1234', zero_path: Array(32).fill('0x0') }, 5n));
    assert.equal(deposit.selector, profile.deposit.selector);
    assert.equal(deposit.selector, codec.ABI.deposit);
    assert.equal(deposit.words.length, profile.deposit.words);
    // The deposit's commitment and amount words are the same in every family.
    assert.equal(word(deposit, 0), 0x1234n);
    assert.equal(word(deposit, 1), 5n);

    const finalize = decodeCalldata(codec.encodeFinalizeEscape(7));
    assert.equal(finalize.selector, profile.finalize.selector);
    assert.equal(finalize.selector, codec.ABI.finalizeEscapeWithdrawal);
    assert.equal(finalize.words.length, profile.finalize.words);
    assert.equal(word(finalize, profile.finalize.noteIdWord), 7n);
    assert.equal(profile.claim, null);
});

// Calldata of `cast calldata` (Foundry 1.5.1) for the vault revision 3
// signatures, upstream sdk/test/fixtures/vault-calldata-golden.json; the proof
// bytes are 0x00..0xff. Independent of any SDK encoder.
const GOLDEN = {
    mutualClose:
        '0x72cd2e44000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000004386fdbda35d995beb3bf8625118ec5982ec81fe00000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000001300000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000015000000000000000000000000000000000000000000000000000000000000000700000000000000000000000000000000000000000000000000000000001c3a900000000000000000000000005615deb798bb3e4dfa0139dfa1b3d433cc23b72f0000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffffffffffffffff00000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000100000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
    initiateEscapeWithdrawal:
        '0xa38d62aa00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000aa36a7000000000000000000000000590df9abbfb21074016daa486c771ae0af729ee230644e72e131a029b85045b68181585d2833e84879b9709143e1f593f000000000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000013000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000150000000000000000000000000000000000000000000000000000000000000015000000000000000000000000000000000000000000000000001fffffffffffff0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000002a5c6b0e9f1d3b7a8c4e2f6a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f2a3b4c0000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000006b49fc3000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000100000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff'
};

test('the concession-v1 call profile equals the revision 3 vault calldata', () => {
    const profile = concessionV1.callProfile;
    assert.equal(profile.id, 'concession-v1');
    assertExitLayout(profile, 'mutual', GOLDEN.mutualClose, {
        chainId: 1, vault: '0x4386fdbda35d995beb3bf8625118ec5982ec81fe', noteId: 7, finalBalance: 0x1c3a90,
        destination: '0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f', nullifier: 0x16, conceded: 0
    });
    assertExitLayout(profile, 'escape', GOLDEN.initiateEscapeWithdrawal, {
        chainId: 11155111, vault: '0x590df9abbfb21074016daa486c771ae0af729ee2', noteId: 0x15,
        finalBalance: 0x1fffffffffffff, destination: '0x2222222222222222222222222222222222222222', nullifier: 0x16, conceded: 0x64
    });

    // The vault appends a deposit's leaf itself: two words, a new selector.
    // Finalize is unchanged from the legacy vault.
    assert.deepEqual(profile.deposit, { selector: '56d2e1ea', words: 2 });
    assert.notDeepEqual(profile.deposit, noteBoundV1.callProfile.deposit);
    assert.deepEqual(profile.finalize, noteBoundV1.callProfile.finalize);
    assert.deepEqual(profile.fields, noteBoundV1.callProfile.fields);

    // claimEscapePayout(destination): the selector and a single address word
    // (upstream wallet.js encodeClaimEscapePayout, ABI.claimEscapePayout).
    const claim = decodeCalldata(`0x88c10aee${'0'.repeat(24)}${DESTINATION.slice(2)}`);
    assert.equal(claim.selector, profile.claim.selector);
    assert.equal(claim.words.length, profile.claim.words);
    assert.equal(addressWord(claim, profile.claim.destinationWord), DESTINATION);
    assert.equal(profile.claim.recoveryKind, 'escape-payout-claim');
    assert.equal(profile.claim.authorizationKind, 'payout-claim');
});

test('call profiles do not share exit selectors, so one protocol never signs the other\'s exits', () => {
    const legacyExits = noteBoundV1.callProfile.exits.map(exit => exit.selector);
    const nextExits = concessionV1.callProfile.exits.map(exit => exit.selector);
    assert.deepEqual(legacyExits, ['7fca9c82', '9073639b']);
    assert.deepEqual(nextExits, ['72cd2e44', 'a38d62aa']);
    assert.equal(legacyExits.filter(selector => nextExits.includes(selector)).length, 0);
    // The legacy vault has no payout credit to claim.
    assert.equal(noteBoundV1.callProfile.claim, null);
    assert.ok(concessionV1.callProfile.claim);
    for (const profile of [noteBoundV1.callProfile, concessionV1.callProfile]) {
        assert.deepEqual(profile.exits.map(exit => exit.mode), ['mutual', 'escape']);
        assert.equal(profile.exits.find(exit => exit.mode === 'mutual').kind.value, 1n);
        assert.equal(profile.exits.find(exit => exit.mode === 'escape').kind.value, 0n);
        for (const exit of profile.exits) {
            for (const index of [...exit.zeroWords, ...exit.nonZeroWords, exit.kind.word, exit.bytesOffset.word,
                exit.proofLength.word]) {
                assert.ok(index >= 0 && index < exit.words);
            }
        }
    }
});

// ---------------------------------------------------------------------------
// Deposit entry points against the installed legacy SDK
// ---------------------------------------------------------------------------

// Every method of a class body (four-space indented definitions) in a source
// file. Reading the source avoids executing the browser SDK in Node.
function classMethods(source, className) {
    const names = new Set();
    let inside = false;
    for (const line of source.split('\n')) {
        const open = line.match(/^class (\w+)/);
        if (open) inside = open[1] === className;
        else if (/^}/.test(line)) inside = false;
        else if (inside) {
            const method = line.match(/^    (?:static )?(?:async )?(\w+)\s*\(/);
            if (method) names.add(method[1]);
        }
    }
    return names;
}

test('every deposit-named method of the installed legacy SDK is classified', () => {
    const require = createRequire(import.meta.url);
    const directory = path.dirname(require.resolve('@openanonymity/zkapi-browser-sdk/package.json'));
    const sources = {
        client: [path.join(directory, 'sdk/services/zkapiClient.js'), 'ZkapiClient'],
        runtime: [path.join(directory, 'sdk/services/browserWalletRuntime.js'), 'BrowserWalletRuntime']
    };
    for (const [side, [file, className]] of Object.entries(sources)) {
        const methods = classMethods(fs.readFileSync(file, 'utf8'), className);
        assert.ok(methods.size > 50, `${className} was read`);
        const classified = new Set([...noteBoundV1.depositEntryPoints[side], ...noteBoundV1.recoveryEntryPoints[side]]);
        const guarded = new Set(noteBoundV1.depositEntryPoints[side]);
        for (const name of [...methods].filter(method => /deposit/i.test(method))) {
            assert.ok(classified.has(name), `${className}.${name} is not classified`);
        }
        // A listed name must exist, so the lists cannot silently go stale.
        for (const name of classified) assert.ok(methods.has(name), `${className}.${name} no longer exists`);
        // A name is either started-deposit safe (recovery) or guarded, never both.
        for (const name of noteBoundV1.recoveryEntryPoints[side]) assert.ok(!guarded.has(name), name);
    }
});

// The revision 3 client and runtime /deposit/i methods, enumerated from the
// 0.2.0 sources (82c8504) when the adapter was written; the SDK is not
// installed here, so the list is the fixture.
const REVISION_3_DEPOSIT_METHODS = {
    client: ['assertDepositMayStart', 'browserDepositNonceConsumed', 'browserDepositSlotConflictFinality',
        'confirmBrowserDepositReceipt', 'deposit', 'performDeposit', 'prepareDepositQuote', 'prepareDepositRetry',
        'quoteDepositUsd', 'readDepositReceiptMetadata', 'recoverBrowserDeposit', 'recoverUnknownDeposit',
        'refreshConfirmedBrowserDeposit', 'retryDroppedDeposit', 'retryUnknownDeposit'],
    runtime: ['authorizePendingDepositRetry', 'canQuotePendingDeposit', 'claimPendingDepositReplacement',
        'claimPendingDepositSubmission', 'confirmDeposit', 'depositSubmissionMatches', 'depositsClosed',
        'depositsClosedError', 'discardClosedDepositDraftLocked', 'getDepositHistory', 'markPendingDepositAmbiguous',
        'markPendingDepositMissingReceipts', 'markPendingDepositRetryable', 'markPendingDepositUnknown',
        'nextDepositPath', 'pendingDeposit', 'prepareDeposit', 'prepareDepositQuote', 'refreshPendingDeposit',
        'releasePendingDepositReplacementClaim', 'rememberPendingDepositSubmissionMetadata',
        'rememberPendingDepositTransaction', 'resolvePendingDepositSlotConflict', 'verifiedDepositPath',
        'verifyDeploymentForDeposit']
};

test('every deposit-named method of the revision 3 SDK is classified', () => {
    for (const side of ['client', 'runtime']) {
        const classified = new Set([...concessionV1.depositEntryPoints[side], ...concessionV1.recoveryEntryPoints[side]]);
        for (const name of REVISION_3_DEPOSIT_METHODS[side]) assert.ok(classified.has(name), `${side}.${name}`);
        for (const name of concessionV1.depositEntryPoints[side]) {
            assert.ok(REVISION_3_DEPOSIT_METHODS[side].includes(name), `${side}.${name} is guarded but not an SDK method`);
        }
    }
    // The methods that begin a deposit are the same set in both generations.
    assert.deepEqual(concessionV1.depositEntryPoints, noteBoundV1.depositEntryPoints);
    // Recovery of a started deposit is never guarded.
    for (const adapter of ADAPTER_IDS.map(getAdapter)) {
        for (const name of ['recoverBrowserDeposit', 'recoverUnknownDeposit', 'retryDroppedDeposit', 'retryUnknownDeposit',
            'prepareDepositRetry', 'resumeExternalTransaction']) {
            assert.ok(adapter.recoveryEntryPoints.client.includes(name), name);
            assert.ok(!adapter.depositEntryPoints.client.includes(name), name);
        }
        for (const name of ['claimPendingDepositSubmission', 'confirmDeposit', 'refreshPendingDeposit']) {
            assert.ok(adapter.recoveryEntryPoints.runtime.includes(name), name);
            assert.ok(!adapter.depositEntryPoints.runtime.includes(name), name);
        }
    }
});

// ---------------------------------------------------------------------------
// Snapshot normalization
// ---------------------------------------------------------------------------

const slotNote = (overrides = {}) => ({
    has_note: true,
    pending_request: false,
    note: { note_id: 4, deposit_amount: 5_000_000, current_balance: 4_000_000, expiry_ts: NOW_SECONDS + 20 * DAY, is_genesis: false, ...overrides }
});

const depositRow = (noteId, expiryTs, deploymentId = LEGACY_DEPLOYMENT, extra = {}) => ({
    recordId: `${deploymentId}:deposit:${noteId}`, type: 'deposit', deploymentId, noteId, amount: 3, expiryTs, status: 'confirmed', ...extra
});

// Withdrawal records as the SDK's snapshot lists them: note state, proof and
// nullifier stripped (browserWalletRuntime.snapshot()).
const withdrawalRecord = (noteId, phase, extra = {}) => ({
    recordId: `${LEGACY_DEPLOYMENT}:1:${VAULT}:${noteId}`, deploymentId: LEGACY_DEPLOYMENT, chainId: 1, contractAddress: VAULT,
    noteId, mode: 'mutual', phase, destination: DESTINATION, revision: 1, updatedAt: 1,
    backgroundWithdrawalReady: false, backgroundPreparationCancelable: false, ...extra
});

test('unusable input normalizes to the empty snapshot and never throws', () => {
    const empties = [[noteBoundV1, emptyNormalizedSnapshot()], [concessionV1, concessionFields({})]];
    for (const [adapter, empty] of empties) {
        for (const input of [undefined, null, 0, 'snapshot', [], true, {}, { config: null, wallet: 5, withdrawals: 'x', deposits: {} },
            { config: { exit: 7, service: [], unresolved_requests: 'x' }, withdrawals: [null, 5, 'x', []] }]) {
            assert.deepEqual(normalized(adapter, input), empty);
        }
        // Also with no context at all.
        assert.deepEqual(adapter.normalizeSnapshot(undefined), empty);
    }
    // The legacy family and the empty snapshot are untouched by the revision 3
    // fields: nothing was added to them.
    assert.deepEqual(Object.keys(emptyNormalizedSnapshot()).sort(), ['deadlines', 'exit', 'expiryTs', 'hasNote',
        'hasOpenWithdrawal', 'hasPendingDeposit', 'hasPreparedWithdrawal', 'hasUnsentPrepared', 'otherDeploymentCredits',
        'otherDeploymentWithdrawals', 'sdkDepositsClosed', 'service']);
    assert.deepEqual(emptyNormalizedSnapshot(), {
        hasNote: false, expiryTs: null, deadlines: [], hasPendingDeposit: false, hasUnsentPrepared: false,
        hasPreparedWithdrawal: false, hasOpenWithdrawal: false, sdkDepositsClosed: false, service: null,
        otherDeploymentWithdrawals: [], otherDeploymentCredits: [], exit: null
    });
    // Fresh objects each time, so a caller cannot corrupt the next.
    assert.notEqual(emptyNormalizedSnapshot().deadlines, emptyNormalizedSnapshot().deadlines);
});

test('legacy: the slot note gives the expiry and one slot deadline', () => {
    const expiryTs = NOW_SECONDS + 20 * DAY;
    const snapshot = legacyClientSnapshot({ wallet: slotNote({ expiry_ts: expiryTs }) });
    assert.deepEqual(normalized(noteBoundV1, snapshot), withFields({
        hasNote: true, expiryTs, deadlines: [{ source: 'slot', expiryTs }]
    }));
    // has_note false means no note, whatever else the wallet object carries.
    const noNote = legacyClientSnapshot({ wallet: { ...slotNote(), has_note: false } });
    assert.deepEqual(normalized(noteBoundV1, noNote), emptyNormalizedSnapshot());
    // A note whose expiry is not a usable date still counts as a note.
    for (const bad of [null, undefined, 0, -1, 'soon', 1.5]) {
        const odd = legacyClientSnapshot({ wallet: slotNote({ expiry_ts: bad }) });
        assert.deepEqual(normalized(noteBoundV1, odd), withFields({ hasNote: true }));
    }
    // The expiry may arrive as a decimal string.
    assert.equal(normalized(noteBoundV1, legacyClientSnapshot({ wallet: slotNote({ expiry_ts: String(expiryTs) }) })).expiryTs, expiryTs);
});

test('legacy: a runtime snapshot (raw state) normalizes like a client snapshot', () => {
    const expiryTs = NOW_SECONDS + 9 * DAY;
    const snapshot = { config: legacyClientSnapshot().config, runtime: { deploymentId: LEGACY_DEPLOYMENT, state: { note_id: 4, expiry_ts: expiryTs } },
        activeLease: null, deposits: [], withdrawals: [] };
    assert.deepEqual(normalized(noteBoundV1, snapshot), withFields({ hasNote: true, expiryTs, deadlines: [{ source: 'slot', expiryTs }] }));
});

test('legacy: set-aside notes carry deadlines joined from deposit rows; started escapes do not', () => {
    const slotExpiry = NOW_SECONDS + 20 * DAY;
    const snapshot = legacyClientSnapshot({
        wallet: slotNote({ expiry_ts: slotExpiry }),
        withdrawals: [
            withdrawalRecord(9, 'parked'),
            withdrawalRecord(10, 'pending', { mode: 'escape' }),
            withdrawalRecord(11, 'closed'),
            withdrawalRecord(12, 'restored', { mode: 'escape' }),
            // A finalization still in flight keeps a closed record open, but it
            // holds no note that could be swept.
            withdrawalRecord(13, 'closed', { finalizeSubmissionId: 'sub-1' }),
            withdrawalRecord(14, 'closed_unconfirmed'),
            withdrawalRecord(15, 'parked')   // no deposit row: no deadline can be computed
        ],
        deposits: [
            depositRow(4, slotExpiry),
            depositRow(9, NOW_SECONDS + 5 * DAY),
            depositRow(10, NOW_SECONDS + 2 * DAY),
            depositRow(12, NOW_SECONDS + 3 * DAY),
            depositRow(11, NOW_SECONDS + 1 * DAY),
            // Another deployment's note 15 must not be borrowed for ours.
            depositRow(15, NOW_SECONDS + 1 * DAY, 'some-other-deployment')
        ]
    });
    const result = normalized(noteBoundV1, snapshot);
    assert.deepEqual(result.deadlines, [
        { source: 'slot', expiryTs: slotExpiry },
        { source: 'set-aside', expiryTs: NOW_SECONDS + 3 * DAY },
        { source: 'set-aside', expiryTs: NOW_SECONDS + 5 * DAY }
    ]);
    assert.equal(result.hasOpenWithdrawal, true);
    assert.equal(result.hasNote, true);
    assert.equal(result.expiryTs, slotExpiry);
    // Note ids and record ids never leave the normalizer through deadlines.
    assert.ok(result.deadlines.every(deadline => Object.keys(deadline).sort().join() === 'expiryTs,source'));
});

test('legacy: a sanitized closed record is not open and a holder with only a set-aside note has no slot deadline', () => {
    const closedOnly = legacyClientSnapshot({ withdrawals: [withdrawalRecord(3, 'closed')] });
    assert.deepEqual(normalized(noteBoundV1, closedOnly), emptyNormalizedSnapshot());
    const parkedOnly = legacyClientSnapshot({
        withdrawals: [withdrawalRecord(9, 'parked')],
        deposits: [depositRow(9, NOW_SECONDS + 6 * DAY)]
    });
    assert.deepEqual(normalized(noteBoundV1, parkedOnly), withFields({
        hasOpenWithdrawal: true, deadlines: [{ source: 'set-aside', expiryTs: NOW_SECONDS + 6 * DAY }]
    }));
    // A malformed phase is treated as open: fail toward "still holds something".
    assert.equal(normalized(noteBoundV1, legacyClientSnapshot({ withdrawals: [{ recordId: 'x', noteId: 1 }] })).hasOpenWithdrawal, true);
    assert.equal(normalized(noteBoundV1, legacyClientSnapshot({ withdrawals: [null, 5, 'x'] })).hasOpenWithdrawal, false);
});

test('the annotate hook of the shared normalizer adds fields beside the deadline and changes nothing without it', () => {
    const slotExpiry = NOW_SECONDS + 20 * DAY;
    const snapshot = legacyClientSnapshot({
        wallet: slotNote({ expiry_ts: slotExpiry }),
        withdrawals: [withdrawalRecord(9, 'parked'), withdrawalRecord(12, 'restored', { mode: 'escape' })],
        deposits: [depositRow(9, NOW_SECONDS + 5 * DAY), depositRow(12, NOW_SECONDS + 3 * DAY)]
    });
    const phases = noteBoundV1.sweepablePhases;
    // No third argument, an empty one and a non-function are the legacy output.
    const plain = normalizeCommonSnapshot(snapshot, phases);
    assert.deepEqual(plain, normalized(noteBoundV1, snapshot));
    for (const options of [undefined, null, {}, { annotate: 'yes' }, []]) {
        assert.deepEqual(normalizeCommonSnapshot(snapshot, phases, options), plain, JSON.stringify(options));
    }
    // An annotator sees each set-aside record once (never the slot note's
    // own record) and its fields are added to that record's entry only.
    const seen = [];
    const annotated = normalizeCommonSnapshot(snapshot, phases, { annotate: record => {
        seen.push(record.noteId);
        return { recordId: record.recordId, flagged: record.mode === 'escape' };
    } });
    assert.deepEqual(seen.sort((left, right) => left - right), [9, 12]);
    assert.deepEqual(annotated.deadlines, [
        { source: 'slot', expiryTs: slotExpiry },
        { source: 'set-aside', expiryTs: NOW_SECONDS + 3 * DAY, recordId: withdrawalRecord(12, 'restored').recordId, flagged: true },
        { source: 'set-aside', expiryTs: NOW_SECONDS + 5 * DAY, recordId: withdrawalRecord(9, 'parked').recordId, flagged: false }
    ]);
    // An annotator can neither replace the deadline's own fields nor break
    // normalization by throwing, and a non-object answer adds nothing.
    const hostile = normalizeCommonSnapshot(snapshot, phases, { annotate: () => ({ source: 'slot', expiryTs: 1, extra: true }) });
    assert.deepEqual(hostile.deadlines.slice(1), [
        { source: 'set-aside', expiryTs: NOW_SECONDS + 3 * DAY, extra: true },
        { source: 'set-aside', expiryTs: NOW_SECONDS + 5 * DAY, extra: true }
    ]);
    for (const annotate of [() => { throw new Error('boom'); }, () => null, () => 'x', () => [1], () => undefined]) {
        assert.deepEqual(normalizeCommonSnapshot(snapshot, phases, { annotate }), plain);
    }
});

test('legacy: a set-aside record of the slot note is not listed twice', () => {
    const expiryTs = NOW_SECONDS + 4 * DAY;
    const snapshot = legacyClientSnapshot({
        wallet: slotNote({ note_id: 9, expiry_ts: expiryTs }),
        withdrawals: [withdrawalRecord(9, 'restored')],
        deposits: [depositRow(9, expiryTs)]
    });
    assert.deepEqual(normalized(noteBoundV1, snapshot).deadlines, [{ source: 'slot', expiryTs }]);
});

test('legacy: pending deposits, unsent plans, prepared withdrawals and late attempts', () => {
    const pending = (extra = {}) => ({
        operation_id: 'op-1', phase: 'prepared', amount: 1000, funding_quote_available: true, next_note_id: 2,
        transaction_hash: null, transaction_hashes: [], replacement_available: false, ...extra
    });
    const config = config => legacyClientSnapshot({ config });
    const unsent = normalized(noteBoundV1, config({ pending_deposit: pending() }));
    assert.equal(unsent.hasPendingDeposit, true);
    assert.equal(unsent.hasUnsentPrepared, true);

    for (const started of [
        pending({ phase: 'awaiting_wallet' }), pending({ phase: 'submitted' }), pending({ phase: 'ambiguous' }),
        pending({ phase: 'dropped_or_pending' }), pending({ phase: 'retry_exact' }),
        pending({ transaction_hash: `0x${'ab'.repeat(32)}` }), pending({ transaction_hashes: [`0x${'ab'.repeat(32)}`] }),
        pending({ replacement_available: true })
    ]) {
        const result = normalized(noteBoundV1, config({ pending_deposit: started }));
        assert.equal(result.hasPendingDeposit, true);
        assert.equal(result.hasUnsentPrepared, false, JSON.stringify(started));
    }
    // A raw runtime in the snapshot can only move the answer toward "started".
    const raw = extra => ({ ...config({ pending_deposit: pending() }),
        runtime: { deploymentId: LEGACY_DEPLOYMENT, pendingDeposit: { operationId: 'op-1', phase: 'prepared', ...extra } } });
    assert.equal(normalized(noteBoundV1, raw({})).hasUnsentPrepared, true);
    for (const extra of [{ submissionId: 's' }, { submissionOwner: 'tab' }, { submissionFrom: DESTINATION }, { submissionNonce: 0 },
        { transactionHash: '0x1' }, { transactionHashes: ['0x1'] }, { transactionAttempts: [{}] },
        { ambiguousSubmissions: [{}] }, { approvals: [{}] }, { legacyRecovery: true }]) {
        assert.equal(normalized(noteBoundV1, raw(extra)).hasUnsentPrepared, false, JSON.stringify(extra));
    }

    // A late deposit attempt is a deposit in flight, never an unsent plan.
    const late = normalized(noteBoundV1, config({
        pending_deposit: pending(),
        late_deposit_attempts: [{ operation_id: 'd1', note_id: 4, amount: 5, transaction_hash: '0x1', status: 'pending' }]
    }));
    assert.equal(late.hasPendingDeposit, true);
    assert.equal(late.hasUnsentPrepared, false);
    assert.equal(normalized(noteBoundV1, config({
        late_deposit_attempts: [{ operation_id: 'd1', note_id: 4, amount: 5, status: 'pending' }]
    })).hasPendingDeposit, true);

    const prepared = normalized(noteBoundV1, config({
        prepared_withdrawal: { mode: 'mutual', phase: 'prepared', note_id: 1, destination: DESTINATION }
    }));
    assert.equal(prepared.hasPreparedWithdrawal, true);
    assert.equal(prepared.hasOpenWithdrawal, false);
    assert.equal(normalized(noteBoundV1, config({
        late_withdrawal_attempts: [{ operation_id: 'l1', note_id: 3, mode: 'mutual', destination: DESTINATION, status: 'pending' }]
    })).hasOpenWithdrawal, true);
});

test('legacy: the snapshot of the installed SDK runtime has the fields the adapter reads', async () => {
    // A real BrowserWalletRuntime of the pinned SDK, populated through its
    // own state and projected by its own snapshot(), so a changed field name
    // in a future pin fails here instead of silently emptying the banner.
    globalThis.location ??= { href: 'https://app.example/', origin: 'https://app.example', search: '' };
    const { configureBrowserSdk } = await import('@openanonymity/zkapi-browser-sdk/configure');
    configureBrowserSdk({ configUrl: 'https://app.example/zkapi/browser-config.json' });
    const { BrowserWalletRuntime } = await import('@openanonymity/zkapi-browser-sdk/runtime');
    const profile = noteBoundProfile('mainnet');
    const pins = profile.trusted_deployment;
    const runtime = new BrowserWalletRuntime();
    runtime.browserConfig = profile;
    runtime.manifest = {
        protocol_version: 2, proof_backend: 'groth16_bn254',
        proof_setup: { circuit_id: pins.circuit_id, request_proving_key_sha256: pins.request_proving_key_sha256,
            withdrawal_proving_key_sha256: pins.withdrawal_proving_key_sha256 },
        deployment_id: pins.deployment_id, contract_address: pins.contract_address, chain_id: pins.chain_id,
        protocol_server_url: pins.protocol_server_url, indexer_url: pins.indexer_url, rpc_url: pins.rpc_url,
        billing_asset: pins.billing_asset, billing_unit: pins.billing_unit, billing_token_address: null,
        native_asset_wei_per_unit: pins.native_asset_wei_per_unit, native_price_feed_address: pins.native_price_feed_address,
        native_price_feed_decimals: pins.native_price_feed_decimals, native_price_max_age_seconds: pins.native_price_max_age_seconds,
        request_charge_cap: pins.request_charge_cap, state_signing_key: pins.state_signing_key,
        clearance_signing_key: pins.clearance_signing_key,
        privacy_mode: { openrouter_inference_base: pins.openrouter_inference_base, verifier_url: pins.verifier_url }
    };
    runtime.config = runtime.buildClientConfig(runtime.manifest, profile);
    const slotExpiry = NOW_SECONDS + 25 * DAY;
    runtime.runtime = {
        version: 1, deploymentId: pins.deployment_id,
        state: { note_id: 4, deposit_amount: 5_000_000, current_balance: 4_000_000, expiry_ts: slotExpiry, secret_s: '0x1' },
        journal: null, pendingDeposit: null, depositQuote: null,
        preparedWithdrawal: { mode: 'mutual', phase: 'prepared', noteId: 4, destination: DESTINATION, clearanceReserved: true },
        lease: null, lateWithdrawalAttempts: [], lateDepositAttempts: []
    };
    runtime.withdrawals = [
        { ...withdrawalRecord(9, 'parked'), state: { note_id: 9, expiry_ts: NOW_SECONDS + 6 * DAY }, preparedWithdrawal: {}, withdrawalNullifier: '0x1' },
        withdrawalRecord(11, 'closed')
    ];
    runtime.deposits = [depositRow(9, NOW_SECONDS + 6 * DAY, pins.deployment_id)];
    runtime.withdrawals[0].deploymentId = pins.deployment_id;
    runtime.withdrawals[1].deploymentId = pins.deployment_id;

    const sdkSnapshot = runtime.snapshot();
    const client = {
        config: sdkSnapshot.config,
        wallet: { has_note: true, pending_request: false, note: { note_id: 4, expiry_ts: slotExpiry } },
        withdrawals: sdkSnapshot.withdrawals,
        deposits: sdkSnapshot.deposits
    };
    const expected = withFields({
        hasNote: true, expiryTs: slotExpiry,
        deadlines: [{ source: 'slot', expiryTs: slotExpiry }, { source: 'set-aside', expiryTs: NOW_SECONDS + 6 * DAY }],
        hasPreparedWithdrawal: true, hasOpenWithdrawal: true
    });
    // As the client sees it, and as the runtime itself reports it (raw state).
    assert.deepEqual(normalized(noteBoundV1, client), expected);
    assert.deepEqual(normalized(noteBoundV1, sdkSnapshot), expected);

    runtime.runtime = { ...runtime.runtime, preparedWithdrawal: null,
        pendingDeposit: { operationId: 'op-1', phase: 'prepared', amount: 1000, next_note_id: 5, commitment: '0x1', secret: '0x2' } };
    const pendingSnapshot = runtime.snapshot();
    assert.equal(pendingSnapshot.config.pending_deposit.phase, 'prepared');
    const pending = normalized(noteBoundV1, { ...client, config: pendingSnapshot.config, runtime: pendingSnapshot.runtime });
    assert.equal(pending.hasPendingDeposit, true);
    assert.equal(pending.hasUnsentPrepared, true);
    assert.equal(pending.hasPreparedWithdrawal, false);
});

test('legacy: a revision 3 shaped config is ignored by the legacy adapter', () => {
    // 3342c95 never sets these; if something put them in a snapshot, the legacy
    // adapter would still report nothing about them (the host enforces closure).
    const snapshot = concessionClientSnapshot({ config: {
        deposits: 'closed',
        service: { available: false, exits: true, code: 'x', message: 'down', detail: null },
        other_deployment_withdrawals: [{ deployment_id: 'x', record_id: 'r', note_id: 1, mode: 'escape', phase: 'pending' }],
        other_deployment_credits: [{ deployment_id: 'x', record_id: 'r', note_id: 1, chain_id: 1, contract_address: VAULT, destination: DESTINATION, credited_amount: '5' }]
    } });
    assert.deepEqual(normalized(noteBoundV1, snapshot), emptyNormalizedSnapshot());
});

test('concession: deposits flag, service state, other deployments and the exit rules', () => {
    const expiryTs = NOW_SECONDS + 20 * DAY;
    const snapshot = concessionClientSnapshot({
        wallet: slotNote({ expiry_ts: expiryTs }),
        config: {
            deposits: 'closed',
            service: { available: false, exits: true, code: 'deployment_manifest_unavailable',
                message: 'Deposits and new chats are paused.', detail: 'Unable to load https://example.test/config.json' },
            other_deployment_withdrawals: [
                { deployment_id: LEGACY_DEPLOYMENT, record_id: 'r-9', note_id: 9, mode: 'mutual', phase: 'parked' },
                { deployment_id: LEGACY_DEPLOYMENT, record_id: 'r-10', note_id: 10, mode: 'escape', phase: 'pending' }
            ],
            // The SDK writes a JS number; a decimal string is the same amount.
            other_deployment_credits: [{
                deployment_id: LEGACY_DEPLOYMENT, record_id: 'r-11', note_id: 11, chain_id: 1, contract_address: VAULT,
                destination: DESTINATION, credited_amount: 1500
            }, {
                deployment_id: LEGACY_DEPLOYMENT, record_id: 'r-12', note_id: 12, chain_id: 1, contract_address: VAULT,
                destination: DESTINATION, credited_amount: '2500'
            }, {
                deployment_id: LEGACY_DEPLOYMENT, record_id: 'r-13', note_id: 13, chain_id: 1, contract_address: VAULT,
                destination: DESTINATION, credited_amount: null
            }],
            exit: {
                must_initiate_by: NOW_MS + 5 * DAY * 1000, near_expiry: true, bound_at_state: '0', state_fresh: true, escape_at: null,
                device_not_newest: false, lock: { mode: 'escape', since: NOW_MS, released: 1, exit_proofs_released: 1, releasable_after: null },
                exit_kit: { state_seq: 3, exported_seq: 3, out_of_date: false }, deposit_path_saved: true, exit_cost_warning: null,
                exit_rpc_url: null, exit_rpc_wrong_chain: false, exit_rpc_recommended: false
            }
        }
    });
    assert.deepEqual(normalized(concessionV1, snapshot), concessionFields({
        hasNote: true, expiryTs, deadlines: [{ source: 'slot', expiryTs }],
        sdkDepositsClosed: true,
        service: { available: false, code: 'deployment_manifest_unavailable', message: 'Deposits and new chats are paused.' },
        otherDeploymentWithdrawals: [
            { deploymentId: LEGACY_DEPLOYMENT, recordId: 'r-9', noteId: 9, mode: 'mutual', phase: 'parked' },
            { deploymentId: LEGACY_DEPLOYMENT, recordId: 'r-10', noteId: 10, mode: 'escape', phase: 'pending' }
        ],
        otherDeploymentCredits: [{
            deploymentId: LEGACY_DEPLOYMENT, recordId: 'r-11', noteId: 11, chainId: 1, contractAddress: VAULT,
            destination: DESTINATION, creditedAmount: '1500'
        }, {
            deploymentId: LEGACY_DEPLOYMENT, recordId: 'r-12', noteId: 12, chainId: 1, contractAddress: VAULT,
            destination: DESTINATION, creditedAmount: '2500'
        }, {
            deploymentId: LEGACY_DEPLOYMENT, recordId: 'r-13', noteId: 13, chainId: 1, contractAddress: VAULT,
            destination: DESTINATION, creditedAmount: null
        }],
        exit: {
            mustInitiateBy: NOW_MS + 5 * DAY * 1000, nearExpiry: true, lockHeld: true, kitOutOfDate: false, rpcRecommended: false,
            boundAtState: '0', stateFresh: true, escapeAt: null, deviceNotNewest: false,
            lock: { mode: 'escape', sinceMs: NOW_MS, released: 1, proofsReleased: 1, releasableAfterMs: null },
            kit: { stateSeq: 3, exportedSeq: 3, outOfDate: false },
            depositPathSaved: true, rpcWrongChain: false, costWarning: false
        }
    }));
});

test('concession: the shipped defaults of a fresh note are reported as they are', () => {
    const result = normalized(concessionV1, concessionClientSnapshot());
    assert.equal(result.sdkDepositsClosed, false);
    assert.deepEqual(result.service, { available: true, code: null, message: null });
    assert.deepEqual(result.exit, {
        mustInitiateBy: null, nearExpiry: false, lockHeld: false, kitOutOfDate: true, rpcRecommended: true,
        boundAtState: '0', stateFresh: true, escapeAt: null, deviceNotNewest: false, lock: null,
        kit: { stateSeq: 0, exportedSeq: null, outOfDate: true },
        depositPathSaved: false, rpcWrongChain: false, costWarning: false
    });
    assert.deepEqual(result.otherDeploymentWithdrawals, []);
    assert.deepEqual(result.otherDeploymentCredits, []);
    for (const key of Object.keys(CONCESSION_EXTRAS)) assert.deepEqual(result[key], CONCESSION_EXTRAS[key], key);
});

test('concession: malformed revision 3 fields fail toward the restrictive reading', () => {
    const odd = config => normalized(concessionV1, concessionClientSnapshot({ config }));
    // Unavailable unless the SDK says exactly true.
    assert.deepEqual(odd({ service: { available: 'yes', message: null } }).service, { available: false, code: null, message: null });
    assert.equal(odd({ service: 'down' }).service, null);
    assert.deepEqual(odd({ service: { available: false, message: 42 } }).service, { available: false, code: null, message: null });
    // The code is a machine word or nothing: operator text never becomes one.
    for (const code of ['deployment_manifest_mismatch', 'native_vault_unverified', 'x']) {
        assert.equal(odd({ service: { available: false, code } }).service.code, code);
    }
    for (const code of ['Deployment Manifest', 'has space', '1abc', '', 7, null, {}, `${'a'.repeat(65)}`, '<img src=x>']) {
        assert.equal(odd({ service: { available: false, code } }).service.code, null, String(code));
    }
    // A kit counts as current only when the SDK says it is not out of date.
    assert.equal(odd({ exit: { exit_kit: null } }).exit.kitOutOfDate, true);
    assert.equal(odd({ exit: { exit_kit: { out_of_date: false } } }).exit.kitOutOfDate, false);
    assert.equal(odd({ exit: { exit_kit: { out_of_date: 'no' } } }).exit.kitOutOfDate, true);
    assert.equal(odd({ exit: 'soon' }).exit, null);
    assert.equal(odd({ exit: { must_initiate_by: -4 } }).exit.mustInitiateBy, null);
    assert.equal(odd({ exit: { must_initiate_by: 'tomorrow' } }).exit.mustInitiateBy, null);
    assert.equal(odd({ deposits: 'open' }).sdkDepositsClosed, false);
    assert.equal(odd({ deposits: 'CLOSED' }).sdkDepositsClosed, false);
    // Non-object entries are dropped; partial entries keep what is valid.
    // The exit block never trusts a field's type.
    const exit = odd({ exit: {
        must_initiate_by: NOW_MS, near_expiry: 'true', state_fresh: 'yes', escape_at: 'later', device_not_newest: 1,
        bound_at_state: -5, deposit_path_saved: 'yes', exit_cost_warning: 'warn', exit_rpc_wrong_chain: 'no',
        lock: { mode: 'ESCAPE', since: -1, released: '2', exit_proofs_released: 1.5, releasable_after: 0 },
        exit_kit: { state_seq: '3', exported_seq: -1, out_of_date: 'no' }
    } }).exit;
    assert.deepEqual(exit, {
        mustInitiateBy: NOW_MS, nearExpiry: false, lockHeld: true, kitOutOfDate: true, rpcRecommended: false,
        boundAtState: null, stateFresh: null, escapeAt: null, deviceNotNewest: false,
        lock: { mode: null, sinceMs: null, released: 0, proofsReleased: 0, releasableAfterMs: null },
        kit: { stateSeq: null, exportedSeq: null, outOfDate: true },
        depositPathSaved: false, rpcWrongChain: false, costWarning: false
    });
    // An exit URL that may embed a key is never read, whatever it holds.
    const withUrl = odd({ exit: { exit_rpc_url: 'https://rpc.example/v3/SECRET', exit_rpc_recommended: false } }).exit;
    assert.doesNotMatch(JSON.stringify(withUrl), /SECRET|rpc\.example/);
    const others = odd({
        other_deployment_withdrawals: [null, 'x', { deployment_id: 5, record_id: '', note_id: -1, mode: 7, phase: null }],
        other_deployment_credits: [undefined, { contract_address: VAULT }]
    });
    assert.deepEqual(others.otherDeploymentWithdrawals, [{ deploymentId: null, recordId: null, noteId: null, mode: null, phase: null }]);
    assert.deepEqual(others.otherDeploymentCredits, [{
        deploymentId: null, recordId: null, noteId: null, chainId: null, contractAddress: VAULT, destination: null, creditedAmount: null
    }]);
});

// The exit rules and set-aside records carry epoch milliseconds. Unlike the
// deadlines the common normalizer builds, nothing compares these against a
// second source, so the reader itself rejects a value that cannot be an
// instant: a SDK that dropped the factor of 1000 must read as "not known", not
// as a date in January 1970 that a deadline notice would then print.
test('concession: an exit instant is epoch milliseconds or not known, whatever unit slip the SDK makes', () => {
    const instants = value => {
        const { exit } = normalized(concessionV1, concessionClientSnapshot({ config: { exit: {
            must_initiate_by: value, escape_at: value,
            lock: { mode: 'escape', since: value, releasable_after: value }
        } } }));
        return [exit.mustInitiateBy, exit.escapeAt, exit.lock.sinceMs, exit.lock.releasableAfterMs];
    };
    // Today, a far but plausible date, and the two bounds themselves.
    for (const value of [NOW_MS, NOW_MS + 400 * DAY * 1000, 1e11, 1e14]) {
        assert.deepEqual(instants(value), [value, value, value, value], String(value));
    }
    const refused = [
        NOW_SECONDS,                // seconds read as milliseconds: January 1970
        NOW_SECONDS + 400 * DAY,
        1e11 - 1, 1e14 + 1,
        NOW_MS * 1000,              // microseconds: year 58000
        1e300, Infinity, -Infinity, NaN,
        NOW_MS + 0.5,               // the SDK writes whole milliseconds
        -NOW_MS, 0,
        String(NOW_MS), BigInt(NOW_MS), true, {}, [], null, undefined
    ];
    for (const value of refused) {
        assert.deepEqual(instants(value), [null, null, null, null], `${typeof value}: ${String(value)}`);
    }

    // A set-aside record the SDK flags as near stays listed with no time: the
    // nudge to withdraw is kept, only the unusable instant is dropped.
    const parkedExpiry = NOW_SECONDS + 3 * DAY;
    const near = (extra) => normalized(concessionV1, concessionClientSnapshot({
        withdrawals: [{ ...withdrawalRecord(9, 'parked', { deploymentId: NEW_DEPLOYMENT }), exit_deadline_near: true, ...extra }],
        deposits: [depositRow(9, parkedExpiry, NEW_DEPLOYMENT)]
    })).setAsideNear;
    const recordId = withdrawalRecord(9, 'parked', { deploymentId: NEW_DEPLOYMENT }).recordId;
    assert.deepEqual(near({ expiry: parkedExpiry * 1000, must_initiate_by: (parkedExpiry - 43_200) * 1000 }),
        [{ recordId, mustInitiateByMs: (parkedExpiry - 43_200) * 1000, expiryMs: parkedExpiry * 1000 }]);
    assert.deepEqual(near({ expiry: parkedExpiry, must_initiate_by: parkedExpiry - 43_200 }),
        [{ recordId, mustInitiateByMs: null, expiryMs: null }]);
    assert.deepEqual(near({ expiry: parkedExpiry * 1000 * 1000, must_initiate_by: 12.5 }),
        [{ recordId, mustInitiateByMs: null, expiryMs: null }]);
});

test('concession: operator text is bounded and stripped of control characters', () => {
    const message = text => normalized(concessionV1, concessionClientSnapshot({ config: {
        service: { available: false, exits: true, code: 'x', message: text, detail: null }
    } })).service.message;
    assert.equal(message('  Paused\nfor   maintenance\t\u0007now. '), 'Paused for maintenance now.');
    assert.equal(message(`one${String.fromCharCode(0x2028)}two`), 'one two');
    // Markup stays plain text here and is escaped when rendered.
    assert.equal(message('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
    assert.equal(message('x'.repeat(1000)).length, SERVICE_MESSAGE_LIMIT);
    assert.equal(SERVICE_MESSAGE_LIMIT, 280);
    // Never split a surrogate pair.
    const emoji = String.fromCodePoint(0x1f600);
    const cut = message(`${'a'.repeat(SERVICE_MESSAGE_LIMIT - 1)}${emoji}${emoji}`);
    assert.equal(cut, 'a'.repeat(SERVICE_MESSAGE_LIMIT - 1));
    for (const empty of ['', '   ', '\n\t']) assert.equal(message(empty), null);
});

test('concession: set-aside records use the SDK deadline fields and the deposit rows', () => {
    const slotExpiry = NOW_SECONDS + 20 * DAY;
    const parkedExpiry = NOW_SECONDS + 7 * DAY;
    const restoredExpiry = NOW_SECONDS + 2 * DAY;
    const snapshot = concessionClientSnapshot({
        wallet: slotNote({ expiry_ts: slotExpiry }),
        withdrawals: [
            // Revision 3 snapshots add expiry and must_initiate_by (ms) to set-aside records.
            { ...withdrawalRecord(9, 'parked', { deploymentId: NEW_DEPLOYMENT }), expiry: parkedExpiry * 1000,
                must_initiate_by: (parkedExpiry - 43_200) * 1000, exit_deadline_near: false },
            { ...withdrawalRecord(12, 'restored', { deploymentId: NEW_DEPLOYMENT, mode: 'escape' }), expiry: restoredExpiry * 1000,
                must_initiate_by: (restoredExpiry - 43_200) * 1000, exit_deadline_near: true },
            { ...withdrawalRecord(10, 'pending', { deploymentId: NEW_DEPLOYMENT, mode: 'escape' }), challengeObserved: false }
        ],
        deposits: [depositRow(9, parkedExpiry, NEW_DEPLOYMENT)]
    });
    const result = normalized(concessionV1, snapshot);
    // Concession entries also say which record they are and whether this
    // device may still exit it; the slot entry is the plain pair.
    assert.deepEqual(result.deadlines, [
        { source: 'slot', expiryTs: slotExpiry },
        asideDeadline(restoredExpiry, withdrawalRecord(12, 'restored', { deploymentId: NEW_DEPLOYMENT }).recordId),
        asideDeadline(parkedExpiry, withdrawalRecord(9, 'parked', { deploymentId: NEW_DEPLOYMENT }).recordId)
    ]);
    assert.equal(result.hasOpenWithdrawal, true);
    // Only the restored record is within a week of its deadline.
    assert.deepEqual(result.setAsideNear, [{
        recordId: withdrawalRecord(12, 'restored', { deploymentId: NEW_DEPLOYMENT }).recordId,
        mustInitiateByMs: (restoredExpiry - 43_200) * 1000, expiryMs: restoredExpiry * 1000
    }]);
    // The legacy family reads the same snapshot and annotates nothing.
    assert.deepEqual(normalized(noteBoundV1, snapshot).deadlines, [
        { source: 'slot', expiryTs: slotExpiry },
        { source: 'set-aside', expiryTs: restoredExpiry },
        { source: 'set-aside', expiryTs: parkedExpiry }
    ]);
    // If the two sources disagree the earlier deadline is the one reported.
    const disagree = concessionClientSnapshot({
        withdrawals: [{ ...withdrawalRecord(9, 'parked', { deploymentId: NEW_DEPLOYMENT }), expiry: (NOW_SECONDS + 9 * DAY) * 1000 }],
        deposits: [depositRow(9, NOW_SECONDS + 4 * DAY, NEW_DEPLOYMENT)]
    });
    assert.deepEqual(normalized(concessionV1, disagree).deadlines,
        [asideDeadline(NOW_SECONDS + 4 * DAY, withdrawalRecord(9, 'parked', { deploymentId: NEW_DEPLOYMENT }).recordId)]);
});

// A record's own `expiry` (revision 3, milliseconds) and its raw note state are
// second sources for a set-aside deadline. Neither may ever produce a deadline
// that is not a positive safe integer, and neither may override the deposit
// row's expiry with something an order of magnitude earlier (a value under one
// second floors to 0; a unit change gives a 1970 date).
test('set-aside deadlines: a bogus record expiry never overrides the deposit row', () => {
    const joined = NOW_SECONDS + 7 * DAY;
    // The annotation (record id, device flag) is not what is under test here.
    const deadlinesOf = (adapter, record, deposits) => normalized(adapter, concessionClientSnapshot({
        withdrawals: [{ ...withdrawalRecord(9, 'parked', { deploymentId: NEW_DEPLOYMENT }), ...record }],
        deposits
    })).deadlines.map(({ source, expiryTs }) => ({ source, expiryTs }));
    const row = [depositRow(9, joined, NEW_DEPLOYMENT)];

    // Under one second: floors to 0, which is not a deadline.
    for (const expiry of [999, '999', 1, 0, '5', 1000 - 1]) {
        assert.deepEqual(deadlinesOf(concessionV1, { expiry }, row), [{ source: 'set-aside', expiryTs: joined }], String(expiry));
        assert.deepEqual(deadlinesOf(noteBoundV1, { expiry }, row), [{ source: 'set-aside', expiryTs: joined }], String(expiry));
    }
    // The SDK reporting seconds where milliseconds were expected: about 1970.
    assert.deepEqual(deadlinesOf(concessionV1, { expiry: joined }, row), [{ source: 'set-aside', expiryTs: joined }]);
    assert.deepEqual(deadlinesOf(concessionV1, { expiry: 5000 }, row), [{ source: 'set-aside', expiryTs: joined }]);
    // The raw note state is held to the same rule.
    assert.deepEqual(deadlinesOf(noteBoundV1, { state: { note_id: 9, expiry_ts: 12 } }, row),
        [{ source: 'set-aside', expiryTs: joined }]);
    // A believable disagreement still reports the earlier deadline.
    assert.deepEqual(deadlinesOf(concessionV1, { expiry: (joined - 3 * DAY) * 1000 }, row),
        [{ source: 'set-aside', expiryTs: joined - 3 * DAY }]);
    assert.deepEqual(deadlinesOf(concessionV1, { expiry: (joined + 3 * DAY) * 1000 }, row),
        [{ source: 'set-aside', expiryTs: joined }]);

    // No deposit row to compare with: the record's own expiry stands when it
    // is a real date, and a sub-second value is no deadline at all.
    assert.deepEqual(deadlinesOf(concessionV1, { expiry: joined * 1000 }, []), [{ source: 'set-aside', expiryTs: joined }]);
    assert.deepEqual(deadlinesOf(concessionV1, { expiry: 999 }, []), []);
    assert.deepEqual(deadlinesOf(concessionV1, { expiry: '5' }, []), []);
    const orphan = normalized(concessionV1, concessionClientSnapshot({
        withdrawals: [{ ...withdrawalRecord(9, 'parked', { deploymentId: NEW_DEPLOYMENT }), expiry: 999 }]
    }));
    assert.equal(orphan.hasOpenWithdrawal, true, 'the record is still an open withdrawal');
});

test('set-aside deadlines: fuzzed snapshots only ever yield positive safe integers, never an overridden row', () => {
    // Deterministic PRNG so a failure is reproducible.
    let seed = 0x2f6e2b1;
    const random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = list => list[Math.floor(random() * list.length)];
    const odd = [
        undefined, null, 0, -1, 1, 5, '5', 999, '999', 1000, 1999, 5000, 1.5, NaN, Infinity, -Infinity, '', 'x', ' 7 ',
        true, false, {}, [], [1], () => 1, NOW_SECONDS, NOW_MS, NOW_MS + 4 * DAY * 1000, String(NOW_MS),
        1e21, Number.MAX_SAFE_INTEGER, 2 ** 53, '9007199254740993', '99999999999999999999', 0.4, 1e-9
    ];
    const seconds = [
        undefined, null, 0, -5, 1, 17, '17', NOW_SECONDS - DAY, NOW_SECONDS + DAY, NOW_SECONDS + 9 * DAY,
        String(NOW_SECONDS + 5 * DAY), 1.5, NaN, 'soon', {}, true, 2 ** 53
    ];
    const phases = ['parked', 'restored', 'pending', 'closed', 'closed_unconfirmed', 'prepared', undefined];
    const valid = value => (typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]{1,16}$/.test(value) ? Number(value) : NaN);
    const validSeconds = value => {
        const number = valid(value);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    };
    let checked = 0;
    let joinedChecked = 0;
    for (let round = 0; round < 3000; round += 1) {
        const records = [];
        const deposits = [];
        const count = 1 + Math.floor(random() * 3);
        for (let index = 0; index < count; index += 1) {
            const noteId = pick([9, 10, 11, '12', 13]);
            const deploymentId = pick([LEGACY_DEPLOYMENT, NEW_DEPLOYMENT, null]);
            const record = {
                recordId: `r${round}-${index}`, deploymentId, noteId, mode: 'mutual', phase: pick(phases),
                expiry: pick(odd)
            };
            if (random() < 0.4) record.state = { note_id: noteId, expiry_ts: pick(seconds) };
            records.push(record);
            const rows = Math.floor(random() * 3);
            for (let row = 0; row < rows; row += 1) {
                deposits.push({ recordId: `d${round}-${index}-${row}`, deploymentId, noteId, expiryTs: pick(seconds) });
            }
        }
        const wallet = random() < 0.4 ? slotNote({ expiry_ts: pick(seconds) }) : { has_note: false, note: null };
        const snapshot = concessionClientSnapshot({ wallet, withdrawals: records, deposits });
        for (const adapter of ADAPTER_IDS.map(getAdapter)) {
            const result = adapter.normalizeSnapshot(snapshot, { nowMs: NOW_MS });
            const sources = result.deadlines.map(deadline => deadline.source);
            assert.ok(sources.every(source => source === 'slot' || source === 'set-aside'));
            assert.ok(sources.indexOf('slot') <= 0 && sources.filter(source => source === 'slot').length <= 1);
            for (const deadline of result.deadlines) {
                // Only the concession family annotates its set-aside entries.
                const annotated = adapter !== noteBoundV1 && deadline.source === 'set-aside';
                assert.deepEqual(Object.keys(deadline).sort(),
                    annotated ? ['deviceFlagged', 'expiryTs', 'recordId', 'source'] : ['expiryTs', 'source']);
                assert.ok(Number.isSafeInteger(deadline.expiryTs) && deadline.expiryTs > 0,
                    `deadline ${deadline.expiryTs} from ${JSON.stringify(snapshot)}`);
                if (annotated) {
                    assert.equal(typeof deadline.deviceFlagged, 'boolean');
                    assert.ok(deadline.recordId === null || typeof deadline.recordId === 'string');
                }
            }
            const aside = result.deadlines.filter(deadline => deadline.source === 'set-aside').map(deadline => deadline.expiryTs);
            assert.deepEqual(aside, [...aside].sort((left, right) => left - right));
            if (result.deadlines[0]?.source === 'slot') assert.equal(result.expiryTs, result.deadlines[0].expiryTs);
            checked += result.deadlines.length;
        }
        // One record at a time, the deposit-row expiry bounds the answer: the
        // deadline is never later than the row, and never more than an order
        // of magnitude earlier (a second source cannot override it).
        const [only] = records;
        const own = deposits.filter(row => row.deploymentId === only.deploymentId && String(row.noteId) === String(only.noteId));
        const rowExpiries = own.map(row => validSeconds(row.expiryTs)).filter(value => value !== null);
        if (count === 1 && rowExpiries.length && !wallet.has_note
            && ['parked', 'restored'].includes(only.phase) && validSeconds(only.noteId) !== null) {
            const joined = Math.min(...rowExpiries);
            for (const adapter of ADAPTER_IDS.map(getAdapter)) {
                const result = adapter.normalizeSnapshot(snapshot, { nowMs: NOW_MS });
                assert.equal(result.deadlines.length, 1);
                const [{ expiryTs }] = result.deadlines;
                assert.ok(expiryTs <= joined && expiryTs * 10 >= joined,
                    `${expiryTs} vs the deposit row ${joined}: ${JSON.stringify(snapshot)}`);
                joinedChecked += 1;
            }
        }
    }
    assert.ok(checked > 500 && joinedChecked > 100, `the fuzz exercised too little (${checked}, ${joinedChecked})`);
});

// The upstream fixture sdk/test/fixtures/v2c-store-snapshot.json is a dump of
// the store, not of a client snapshot. This is its content (trimmed of
// secrets and proofs) projected the way BrowserWalletRuntime.snapshot() would:
// records of the loaded deployment listed with state stripped and set-aside
// deadlines added, records of other deployments moved to config.
const UPSTREAM_NEW_ID = 'zkapi-native-eth-sepolia-concession-v1';
const UPSTREAM_OLD_ID = 'zkapi-native-eth-sepolia-note-bound-v1';
const UPSTREAM_STORE = {
    runtime: {
        deploymentId: UPSTREAM_NEW_ID,
        state: { note_id: 4, deposit_amount: 5000000, current_balance: 4975000, expiry_ts: 2000000000, bound_at_state: 1000000 },
        preparedWithdrawal: { mode: 'escape', phase: 'prepared', noteId: 4, destination: '0x3434343434343434343434343434343434343434', operationId: 'exit' },
        exitLock: { noteId: 4, anchor: '0xa2', mode: 'escape', since: 1799999000, released: [{ kind: 2 }, { kind: 0 }] },
        stateSeq: 3, exitKitExportedSeq: 2
    },
    withdrawals: [
        { recordId: `${UPSTREAM_NEW_ID}:11155111:0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2:3`, deploymentId: UPSTREAM_NEW_ID, chainId: 11155111,
            contractAddress: '0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2', noteId: 3, mode: 'escape', phase: 'pending', chainStatus: 'pending_withdrawal',
            destination: '0x3434343434343434343434343434343434343434', finalBalance: 800000, state: { note_id: 3, expiry_ts: 2000000000 }, revision: 1, updatedAt: 1800000000000 },
        { recordId: `${UPSTREAM_NEW_ID}:11155111:0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2:2`, deploymentId: UPSTREAM_NEW_ID, chainId: 11155111,
            contractAddress: '0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2', noteId: 2, mode: 'escape', phase: 'closed', chainStatus: 'closed',
            destination: '0x3434343434343434343434343434343434343434', finalBalance: 600000, payoutAlert: 'concession_exceeded_bound', revision: 1, updatedAt: 1800000000000 },
        { recordId: `${UPSTREAM_OLD_ID}:11155111:0x1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e:9`, deploymentId: UPSTREAM_OLD_ID, chainId: 11155111,
            contractAddress: '0x1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e', noteId: 9, mode: 'mutual', phase: 'parked', clearanceReserved: true,
            destination: '0x3434343434343434343434343434343434343434', finalBalance: 3000000, state: { note_id: 9, expiry_ts: 1990000000 }, revision: 1, updatedAt: 1800000000000 }
    ],
    deposits: [
        { recordId: `${UPSTREAM_NEW_ID}:deposit:4`, type: 'deposit', deploymentId: UPSTREAM_NEW_ID, noteId: 4, amount: 5000000, expiryTs: 2000000000, status: 'confirmed' },
        { recordId: `${UPSTREAM_NEW_ID}:deposit:3`, type: 'deposit', deploymentId: UPSTREAM_NEW_ID, noteId: 3, amount: 5000000, expiryTs: 2000000000, status: 'confirmed' },
        { recordId: `${UPSTREAM_OLD_ID}:deposit:9`, type: 'deposit', deploymentId: UPSTREAM_OLD_ID, noteId: 9, amount: 3000000, expiryTs: 1990000000, status: 'confirmed' }
    ]
};

function projectUpstreamStore(loadedDeployment, nowMs) {
    const own = record => record.deploymentId === loadedDeployment;
    const open = record => record.phase !== 'closed';
    const stripped = record => {
        const { state, preparedWithdrawal, proof, withdrawalNullifier, ...summary } = record;
        const setAside = ['parked', 'restored'].includes(record.phase) && state
            ? { expiry: state.expiry_ts * 1000, must_initiate_by: (state.expiry_ts - 43_200) * 1000, exit_deadline_near: false } : {};
        return { ...summary, ...setAside, challengeObserved: false };
    };
    const runtime = UPSTREAM_STORE.runtime.deploymentId === loadedDeployment ? UPSTREAM_STORE.runtime : null;
    return {
        config: {
            deposits: 'open',
            service: { available: true, exits: true, code: null, message: null, detail: null },
            other_deployment_withdrawals: UPSTREAM_STORE.withdrawals.filter(record => !own(record) && open(record)).map(record => ({
                deployment_id: record.deploymentId, record_id: record.recordId, note_id: record.noteId, mode: record.mode, phase: record.phase
            })),
            other_deployment_credits: [],
            pending_deposit: null,
            prepared_withdrawal: runtime?.preparedWithdrawal ? { mode: 'escape', phase: 'prepared', note_id: 4, destination: runtime.preparedWithdrawal.destination } : null,
            late_withdrawal_attempts: [],
            late_deposit_attempts: [],
            exit: {
                must_initiate_by: runtime ? (runtime.state.expiry_ts - 43_200) * 1000 : null,
                // The SDK's rule (zkapiExitPolicy.nearExpiry): a chat started now
                // could still be settling when the exit must start, that is
                // now + settlement window (21,905 s) + 4,500 s past
                // must_initiate_by. On mainnet that is 19 h 20 m before
                // expiry, not a round day.
                near_expiry: runtime
                    ? nowMs + (21_905 + 4_500) * 1000 > (runtime.state.expiry_ts - 43_200) * 1000 : false,
                lock: runtime?.exitLock ? { mode: runtime.exitLock.mode, since: runtime.exitLock.since * 1000 } : null,
                exit_kit: { state_seq: runtime?.stateSeq ?? 0, exported_seq: runtime?.exitKitExportedSeq ?? null,
                    out_of_date: (runtime?.exitKitExportedSeq ?? null) === null || runtime.exitKitExportedSeq < runtime.stateSeq },
                exit_rpc_recommended: true
            }
        },
        wallet: runtime ? { has_note: true, note: { note_id: runtime.state.note_id, expiry_ts: runtime.state.expiry_ts } } : { has_note: false, note: null },
        withdrawals: UPSTREAM_STORE.withdrawals.filter(own).map(stripped),
        deposits: UPSTREAM_STORE.deposits.filter(own)
    };
}

test('concession: the upstream store fixture normalizes as the loaded revision 3 deployment would report it', () => {
    const result = normalized(concessionV1, projectUpstreamStore(UPSTREAM_NEW_ID, 1_790_000_000_000));
    assert.deepEqual(result, concessionFields({
        hasNote: true,
        expiryTs: 2000000000,
        deadlines: [{ source: 'slot', expiryTs: 2000000000 }],
        hasPreparedWithdrawal: true,
        hasOpenWithdrawal: true,                      // the pending escape of note 3; the closed note 2 is not open
        otherDeploymentWithdrawals: [{
            deploymentId: UPSTREAM_OLD_ID, recordId: `${UPSTREAM_OLD_ID}:11155111:0x1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e:9`,
            noteId: 9, mode: 'mutual', phase: 'parked'
        }],
        service: { available: true, code: null, message: null },
        // The store dump above only has the fields its projection wrote; the
        // rest of the exit block takes its restrictive defaults.
        exit: {
            mustInitiateBy: (2000000000 - 43_200) * 1000, nearExpiry: false, lockHeld: true, kitOutOfDate: true, rpcRecommended: true,
            boundAtState: null, stateFresh: null, escapeAt: null, deviceNotNewest: false,
            lock: { mode: 'escape', sinceMs: 1799999000 * 1000, released: 0, proofsReleased: 0, releasableAfterMs: null },
            kit: { stateSeq: 3, exportedSeq: 2, outOfDate: true },
            depositPathSaved: false, rpcWrongChain: false, costWarning: false
        },
        // The closed note 2 carries the alert the SDK left on it.
        payoutAlerts: [`${UPSTREAM_NEW_ID}:11155111:0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2:2`]
    }));
});

test('legacy: the same store seen by the legacy build (its own deployment only)', () => {
    // The legacy build lists only its own deployment's records and reports
    // nothing about the other: its parked note is a set-aside deadline.
    const legacy = {
        config: legacyClientSnapshot().config,
        wallet: { has_note: false, note: null },
        withdrawals: UPSTREAM_STORE.withdrawals.filter(record => record.deploymentId === UPSTREAM_OLD_ID)
            .map(({ state, ...record }) => record),
        deposits: UPSTREAM_STORE.deposits.filter(record => record.deploymentId === UPSTREAM_OLD_ID)
    };
    assert.deepEqual(normalized(noteBoundV1, legacy), withFields({
        hasOpenWithdrawal: true, deadlines: [{ source: 'set-aside', expiryTs: 1990000000 }]
    }));
});

test('normalization is pure: it does not mutate the snapshot and is repeatable', () => {
    const snapshot = concessionClientSnapshot({
        wallet: slotNote(),
        withdrawals: [withdrawalRecord(9, 'parked')],
        deposits: [depositRow(9, NOW_SECONDS + 3 * DAY)],
        config: { service: { available: false, message: 'paused' } }
    });
    const before = JSON.stringify(snapshot);
    const first = normalized(concessionV1, snapshot);
    const second = normalized(concessionV1, snapshot);
    assert.equal(JSON.stringify(snapshot), before);
    assert.deepEqual(first, second);
    first.deadlines.push({ source: 'slot', expiryTs: 1 });
    assert.equal(normalized(concessionV1, snapshot).deadlines.length, 2);
});

// ---------------------------------------------------------------------------
// Active adapter
// ---------------------------------------------------------------------------

test('getActiveAdapter returns the installed version\'s adapter', () => {
    resetActiveVersionForTests();
    try {
        assert.equal(getActiveAdapter(), null);
        const table = resolvedTable(activatedRegistry(), 'mainnet');
        const select = version => ({
            version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {}, foreignDeploymentId: null,
            depositBlock: null, draftDiscarded: false, slotKind: 'note'
        });
        installActiveVersion({ table, version: table[1], selection: select(table[1]) });
        assert.equal(getActiveAdapter(), concessionV1);
        assert.equal(getActiveAdapter().callProfile.id, 'concession-v1');
        const exits = getActiveAdapter().callProfile.exits.map(exit => exit.selector);
        for (const legacySelector of noteBoundV1.callProfile.exits.map(exit => exit.selector)) {
            assert.ok(!exits.includes(legacySelector), `${legacySelector} is denied under the concession profile`);
        }
        resetActiveVersionForTests();
        installActiveVersion({ table, version: table[0], selection: select(table[0]) });
        assert.equal(getActiveAdapter(), noteBoundV1);
    } finally {
        resetActiveVersionForTests();
    }
});
