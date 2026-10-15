// Shared fixtures for the zkAPI version registry (registry model, loader,
// state, build and funding tests). Not a test file: the runner only collects
// *.test.mjs. Every function returns a fresh deep copy, so a test may mutate
// what it receives.
//
// Registries (all pass validateRegistry with validationOptions() unless noted):
//   validRegistry()          v1 active on both networks, v2 pending. The shape
//                            of deployments/zkapi/registry.json.
//   activatedRegistry()      the activation change: v1 exit-only, v2 active.
//   rollbackRegistry()       a rollback from activatedRegistry(): v1 active
//                            again, v2 exit-only. Forward-only permits it.
//   revertedRegistry()       a `git revert` of the activation: the same
//                            content as validRegistry(). Valid on its own;
//                            assertForwardOnly(activatedRegistry(),
//                            revertedRegistry()) throws.
//   partialRevertRegistry()  v1 stays exit-only, v2 back to pending. Valid on
//                            its own ("deposits unavailable"); also fails
//                            forward-only against activatedRegistry().
//   threeVersionRegistry()   v1 and v2 exit-only, v3 active (same family as
//                            v2), for N-version generalization.
//
// Profiles:
//   noteBoundProfile(network, mutate?)    the reviewed v1 profile (equal to
//                                         deployments/zkapi/<network>.json at
//                                         the time of writing)
//   concessionProfile(network, {slot, mutate}?)
//                                         a finalized-looking concession-v1
//                                         profile; slot 2 is v2, slot 3 is v3
//                                         (distinct deployment, vault, origin
//                                         and proxy path)
//   fixtureProfiles()                     { 'mainnet.json', 'sepolia.json' }
//
// Helpers:
//   validationOptions(overrides?)  options for validateRegistry: fixture
//                                  profiles, real adapters, every required
//                                  wiring name marked implemented
//   validate(registry, overrides?) validateRegistry with those options
//   resolvedTable(registry, network, overrides?)
//                                  resolveRuntimeTable with a real sha256
//   mutated(registry, fn)          deep copy, `fn(copy)` applied, copy returned
//   stuckEscapeNotice(overrides?)  a valid operator notice entry
//   normalizedSnapshot(overrides?) a NormalizedSnapshot with nothing to report
//   legacyClientSnapshot(overrides?) / concessionClientSnapshot(overrides?)
//                                  client snapshots of each SDK generation
//                                  (shapes read from the SDK sources)
//   NOW_MS, sha256Hex, ALL_WIRED
import { createHash } from 'node:crypto';
import { WIRED } from '../../chat/zkapi/versioning/wiring.mjs';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import concessionV1 from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { emptyNormalizedSnapshot } from '../../chat/zkapi/versioning/adapters/noteBoundV1.mjs';
import { resolveRuntimeTable, validateRegistry } from '../../chat/zkapi/versioning/registryModel.mjs';

export const NOW_MS = Date.parse('2026-11-15T12:00:00Z');
const FIXTURE_REVISION = '0123456789abcdef0123456789abcdef01234567';
export const ALL_WIRED = new Set(concessionV1.requiredWiring);
export { WIRED };

export const sha256Hex = text => createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const NETWORKS = ['mainnet', 'sepolia'];

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const NETWORK_FACTS = {
    mainnet: {
        chainId: 1,
        rpc: 'https://ethereum-rpc.publicnode.com',
        priceFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
    },
    sepolia: {
        chainId: 11155111,
        rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
        priceFeed: '0x694AA1769357215DE4FAC081bf1f309aDC325306'
    }
};

export function noteBoundProfile(network, mutate = null) {
    const facts = NETWORK_FACTS[network];
    const origin = `https://zkapi-${network}.openanonymity.ai`;
    const vaults = {
        mainnet: '0x4386FDbdA35D995beB3BF8625118Ec5982ec81fe',
        sepolia: '0x49fA19f9bdECe7A48Ebc7749fD69aD40F577590F'
    };
    const config = {
        deployment_manifest_url: `${origin}/config.json`,
        allowed_deployment_manifest_urls: [`${origin}/config.json`],
        trusted_deployment: {
            deployment_id: `zkapi-native-eth-${network}-note-bound-v1-fresh-20260930`,
            chain_id: facts.chainId,
            contract_address: vaults[network],
            billing_token_address: null,
            protocol_server_url: origin,
            indexer_url: origin,
            request_charge_cap: 50000,
            state_signing_key: { x: '0x2094c5f9e183a8aef5be682556a17aa4dbafdb03fd6e6a97d75a03efed2fe5a4', y: '0x11c7bbbeb288a09378e6721bd06ed5cc95b87046ff8cf6733e46ced0af1300d7' },
            clearance_signing_key: { x: '0x12d2b4547d9de0a359fc26abcf5e66cd359be83b53167850c9070540a8045cec', y: '0x11cc3f621d6d39b557b4bb64826ebaaeda04f98910f116e307d6650177dead82' },
            rpc_url: facts.rpc,
            billing_asset: 'native_eth',
            billing_unit: 'gwei',
            native_asset_wei_per_unit: '1000000000',
            native_price_feed_address: facts.priceFeed,
            native_price_feed_decimals: 8,
            native_price_max_age_seconds: 4500,
            request_proving_key_sha256: 'c894b261a13f571d0df36be29734aabf2a8cd7162baddc5e08a50341aa076584',
            withdrawal_proving_key_sha256: '8e41398092fdd02b9ff86c6ccbecbd7ce2402e6f22ec162e6124d1d04fe0a668',
            circuit_id: 'zkapi-v2-note-bound-v1',
            verifier_url: 'https://verifier2.openanonymity.ai',
            openrouter_inference_base: 'https://openrouter.ai/api/v1'
        },
        proving_keys_base_url: './proofs/',
        credits_per_usd: null,
        billing_token_symbol: 'ETH',
        billing_token_decimals: 9,
        require_oa_key_source: true,
        deployment_api_proxy_path: '/zkapi-deployment/'
    };
    if (mutate) mutate(config);
    return config;
}

const CONCESSION_SLOTS = {
    2: { suffix: 'v2c', proxyPath: '/zkapi-deployment-v2c/' },
    3: { suffix: 'v3c', proxyPath: '/zkapi-deployment-v3c/' }
};

export function concessionProfile(network, { slot = 2, mutate = null } = {}) {
    const facts = NETWORK_FACTS[network];
    const names = CONCESSION_SLOTS[slot];
    // Fixture hosts: the real operator hostnames are not known yet.
    const origin = `https://zkapi-${names.suffix}-${network}.example.test`;
    const hex = (digit, length) => digit.repeat(length);
    const config = {
        deployment_manifest_url: `${origin}/config.json`,
        allowed_deployment_manifest_urls: [`${origin}/config.json`],
        trusted_deployment: {
            deployment_status: 'deployed',
            deployment_id: `zkapi-native-eth-${network}-concession-v1-fixture-${names.suffix}`,
            chain_id: facts.chainId,
            contract_address: `0x${hex(String(slot), 40)}`,
            deploy_block: 1_000_000 + slot,
            billing_token_address: null,
            protocol_server_url: origin,
            indexer_url: origin,
            request_charge_cap: 50000,
            state_signing_key: { x: `0x${hex('1', 64)}`, y: `0x${hex('2', 64)}` },
            clearance_signing_key: { x: `0x${hex('3', 64)}`, y: `0x${hex('4', 64)}` },
            rpc_url: facts.rpc,
            billing_asset: 'native_eth',
            billing_unit: 'gwei',
            native_asset_wei_per_unit: '1000000000',
            native_price_feed_address: facts.priceFeed,
            native_price_feed_decimals: 8,
            native_price_max_age_seconds: 4500,
            circuit_id: 'zkapi-v2-concession-v1',
            setup_id: 'mpc-1',
            request_proving_key_sha256: hex('a', 64),
            withdrawal_proving_key_sha256: hex('b', 64),
            request_verifying_key_sha256: hex('c', 64),
            request_vk_keccak256: `0x${hex('d', 64)}`,
            withdrawal_vk_keccak256: `0x${hex('e', 64)}`,
            vault_runtime_codehash: `0x${hex('f', 64)}`,
            proof_adapter_address: `0x${hex('5', 40)}`,
            adapter_runtime_codehash: `0x${hex('6', 64)}`,
            poseidon_library_address: `0x${hex('7', 40)}`,
            poseidon_runtime_codehash: `0x${hex('8', 64)}`,
            challenge_period: network === 'mainnet' ? 172800 : 43200,
            note_ttl: 2592000,
            max_pause_duration: 3888000,
            settlement_window_seconds: 21905,
            vault_revision: 3,
            exit_concession: 1,
            clearance_ownership_proof: 'required',
            allow_dev_setup: false,
            canary: null,
            verifier_url: 'https://verifier2.openanonymity.ai',
            openrouter_inference_base: 'https://openrouter.ai/api/v1'
        },
        proving_keys_base_url: './proofs/',
        credits_per_usd: null,
        billing_token_symbol: 'ETH',
        billing_token_decimals: 9,
        require_oa_key_source: true,
        deployment_api_proxy_path: names.proxyPath
    };
    if (mutate) mutate(config);
    return config;
}

export function fixtureProfiles() {
    return { 'mainnet.json': noteBoundProfile('mainnet'), 'sepolia.json': noteBoundProfile('sepolia') };
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

const transition = () => ({ closeByMarginSeconds: 259200, reminderDays: [7, 3, 1], promptWindowDays: 14 });

export function validRegistry() {
    return {
        schema: 1,
        lineage: 'fresh-20260930',
        walletDatabase: 'zkapi-browser-wallet-{lineage}-{network}-v1',
        walletDatabaseVersion: 3,
        versions: [
            {
                id: 'v1', ordinal: 1, label: 'Version 1', adapter: 'note-bound-v1',
                circuitId: 'zkapi-v2-note-bound-v1', vaultRevision: 1,
                sdk: {
                    alias: '@openanonymity/zkapi-browser-sdk',
                    source: 'github:OpenAnonymity/zkapi#3342c95871e8422bb878ad40072687c241a68a5b',
                    revision: '3342c95871e8422bb878ad40072687c241a68a5b',
                    storeSha256: '8c3642ed85c77783d334f20f76c4ac378bd2cdd39571b886ae8f07463bf26215',
                    patches: ['wallet-recovery-v1', 'proof-cache-integrity-v1', 'provider-verification-v1'],
                    honorsDepositsFlag: false
                },
                publicPath: '/zkapi/', proxyPath: '/zkapi-deployment/',
                transition: transition(),
                gate: {
                    recoveryReview: { revision: '3342c95871e8422bb878ad40072687c241a68a5b', verdict: 'patched', patch: 'wallet-recovery-v1' },
                    protocolWiring: 'not_applicable', manifestSha256: null
                },
                networks: {
                    mainnet: { status: 'active', activatedAt: '2026-09-30T00:00:00Z', profile: 'mainnet.json' },
                    sepolia: { status: 'active', activatedAt: '2026-09-30T00:00:00Z', profile: 'sepolia.json' }
                }
            },
            {
                id: 'v2', ordinal: 2, label: 'Version 2', adapter: 'concession-v1',
                circuitId: 'zkapi-v2-concession-v1', vaultRevision: 3,
                sdk: { alias: 'zkapi-sdk-v2c', source: null, revision: null, storeSha256: null, patches: [], honorsDepositsFlag: true },
                publicPath: '/zkapi/v2c/', proxyPath: '/zkapi-deployment-v2c/',
                transition: transition(),
                gate: {
                    recoveryReview: { revision: null, verdict: 'pending', patch: null },
                    protocolWiring: 'pending', manifestSha256: null
                },
                networks: {
                    mainnet: { status: 'pending', config: { deployment_status: 'not_deployed' } },
                    sepolia: { status: 'pending', config: { deployment_status: 'not_deployed' } }
                }
            }
        ]
    };
}

const ACTIVATED_AT = '2026-11-01T00:00:00Z';

function activateConcessionRow(row, slot, activatedAt) {
    row.sdk = {
        alias: row.sdk.alias,
        source: `github:OpenAnonymity/zkapi#${FIXTURE_REVISION}`,
        revision: FIXTURE_REVISION,
        storeSha256: sha256Hex(`store-${row.id}`),
        patches: [],
        honorsDepositsFlag: true
    };
    row.gate = {
        recoveryReview: { revision: FIXTURE_REVISION, verdict: 'not_required', patch: null },
        protocolWiring: 'done',
        manifestSha256: sha256Hex(`manifest-${row.id}`)
    };
    for (const network of NETWORKS) {
        row.networks[network] = {
            status: 'active', activatedAt, config: concessionProfile(network, { slot })
        };
    }
}

function closeDeposits(row, since) {
    for (const network of NETWORKS) {
        row.networks[network].status = 'exit-only';
        row.networks[network].depositsClosedSince = since;
    }
}

export function activatedRegistry() {
    const registry = validRegistry();
    const [v1, v2] = registry.versions;
    closeDeposits(v1, ACTIVATED_AT);
    activateConcessionRow(v2, 2, ACTIVATED_AT);
    return registry;
}

export function rollbackRegistry() {
    const registry = activatedRegistry();
    const [v1, v2] = registry.versions;
    for (const network of NETWORKS) {
        v1.networks[network].status = 'active';
        delete v1.networks[network].depositsClosedSince;
        v2.networks[network].status = 'exit-only';
        v2.networks[network].depositsClosedSince = '2026-11-20T00:00:00Z';
    }
    return registry;
}

export function revertedRegistry() {
    return validRegistry();
}

export function partialRevertRegistry() {
    const registry = validRegistry();
    closeDeposits(registry.versions[0], ACTIVATED_AT);
    return registry;
}

export function threeVersionRegistry() {
    const registry = activatedRegistry();
    const [, v2] = registry.versions;
    for (const network of NETWORKS) {
        v2.networks[network].status = 'exit-only';
        v2.networks[network].depositsClosedSince = '2026-12-01T00:00:00Z';
    }
    const v3 = {
        id: 'v3', ordinal: 3, label: 'Version 3', adapter: 'concession-v1',
        circuitId: 'zkapi-v2-concession-v1', vaultRevision: 3,
        sdk: { alias: 'zkapi-sdk-v3c', source: null, revision: null, storeSha256: null, patches: [], honorsDepositsFlag: true },
        publicPath: '/zkapi/v3c/', proxyPath: '/zkapi-deployment-v3c/',
        transition: transition(),
        gate: { recoveryReview: { revision: null, verdict: 'pending', patch: null }, protocolWiring: 'pending', manifestSha256: null },
        networks: {}
    };
    activateConcessionRow(v3, 3, '2026-12-01T00:00:00Z');
    // Distinct pins for the third deployment, as a real second re-cut would carry.
    v3.sdk.revision = 'fedcba9876543210fedcba9876543210fedcba98';
    v3.sdk.source = `github:OpenAnonymity/zkapi#${v3.sdk.revision}`;
    v3.gate.recoveryReview.revision = v3.sdk.revision;
    registry.versions.push(v3);
    return registry;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function validationOptions(overrides = {}) {
    return {
        profiles: fixtureProfiles(),
        adapters: getAdapter,
        wired: ALL_WIRED,
        lineage: 'fresh-20260930',
        ...overrides
    };
}

export function validate(registry, overrides = {}) {
    return validateRegistry(registry, validationOptions(overrides));
}

export function resolvedTable(registry, network, overrides = {}) {
    return resolveRuntimeTable(registry, network, { profiles: fixtureProfiles(), sha256: sha256Hex, ...overrides });
}

export function mutated(registry, mutate) {
    const copy = clone(registry);
    mutate(copy);
    return copy;
}

export function stuckEscapeNotice(overrides = {}) {
    return {
        kind: 'stuck_escape',
        noteId: 7,
        destination: `0x${'9'.repeat(40)}`,
        expiresAt: '2027-01-01T00:00:00Z',
        text: 'This escape cannot finalize until its destination accepts ETH.',
        ...overrides
    };
}

export function normalizedSnapshot(overrides = {}) {
    return { ...emptyNormalizedSnapshot(), ...overrides };
}

// Client snapshot shapes (ZkapiClient.snapshot()): config comes from
// BrowserWalletRuntime.snapshot().config, wallet from the proof worker's
// walletStatus(). Both generations share the keys below; the revision 3 SDK
// adds the config fields built by concessionClientSnapshot.
export function legacyClientSnapshot(overrides = {}) {
    return {
        config: {
            ux_proposal: 'quiet',
            request_charge_cap: 50000,
            browser_wallet: true,
            active_lease: null,
            prepared_withdrawal: null,
            funding: { chain_id: 1, billing_asset: 'native_eth' },
            late_withdrawal_attempts: [],
            late_deposit_attempts: [],
            pending_deposit: null,
            ...(overrides.config || {})
        },
        wallet: { has_note: false, pending_request: false, note: null },
        walletAddress: null,
        withdrawal: null,
        withdrawals: [],
        deposits: [],
        challengePeriodSeconds: 86400,
        loading: false,
        lastError: null,
        initialized: true,
        activities: [],
        ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'config'))
    };
}

export function concessionClientSnapshot(overrides = {}) {
    const base = legacyClientSnapshot({ config: {
        deposits: 'open',
        service: { available: true, exits: true, code: null, message: null, detail: null },
        other_deployment_withdrawals: [],
        other_deployment_credits: [],
        vault_revision: 3,
        exit: {
            must_initiate_by: null,
            near_expiry: false,
            bound_at_state: '0',
            state_fresh: true,
            escape_at: null,
            device_not_newest: false,
            lock: null,
            exit_kit: { state_seq: 0, exported_seq: null, out_of_date: true },
            deposit_path_saved: false,
            exit_cost_warning: null,
            exit_rpc_url: null,
            exit_rpc_wrong_chain: false,
            exit_rpc_recommended: true
        },
        unresolved_requests: [],
        last_settlement: null,
        ...(overrides.config || {})
    } });
    return {
        ...base,
        ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'config'))
    };
}
