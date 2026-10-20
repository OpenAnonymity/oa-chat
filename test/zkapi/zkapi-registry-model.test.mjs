import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ADAPTER_IDS, getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { WIRED } from '../../chat/zkapi/versioning/wiring.mjs';
import {
    RegistryError,
    REGISTRY_NETWORKS,
    assertForwardOnly,
    depositTarget,
    emittedConfig,
    liveVersions,
    parseTimestamp,
    resolveRuntimeTable,
    serializeConfig,
    validateRegistry,
    versionForDeployment,
    walletDatabaseName
} from '../../chat/zkapi/versioning/registryModel.mjs';
import {
    ALL_WIRED,
    activatedRegistry,
    concessionProfile,
    fixtureProfiles,
    mutated,
    noteBoundProfile,
    partialRevertRegistry,
    resolvedTable,
    revertedRegistry,
    rollbackRegistry,
    sha256Hex,
    stuckEscapeNotice,
    threeVersionRegistry,
    validRegistry,
    validate,
    validationOptions
} from './_registryFixtures.mjs';

const root = new URL('../../', import.meta.url);
const readText = relative => fs.readFileSync(new URL(relative, root), 'utf8');
const NETWORKS = ['mainnet', 'sepolia'];
const ZERO_REVISION = '0'.repeat(40);

// assertForwardOnly reads the identity of a profile-file row from the profiles
// each side was committed with. Every fixture registry names the reviewed v1
// profile files, so by default both sides carry the fixture copies.
const forwardOnly = (base, next, options = {}) => assertForwardOnly(base, next,
    { baseProfiles: fixtureProfiles(), nextProfiles: fixtureProfiles(), ...options });

function rejects(registry, code, pattern = null, overrides = {}) {
    assert.throws(() => validate(registry, overrides), error => {
        assert.ok(error instanceof RegistryError, `expected a RegistryError, got ${error}`);
        assert.equal(error.code, code, error.message);
        if (pattern) assert.match(error.message, pattern);
        return true;
    });
}

// ---------------------------------------------------------------------------
// The shipped registry
// ---------------------------------------------------------------------------

test('the shipped registry validates: v3 active and older versions exit-only on Sepolia; mainnet unchanged', () => {
    const registry = JSON.parse(readText('deployments/zkapi/registry.json'));
    const profiles = {
        'mainnet.json': JSON.parse(readText('deployments/zkapi/mainnet.json')),
        'sepolia.json': JSON.parse(readText('deployments/zkapi/sepolia.json'))
    };
    assert.equal(validateRegistry(registry, { profiles, adapters: getAdapter, lineage: 'fresh-20260930', wired: WIRED }), registry);
    // Same formatting as the other deployments files.
    assert.equal(readText('deployments/zkapi/registry.json'), `${JSON.stringify(registry, null, 2)}\n`);

    for (const network of NETWORKS) {
        const profile = profiles[`${network}.json`];
        const table = resolveRuntimeTable(registry, network, { profiles, sha256: sha256Hex });
        const activated = network === 'sepolia';
        // Mainnet: v2 is pending and not in the table, so no probe, facade or UI follows from it.
        assert.deepEqual(liveVersions(registry, network).map(row => row.id), activated ? ['v1', 'v2', 'v3', 'v4'] : ['v1']);
        assert.deepEqual(table.map(version => version.id), activated ? ['v1', 'v2', 'v3', 'v4'] : ['v1']);
        assert.equal(depositTarget(registry, network).id, activated ? 'v4' : 'v1');
        const [v1] = table;
        assert.equal(v1.deploymentId, profile.trusted_deployment.deployment_id);
        assert.equal(v1.chainId, profile.trusted_deployment.chain_id);
        assert.equal(v1.vault, profile.trusted_deployment.contract_address.toLowerCase());
        assert.equal(v1.status, activated ? 'exit-only' : 'active');
        assert.equal(v1.depositsOpen, !activated);
        assert.equal(v1.assetBase, 'zkapi/');
        assert.equal(v1.proxyPath, '/zkapi-deployment/');
        // The legacy SDK ignores the deposits flag, so the emitted config is the
        // reviewed file, byte for byte.
        assert.equal(v1.configSha256, sha256Hex(readText(`deployments/zkapi/${network}.json`)));
        assert.equal(walletDatabaseName(registry, network), `zkapi-browser-wallet-fresh-20260930-${network}-v1`);
        if (activated) {
            const v2 = table[1];
            assert.equal(v2.status, 'exit-only');
            assert.equal(v2.depositsOpen, false);
            const v3 = table[2];
            assert.equal(v3.status, 'exit-only');
            assert.equal(v3.depositsOpen, false);
            const v4 = table[3];
            assert.equal(v4.status, 'active');
            assert.equal(v4.depositsOpen, true);
            assert.equal(v4.vault, '0x67eb750d9c0d63a99684ac3f3e65f0c610276993');
            assert.equal(v4.proxyPath, '/zkapi-deployment-v4/');
            assert.equal(v4.assetBase, 'zkapi/v4/');
            assert.equal(v3.vault, '0x7ff4ba0662a8218d0954c1a11ae61df6c3548ea4');
            assert.equal(v3.proxyPath, '/zkapi-deployment-v3/');
            assert.equal(v3.assetBase, 'zkapi/v3/');
            assert.equal(v2.proxyPath, '/zkapi-deployment-v2c/');
            assert.equal(v2.assetBase, 'zkapi/v2c/');
        }
    }
    const [v1, v2] = registry.versions;
    assert.equal(v1.networks.mainnet.activatedAt, '2026-09-30T00:00:00Z');
    assert.equal(v1.networks.sepolia.activatedAt, '2026-09-30T00:00:00Z');
    assert.equal(v1.networks.sepolia.status, 'exit-only');
    assert.equal(v2.networks.sepolia.status, 'exit-only');
    assert.equal(registry.versions[2].networks.sepolia.status, 'exit-only');
    assert.equal(registry.versions[3].networks.sepolia.status, 'active');
    assert.equal(registry.versions[3].networks.mainnet.status, 'pending');
    assert.equal(registry.versions[2].networks.mainnet.status, 'pending');
    assert.equal(v2.networks.mainnet.status, 'pending');
    assert.deepEqual(v2.networks.mainnet.config, { deployment_status: 'not_deployed' });
    assert.equal(v2.sdk.alias, 'zkapi-sdk-v2c');
    assert.equal(v2.publicPath, '/zkapi/v2c/');
    assert.equal(v2.proxyPath, '/zkapi-deployment-v2c/');
});

test('the shipped registry differs from the fixture only by the Sepolia activation, and v2 mainnet still cannot go live', () => {
    const shipped = JSON.parse(readText('deployments/zkapi/registry.json'));
    const fixture = validRegistry();
    // Everything of mainnet is the dormant fixture's.
    assert.deepEqual(shipped.versions[0].networks.mainnet, fixture.versions[0].networks.mainnet);
    assert.deepEqual(shipped.versions[1].networks.mainnet, fixture.versions[1].networks.mainnet);
    // The host wiring of the successor family is implemented, so a perfect
    // activation passes the wiring gate with the checked-in set...
    validate(activatedRegistry(), { wired: WIRED });
    // ...and the shipped mainnet row is held back by what it still lacks:
    // flipping its status alone is refused, first for the activation time it
    // lacks, then, given one, for the profile it does not have.
    const flipped = withActivation => mutated(shipped, registry => {
        registry.versions[1].networks.mainnet.status = 'active';
        if (withActivation) registry.versions[1].networks.mainnet.activatedAt = '2026-11-01T00:00:00Z';
    });
    rejects(flipped(false), 'activation_time', null, { wired: WIRED });
    rejects(flipped(true), 'profile', /not_deployed placeholder/, { wired: WIRED });
    // The recorded gates of the activated Sepolia row.
    const [, v2] = shipped.versions;
    assert.equal(v2.sdk.source, `github:OpenAnonymity/zkapi#${v2.sdk.revision}`);
    assert.match(v2.sdk.revision, /^[0-9a-f]{40}$/);
    assert.match(v2.sdk.storeSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(v2.sdk.patches, ['wallet-recovery-v2c', 'provider-verification-v2c']);
    assert.deepEqual(v2.gate.recoveryReview, { revision: v2.sdk.revision, verdict: 'not_required', patch: null });
    assert.equal(v2.gate.protocolWiring, 'done');
    assert.match(v2.gate.manifestSha256, /^[0-9a-f]{64}$/);
});

test('v2 stays pending because each of its other gates refuses on its own, with the host wiring in place', () => {
    // Every case starts from a registry that passes every gate with the
    // production wiring set and takes away exactly one thing.
    validate(activatedRegistry(), { wired: WIRED });
    const without = (code, pattern, mutate) => rejects(
        mutated(activatedRegistry(), registry => mutate(registry.versions[1])), code, pattern, { wired: WIRED }
    );
    // The SDK pins: source and revision, or the wallet store hash.
    without('sdk_pin', /not all pinned/, row => {
        row.sdk.source = null;
        row.sdk.revision = null;
    });
    without('sdk_pin', /not all pinned/, row => { row.sdk.storeSha256 = null; });
    // A deployed profile, not the placeholder.
    without('profile', /not_deployed placeholder/, row => {
        for (const network of NETWORKS) row.networks[network].config = { deployment_status: 'not_deployed' };
    });
    // The finalized manifest hash the profile was generated from.
    without('gate_manifest', /manifest hash is missing/, row => { row.gate.manifestSha256 = null; });
    // The recovery review: complete, and for the revision that is pinned.
    without('gate_recovery_review', /not complete/, row => { row.gate.recoveryReview.verdict = 'pending'; });
    without('gate_recovery_review', /another SDK revision/, row => { row.gate.recoveryReview.revision = 'f'.repeat(40); });
    // The row's own record that its wiring was reviewed is a gate of its own,
    // apart from the host's set.
    without('gate_wiring', /protocol wiring is not complete/, row => { row.gate.protocolWiring = 'pending'; });
    // And the host's set needs every name, so one missing behavior is enough.
    for (const name of getAdapter('concession-v1').requiredWiring) {
        const missing = new Set([...WIRED].filter(wired => wired !== name));
        rejects(activatedRegistry(), 'gate_wiring', /wiring is not implemented/, { wired: missing });
    }
});

// ---------------------------------------------------------------------------
// Schema and the fixtures themselves
// ---------------------------------------------------------------------------

test('every fixture registry is valid on its own', () => {
    for (const make of [validRegistry, activatedRegistry, rollbackRegistry, revertedRegistry, partialRevertRegistry,
        threeVersionRegistry]) {
        validate(make());
    }
});

test('unknown fields are refused at every level', () => {
    const cases = [
        registry => { registry.extra = 1; },
        registry => { registry.versions[0].deploymentId = 'x'; },
        registry => { registry.versions[0].sdk.extra = 1; },
        registry => { registry.versions[0].gate.extra = 1; },
        registry => { registry.versions[0].gate.recoveryReview.extra = 1; },
        registry => { registry.versions[0].transition.extra = 1; },
        registry => { registry.versions[0].networks.mainnet.depositClosedSince = '2026-11-01T00:00:00Z'; },
        registry => { registry.versions[0].networks.other = registry.versions[0].networks.mainnet; }
    ];
    for (const mutate of cases) rejects(mutated(validRegistry(), mutate), 'schema');
});

test('timestamps must name a zone and a real calendar day', () => {
    assert.equal(parseTimestamp('2026-09-30T00:00:00Z'), Date.UTC(2026, 8, 30));
    assert.equal(parseTimestamp('2026-09-30T02:00:00+02:00'), Date.UTC(2026, 8, 30));
    for (const value of ['2026-09-30', '2026-09-30T00:00:00', '2026-02-31T00:00:00Z', '2026-13-01T00:00:00Z',
        '2026-09-30T24:00:00Z', 'not a date', 1790000000, null, undefined]) {
        assert.equal(parseTimestamp(value), null, String(value));
    }
    rejects(mutated(validRegistry(), registry => {
        registry.versions[0].networks.mainnet.activatedAt = '2026-02-31T00:00:00Z';
    }), 'schema');
});

// ---------------------------------------------------------------------------
// Lineage, ordinals, ids
// ---------------------------------------------------------------------------

test('lineage and ids: lineage must equal the accepted deployment and ids and ordinals are unique', () => {
    rejects(validRegistry(), 'lineage', null, { lineage: 'fresh-20260101' });
    rejects(mutated(validRegistry(), registry => { registry.lineage = 'Fresh_2026'; }), 'lineage');
    rejects(mutated(validRegistry(), registry => { registry.versions[1].ordinal = 1; }), 'ordinal');
    rejects(mutated(validRegistry(), registry => { registry.versions.reverse(); }), 'ordinal');
    rejects(mutated(validRegistry(), registry => { registry.versions[1].id = 'v1'; }), 'duplicate_id');
    rejects(mutated(validRegistry(), registry => { registry.versions[1].sdk.alias = registry.versions[0].sdk.alias; }),
        'duplicate_alias');
});

// ---------------------------------------------------------------------------
// Lifecycle fields
// ---------------------------------------------------------------------------

test('lifecycle: at most one active version per network; the rollback shapes are legal', () => {
    const twoActive = mutated(activatedRegistry(), registry => {
        registry.versions[0].networks.mainnet.status = 'active';
        delete registry.versions[0].networks.mainnet.depositsClosedSince;
    });
    rejects(twoActive, 'multiple_active', /mainnet/);
    // A newer version reopened next to an active older one is two actives too.
    rejects(mutated(rollbackRegistry(), registry => {
        registry.versions[1].networks.sepolia.status = 'active';
        delete registry.versions[1].networks.sepolia.depositsClosedSince;
    }), 'multiple_active', /sepolia/);
    // v2 active while the newer v3 is exit-only, and v1 active while both newer
    // versions are exit-only, are the rollback states the lifecycle admits.
    validate(mutated(threeVersionRegistry(), registry => {
        registry.versions[1].networks.mainnet.status = 'active';
        delete registry.versions[1].networks.mainnet.depositsClosedSince;
        registry.versions[2].networks.mainnet.status = 'exit-only';
        registry.versions[2].networks.mainnet.depositsClosedSince = '2026-12-02T00:00:00Z';
    }));
    validate(mutated(threeVersionRegistry(), registry => {
        registry.versions[0].networks.mainnet.status = 'active';
        delete registry.versions[0].networks.mainnet.depositsClosedSince;
        registry.versions[2].networks.mainnet.status = 'exit-only';
        registry.versions[2].networks.mainnet.depositsClosedSince = '2026-12-02T00:00:00Z';
    }));
    // Zero active versions is a legal state: deposits are unavailable.
    validate(partialRevertRegistry());
});

test('lifecycle: pending rows carry no activation time and a placeholder, live rows an activation time', () => {
    rejects(mutated(validRegistry(), registry => {
        registry.versions[1].networks.mainnet.activatedAt = '2026-09-30T00:00:00Z';
    }), 'activation_time');
    rejects(mutated(validRegistry(), registry => {
        registry.versions[1].networks.mainnet.config = { trusted_deployment: { deployment_id: 'x' } };
    }), 'pending_shape');
    rejects(mutated(validRegistry(), registry => {
        delete registry.versions[0].networks.mainnet.activatedAt;
    }), 'activation_time');
    rejects(mutated(validRegistry(), registry => {
        registry.versions[1].networks.mainnet.profile = 'mainnet.json';
    }), 'status_fields');
    // A placeholder cannot be promoted by changing only the status.
    rejects(mutated(validRegistry(), registry => {
        registry.versions[1].networks.mainnet.status = 'active';
        registry.versions[1].networks.mainnet.activatedAt = '2026-11-01T00:00:00Z';
    }), 'profile');
});

test('lifecycle: exit-only needs depositsClosedSince, retired needs retiredAt and a tombstone', () => {
    rejects(mutated(activatedRegistry(), registry => {
        delete registry.versions[0].networks.mainnet.depositsClosedSince;
    }), 'exit_only_fields');
    rejects(mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.mainnet.depositsClosedSince = '2026-11-02T00:00:00Z';
    }), 'status_fields');
    rejects(mutated(activatedRegistry(), registry => {
        registry.versions[0].networks.mainnet.depositsClosedSince = '2026-01-01T00:00:00Z';
    }), 'activation_time');
    const retire = mutate => mutated(threeVersionRegistry(), registry => {
        const entry = registry.versions[0].networks.mainnet;
        delete entry.profile;
        entry.status = 'retired';
        entry.retiredAt = '2027-03-01T00:00:00Z';
        entry.tombstone = {
            deploymentId: 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930',
            chainId: 1,
            vault: '0x4386FDbdA35D995beB3BF8625118Ec5982ec81fe'
        };
        if (mutate) mutate(entry);
    });
    validate(retire());
    rejects(retire(entry => { delete entry.retiredAt; }), 'retired_fields');
    rejects(retire(entry => { delete entry.tombstone; }), 'schema');
    rejects(retire(entry => { delete entry.tombstone.vault; }), 'retired_fields');
    rejects(retire(entry => { entry.tombstone.chainId = 0; }), 'retired_fields');
    rejects(retire(entry => { entry.tombstone.vault = '0x1234'; }), 'retired_fields');
    rejects(retire(entry => { entry.tombstone.extra = 1; }), 'schema');
    rejects(retire(entry => { entry.profile = 'mainnet.json'; }), 'status_fields');
    rejects(retire(entry => { entry.retiredAt = '2026-01-01T00:00:00Z'; }), 'activation_time');
    rejects(mutated(validRegistry(), registry => {
        registry.versions[0].networks.mainnet.retiredAt = '2027-03-01T00:00:00Z';
    }), 'status_fields');
});

test('lifecycle: a tombstone names the chain of its own network', () => {
    const retire = (network, chainId) => mutated(threeVersionRegistry(), registry => {
        const entry = registry.versions[0].networks[network];
        delete entry.profile;
        entry.status = 'retired';
        entry.retiredAt = '2027-03-01T00:00:00Z';
        entry.tombstone = {
            deploymentId: noteBoundProfile(network).trusted_deployment.deployment_id,
            chainId,
            vault: noteBoundProfile(network).trusted_deployment.contract_address
        };
    });
    validate(retire('mainnet', 1));
    validate(retire('sepolia', 11155111));
    // Another chain's id would stop the leftovers of the version being recognized.
    rejects(retire('mainnet', 5), 'retired_fields', /chain/);
    rejects(retire('mainnet', 11155111), 'retired_fields', /chain/);
    rejects(retire('sepolia', 1), 'retired_fields', /chain/);
    rejects(retire('sepolia', 5), 'retired_fields', /sepolia/);

    // A network this model has no fixed chain for must agree with its live rows.
    const adapter = {
        id: 'note-bound-v1', circuitId: 'zkapi-v2-note-bound-v1', vaultRevision: 1, requiredWiring: [],
        validateProfile() {}
    };
    const pins = chainId => ({
        deployment_id: 'dev-v1', chain_id: chainId, contract_address: `0x${'a'.repeat(40)}`, circuit_id: 'zkapi-v2-note-bound-v1',
        protocol_server_url: 'https://dev.example.test', openrouter_inference_base: 'https://openrouter.ai/api/v1',
        request_charge_cap: 1
    });
    const devnet = tombstoneChain => {
        const base = validRegistry();
        const [v1, v2] = base.versions;
        v1.networks = { devnet: { status: 'active', activatedAt: '2026-09-30T00:00:00Z', config: { trusted_deployment: pins(31337) } } };
        v2.networks = { devnet: { status: 'retired', activatedAt: '2026-09-30T00:00:00Z', retiredAt: '2027-03-01T00:00:00Z',
            tombstone: { deploymentId: 'dev-old', chainId: tombstoneChain, vault: `0x${'b'.repeat(40)}` } } };
        v2.adapter = 'note-bound-v1';
        v2.circuitId = 'zkapi-v2-note-bound-v1';
        v2.vaultRevision = 1;
        return base;
    };
    const options = { adapters: () => adapter, networks: ['devnet'], wired: ALL_WIRED, lineage: 'fresh-20260930' };
    validateRegistry(devnet(31337), options);
    assert.throws(() => validateRegistry(devnet(1), options), error => error.code === 'retired_fields');
});

// A network where every row is retired or pending has nothing to load: its
// runtime table would be empty or tombstones-only, and the boot reads an empty
// table as "no registry" (the legacy SDK defaults).
test('lifecycle: a network with no live version is refused', () => {
    const retireV1 = network => registry => {
        const entry = registry.versions[0].networks[network];
        delete entry.profile;
        entry.status = 'retired';
        entry.retiredAt = '2027-03-01T00:00:00Z';
        entry.tombstone = {
            deploymentId: noteBoundProfile(network).trusted_deployment.deployment_id,
            chainId: network === 'mainnet' ? 1 : 11155111,
            vault: noteBoundProfile(network).trusted_deployment.contract_address
        };
    };
    // v1 retired, v2 still pending: the review's repro.
    const retiredAndPending = mutated(validRegistry(), retireV1('mainnet'));
    rejects(retiredAndPending, 'no_live_version', /mainnet/);
    rejects(mutated(validRegistry(), retireV1('sepolia')), 'no_live_version', /sepolia/);
    // The runtime table must not paper over it either: tombstones only is not a table.
    assert.throws(() => resolvedTable(retiredAndPending, 'mainnet'),
        error => error instanceof RegistryError && error.code === 'no_live_version');
    // Every row pending (a whole network not deployed) resolves to [] otherwise.
    const allPending = mutated(validRegistry(), registry => {
        const entry = registry.versions[0].networks.sepolia;
        delete entry.profile;
        delete entry.activatedAt;
        entry.status = 'pending';
        entry.config = { deployment_status: 'not_deployed' };
    });
    rejects(allPending, 'no_live_version', /sepolia/);
    assert.throws(() => resolvedTable(allPending, 'sepolia'),
        error => error instanceof RegistryError && error.code === 'no_live_version');
    // The other network is untouched, and any live row (active or exit-only) is enough.
    assert.deepEqual(resolvedTable(allPending, 'mainnet').map(version => version.id), ['v1']);
    validate(partialRevertRegistry());
    assert.deepEqual(resolvedTable(partialRevertRegistry(), 'mainnet').map(version => version.status), ['exit-only']);
    // Retiring the old version once its successor is live is still the normal path.
    validate(mutated(activatedRegistry(), retireV1('mainnet')));
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

test('profile: the shared base refuses a profile that does not match its row or the pinned origins', () => {
    const v1Profile = (mutate) => ({ profiles: {
        'mainnet.json': noteBoundProfile('mainnet', mutate), 'sepolia.json': noteBoundProfile('sepolia')
    } });
    const bad = [
        [config => { config.deployment_api_proxy_path = '/zkapi-deployment-v2c/'; }, /routes/],
        [config => { config.trusted_deployment.rpc_url = 'http://insecure.example.test'; }, /credential-free/],
        [config => { config.trusted_deployment.rpc_url = 'https://rpc.example.test/v1/SECRET'; }, /credential-free/],
        [config => { config.trusted_deployment.verifier_url = 'https://user:pw@verifier.example.test'; }, /credential-free/],
        [config => { config.trusted_deployment.verifier_url = null; }, /credential-free/],
        [config => { config.trusted_deployment.openrouter_inference_base = 'https://evil.example.test/api/v1'; }, /OpenRouter/],
        [config => { config.require_oa_key_source = false; }, /verified OA/],
        [config => { config.trusted_deployment.chain_id = 11155111; }, /selected network/],
        [config => { config.trusted_deployment.circuit_id = 'zkapi-v2-concession-v1'; }, /proof circuit/]
    ];
    for (const [mutate, pattern] of bad) rejects(validRegistry(), 'profile', pattern, v1Profile(mutate));
    // The row's proxyPath, not a fixed string, is what the profile must name.
    rejects(mutated(validRegistry(), registry => { registry.versions[0].proxyPath = '/other-proxy/'; }), 'profile', /routes/);
    rejects(validRegistry(), 'profile_missing', /mainnet\.json/, { profiles: {} });
});

test('profile: concession-v1 pins revision 3, the concession exit, ownership proof and an accepted proof setup', () => {
    const inV2 = (network, mutate) => mutated(activatedRegistry(), registry => {
        mutate(registry.versions[1].networks[network].config.trusted_deployment, registry.versions[1].networks[network]);
    });
    const cases = [
        [pins => { pins.vault_revision = 2; }, /vault revision 3/],
        [pins => { pins.exit_concession = 0; }, /exit_concession 1/],
        [pins => { pins.clearance_ownership_proof = 'optional'; }, /ownership proof/],
        [pins => { pins.deployment_status = 'not_deployed'; }, /placeholder/],
        [pins => { pins.deployment_status = 'paused'; }, /unknown deployment_status/],
        [pins => { pins.setup_id = 'rehearsal'; }, /must pin an accepted proof setup \(mpc-1 or dev\)/],
        [pins => { pins.setup_id = 'mpc-2'; }, /must pin an accepted proof setup \(mpc-1 or dev\)/],
        [pins => { delete pins.setup_id; }, /must pin an accepted proof setup \(mpc-1 or dev\)/],
        [pins => { pins.deposits = 'closed'; }, /must not set deposits/],
        [pins => { pins.deployment_id = 'zkapi-native-eth-mainnet-note-bound-v1-x'; }, /legacy deployment id/],
        [pins => { delete pins.request_verifying_key_sha256; }, /verifying key/],
        [pins => { pins.settlement_window_seconds = -5; }, /settlement_window_seconds/]
    ];
    for (const network of NETWORKS) {
        for (const [mutate, pattern] of cases) rejects(inV2(network, mutate), 'profile', pattern);
    }
    rejects(mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.mainnet.config.deployment_status = 'migration_required';
    }), 'profile', /legacy vault/);
});

test('profile: both networks accept the ceremony and the development setup, and refuse anything else alike', () => {
    const withSetup = (network, setup, { allow } = {}) => mutated(activatedRegistry(), registry => {
        const entry = registry.versions[1].networks[network];
        entry.config = concessionProfile(network, { slot: 2, mutate: config => {
            if (setup === undefined) delete config.trusted_deployment.setup_id;
            else config.trusted_deployment.setup_id = setup;
            if (allow !== undefined) config.trusted_deployment.allow_dev_setup = allow;
        } });
    });
    const tail = error => error.message.replace(/^[^:]+ on (?:mainnet|sepolia): /, '');
    const outcome = registry => {
        try {
            validate(registry);
        } catch (error) {
            assert.ok(error instanceof RegistryError, String(error));
            return { accepted: false, code: error.code, tail: tail(error) };
        }
        return { accepted: true };
    };

    // mpc-1 and dev validate on both networks, with the retired field absent,
    // false or true: the host ignores it.
    for (const network of NETWORKS) {
        for (const setup of ['mpc-1', 'dev']) {
            for (const allow of [undefined, false, true]) {
                assert.deepEqual(outcome(withSetup(network, setup, { allow })), { accepted: true },
                    `${network} ${setup} allow_dev_setup=${allow}`);
            }
        }
    }
    // Any other value is refused for the same reason on both networks, with
    // the accepted ids named and no network in the words.
    for (const setup of ['rehearsal', 'mpc-2', 'DEV', '', null, undefined]) {
        const results = NETWORKS.map(network => outcome(withSetup(network, setup)));
        assert.deepEqual(results[0], results[1], JSON.stringify(setup));
        assert.equal(results[0].accepted, false);
        assert.equal(results[0].code, 'profile');
        assert.match(results[0].tail, /must pin an accepted proof setup \(mpc-1 or dev\)/);
        assert.doesNotMatch(results[0].tail, /mainnet|sepolia|rehearsal entry/i);
    }
    // The registry has no switch of its own: the retired per-entry field is an
    // unknown field on any entry, accepted setup or not.
    for (const [index, network] of [[0, 'mainnet'], [0, 'sepolia'], [1, 'mainnet'], [1, 'sepolia']]) {
        for (const value of [true, false]) {
            rejects(mutated(activatedRegistry(), registry => {
                registry.versions[index].networks[network].allowDevSetup = value;
            }), 'schema', /unknown field "allowDevSetup"/);
        }
    }
    rejects(mutated(validRegistry(), registry => { registry.versions[1].networks.sepolia.allowDevSetup = true; }),
        'schema', /unknown field "allowDevSetup"/);
});

test('profile: the setup and every other profile rule give the same verdict on both networks', () => {
    // One mutation list through both networks: a rule that is keyed on the
    // network shows up as a differing outcome or a differing message tail.
    const mutations = [
        () => {},
        pins => { pins.setup_id = 'dev'; },
        pins => { pins.setup_id = 'mpc-1'; },
        pins => { pins.setup_id = 'mpc-2'; },
        pins => { pins.setup_id = 'rehearsal'; },
        pins => { pins.setup_id = ''; },
        pins => { pins.setup_id = null; },
        pins => { delete pins.setup_id; },
        pins => { pins.setup_id = 'dev'; pins.allow_dev_setup = true; },
        pins => { pins.setup_id = 'dev'; pins.allow_dev_setup = false; },
        pins => { pins.allow_dev_setup = true; },
        pins => { pins.allow_dev_setup = false; },
        pins => { pins.allow_dev_setup = 0; },
        pins => { pins.vault_revision = 2; },
        pins => { pins.exit_concession = 2; },
        pins => { pins.clearance_ownership_proof = 'off'; },
        pins => { pins.settlement_window_seconds = 0; },
        pins => { pins.deposits = 'open'; }
    ];
    const outcomeOf = (network, mutate) => {
        try {
            validate(mutated(activatedRegistry(), registry => {
                mutate(registry.versions[1].networks[network].config.trusted_deployment);
            }));
            return { accepted: true };
        } catch (error) {
            return { accepted: false, code: error.code, tail: error.message.replace(/^[^:]+ on (?:mainnet|sepolia): /, '') };
        }
    };
    for (const mutate of mutations) {
        assert.deepEqual(outcomeOf('mainnet', mutate), outcomeOf('sepolia', mutate), String(mutate));
    }
});

test('profile: a not_deployed placeholder never passes for a live row', () => {
    rejects(mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.mainnet.config = { deployment_status: 'not_deployed' };
    }), 'profile');
});

// ---------------------------------------------------------------------------
// Identity and path uniqueness
// ---------------------------------------------------------------------------

test('identity: deployment ids and vaults are distinct across the rows and tombstones of a network', () => {
    // The concession family refuses a legacy-looking id outright, so the id
    // collision is shown between two concession versions.
    rejects(mutated(threeVersionRegistry(), registry => {
        registry.versions[2].networks.mainnet.config.trusted_deployment.deployment_id =
            registry.versions[1].networks.mainnet.config.trusted_deployment.deployment_id;
    }), 'identity_collision', /deployment id/);
    // Vault addresses compare case-insensitively.
    rejects(mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.mainnet.config.trusted_deployment.contract_address =
            noteBoundProfile('mainnet').trusted_deployment.contract_address.toLowerCase();
    }), 'identity_collision', /vault/);
    // A second version cannot share the first one's protocol base URL.
    rejects(mutated(activatedRegistry(), registry => {
        const origin = noteBoundProfile('mainnet').trusted_deployment.protocol_server_url;
        const config = registry.versions[1].networks.mainnet.config;
        config.trusted_deployment.protocol_server_url = origin;
        config.trusted_deployment.indexer_url = origin;
        config.deployment_manifest_url = `${origin}/config.json`;
        config.allowed_deployment_manifest_urls = [`${origin}/config.json`];
    }), 'identity_collision', /protocol URL/);
    // The same vault on another chain is another vault.
    validate(mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.sepolia.config.trusted_deployment.contract_address =
            noteBoundProfile('mainnet').trusted_deployment.contract_address;
    }));
    // A retired version's tombstone keeps its deployment and vault reserved.
    rejects(mutated(threeVersionRegistry(), registry => {
        const entry = registry.versions[0].networks.mainnet;
        delete entry.profile;
        entry.status = 'retired';
        entry.retiredAt = '2027-03-01T00:00:00Z';
        entry.tombstone = {
            deploymentId: 'zkapi-native-eth-mainnet-concession-v1-fixture-v3c',
            chainId: 1,
            vault: `0x${'3'.repeat(40)}`
        };
    }), 'identity_collision');
    rejects(mutated(threeVersionRegistry(), registry => {
        const entry = registry.versions[0].networks.mainnet;
        delete entry.profile;
        entry.status = 'retired';
        entry.retiredAt = '2027-03-01T00:00:00Z';
        entry.tombstone = { deploymentId: 'a-different-id', chainId: 1, vault: `0x${'3'.repeat(40)}`.toUpperCase().replace('0X', '0x') };
    }), 'identity_collision', /vault/);
});

// Identities are scoped to one network: each network has its own wallet
// database, build and served config, and a vault key carries its chain id.
test('identity: the same deployment id may be used on two networks, never twice on one', () => {
    const shared = 'zkapi-native-eth-concession-v1-fixture-v2c';
    const reuse = mutated(activatedRegistry(), registry => {
        for (const network of NETWORKS) {
            registry.versions[1].networks[network].config.trusted_deployment.deployment_id = shared;
        }
    });
    validate(reuse);
    for (const network of NETWORKS) {
        const table = resolvedTable(reuse, network);
        assert.equal(table.filter(version => version.deploymentId === shared).length, 1, network);
        assert.equal(versionForDeployment(table, shared).id, 'v2', network);
    }
    // A tombstone of one network does not reserve its id on the other either.
    validate(mutated(threeVersionRegistry(), registry => {
        const entry = registry.versions[0].networks.mainnet;
        delete entry.profile;
        entry.status = 'retired';
        entry.retiredAt = '2027-03-01T00:00:00Z';
        entry.tombstone = {
            deploymentId: 'zkapi-native-eth-sepolia-concession-v1-fixture-v3c', chainId: 1,
            vault: `0x${'7'.repeat(40)}`
        };
    }));
    // Within one network it is still one deployment, one id.
    for (const network of NETWORKS) {
        rejects(mutated(threeVersionRegistry(), registry => {
            registry.versions[2].networks[network].config.trusted_deployment.deployment_id =
                registry.versions[1].networks[network].config.trusted_deployment.deployment_id;
        }), 'identity_collision', /deployment id/);
    }
});

test('identity: paths and aliases never overlap', () => {
    const v2 = mutate => mutated(activatedRegistry(), registry => mutate(registry.versions[1], registry.versions[0]));
    rejects(v2((row, v1) => { row.publicPath = v1.publicPath; }), 'path_collision');
    rejects(v2((row, v1) => {
        row.proxyPath = v1.proxyPath;
        for (const network of NETWORKS) row.networks[network].config.deployment_api_proxy_path = v1.proxyPath;
    }), 'path_collision');
    // The first rewrite would swallow a nested proxy path.
    rejects(v2((row, v1) => {
        row.proxyPath = `${v1.proxyPath}v2c/`;
        for (const network of NETWORKS) row.networks[network].config.deployment_api_proxy_path = row.proxyPath;
    }), 'path_collision');
    // A proxy path over a public path would capture the assets.
    rejects(v2(row => { row.publicPath = '/zkapi-deployment-v2c/assets/'; }), 'path_collision');
    rejects(v2(row => { row.proxyPath = '/zkapi/v2c/proxy/'; }), 'path_collision');
    rejects(v2(row => { row.sdk.alias = '@openanonymity/zkapi-browser-sdk'; }), 'duplicate_alias');
    // Public paths may nest: /zkapi/v2c/ lives under /zkapi/ by design.
    validate(activatedRegistry());
    for (const bad of ['zkapi/', '/zkapi', '/zkapi//', '/../zkapi/', '/zk apî/', '/zkapi/?x=1/']) {
        rejects(mutated(validRegistry(), registry => { registry.versions[1].publicPath = bad; }), 'schema');
    }
});

// ---------------------------------------------------------------------------
// Request-visible parameters
// ---------------------------------------------------------------------------

test('parameters: live versions share the inference base and the request charge cap', () => {
    rejects(mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.mainnet.config.trusted_deployment.request_charge_cap = 40000;
    }), 'parameter_mismatch');
    // The base itself must be the reviewed API, so a differing one fails the profile rule first.
    rejects(mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.mainnet.config.trusted_deployment.openrouter_inference_base = 'https://example.test/v1';
    }), 'profile');
    // The price feed may legitimately differ between vaults (not request-visible).
    validate(mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.mainnet.config.trusted_deployment.native_price_feed_address = `0x${'7'.repeat(40)}`;
    }));
});

// ---------------------------------------------------------------------------
// Activation gates
// ---------------------------------------------------------------------------

test('activation gate: a live row needs pinned SDK facts and a matching recovery review', () => {
    const v2 = mutate => mutated(activatedRegistry(), registry => mutate(registry.versions[1]));
    rejects(v2(row => { row.sdk.source = null; }), 'sdk_pin');
    rejects(v2(row => { row.sdk.revision = null; }), 'sdk_pin');
    rejects(v2(row => { row.sdk.storeSha256 = null; }), 'sdk_pin');
    rejects(v2(row => { row.sdk.source = 'github:OpenAnonymity/zkapi#main'; }), 'sdk_pin');
    // The review names another revision than the SDK pinned.
    rejects(v2(row => { row.gate.recoveryReview.revision = 'f'.repeat(40); }), 'gate_recovery_review');
    rejects(v2(row => { row.gate.recoveryReview.verdict = 'pending'; }), 'gate_recovery_review');
    rejects(v2(row => {
        row.gate.recoveryReview.verdict = 'patched';
        row.gate.recoveryReview.patch = 'recovery-v2c';
    }), 'gate_recovery_review');
    validate(v2(row => {
        row.gate.recoveryReview.verdict = 'patched';
        row.gate.recoveryReview.patch = 'recovery-v2c';
        row.sdk.patches = ['recovery-v2c'];
    }));
    rejects(v2(row => { row.gate.recoveryReview.patch = 'wallet-recovery-v1'; }), 'gate_recovery_review');
    // The v1 review must keep covering the v1 SDK.
    rejects(mutated(validRegistry(), registry => { registry.versions[0].gate.recoveryReview.revision = ZERO_REVISION; }),
        'gate_recovery_review');
});

test('activation gate: protocol wiring must be implemented before a row is live', () => {
    const v2 = mutate => mutated(activatedRegistry(), registry => mutate(registry.versions[1]));
    rejects(v2(row => { row.gate.protocolWiring = 'pending'; }), 'gate_wiring');
    // Not applicable is only for a family that requires nothing.
    rejects(v2(row => { row.gate.protocolWiring = 'not_applicable'; }), 'gate_wiring');
    // Every required name must be implemented: one missing name is enough.
    const almost = new Set(getAdapter('concession-v1').requiredWiring.slice(1));
    rejects(activatedRegistry(), 'gate_wiring', /not implemented/, { wired: almost });
    validate(activatedRegistry(), { wired: ALL_WIRED });
    // The default is the checked-in WIRED set, which is every name the family
    // requires: with no override the gate is the production one, and open.
    assert.ok([...ALL_WIRED].every(name => WIRED.has(name)));
    assert.equal(validateRegistry(activatedRegistry(), validationOptions({ wired: undefined })).versions[1].id, 'v2');
    // A set that is not a Set of names holds nothing.
    rejects(activatedRegistry(), 'gate_wiring', /not implemented/, { wired: null });
    rejects(activatedRegistry(), 'gate_wiring', /not implemented/, { wired: ['service-message'] });
    // A family that requires no wiring is unaffected by an empty set.
    validate(validRegistry(), { wired: new Set() });
});

test('activation gate: a concession-v1 row pins the finalized manifest it was generated from', () => {
    rejects(mutated(activatedRegistry(), registry => { registry.versions[1].gate.manifestSha256 = null; }),
        'gate_manifest');
    rejects(mutated(activatedRegistry(), registry => { registry.versions[1].gate.manifestSha256 = 'abc'; }), 'schema');
    rejects(mutated(validRegistry(), registry => { registry.versions[0].gate.manifestSha256 = 'a'.repeat(64); }),
        'gate_manifest');
});

// ---------------------------------------------------------------------------
// Wallet namespace
// ---------------------------------------------------------------------------

test('wallet namespace: one lineage-level wallet database name template per network, never the SDK default', () => {
    const registry = validRegistry();
    assert.equal(walletDatabaseName(registry, 'mainnet'), 'zkapi-browser-wallet-fresh-20260930-mainnet-v1');
    assert.equal(walletDatabaseName(registry, 'sepolia'), 'zkapi-browser-wallet-fresh-20260930-sepolia-v1');
    assert.notEqual(walletDatabaseName(registry, 'mainnet'), walletDatabaseName(registry, 'sepolia'));
    for (const template of ['zkapi-browser-wallet-v1', 'zkapi-browser-wallet-{lineage}-v1',
        'zkapi-browser-wallet-{network}-v1', 'a-{lineage}-{lineage}-{network}', '{lineage}-{network}/x']) {
        rejects(mutated(validRegistry(), copy => { copy.walletDatabase = template; }), 'wallet_namespace');
    }
    rejects(mutated(validRegistry(), copy => { copy.walletDatabaseVersion = 0; }), 'wallet_namespace');
    assert.throws(() => walletDatabaseName(registry, 'Main net'), error => error.code === 'schema');
    // A template that happens to resolve to the SDK default is refused too.
    assert.throws(() => walletDatabaseName({ lineage: 'zkapi-browser-wallet', walletDatabase: '{lineage}-{network}' }, 'v1'),
        error => error.code === 'wallet_namespace');
    assert.throws(() => walletDatabaseName({ lineage: 'x', walletDatabase: 'zkapi-browser-wallet-v1' }, 'mainnet'),
        error => error.code === 'wallet_namespace');
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

test('notices: exist only on exit-only rows and are fully validated', () => {
    const withNotice = (notice, extra = null) => mutated(activatedRegistry(), registry => {
        registry.versions[0].networks.mainnet.notices = [notice];
        if (extra) extra(registry);
    });
    validate(withNotice(stuckEscapeNotice()));
    rejects(withNotice(stuckEscapeNotice(), registry => {
        registry.versions[1].networks.mainnet.notices = [stuckEscapeNotice()];
    }), 'notice', /exit-only/);
    for (const bad of [
        { kind: 'announcement' }, { noteId: -1 }, { noteId: 1.5 }, { noteId: '7' },
        { destination: '0x1234' }, { destination: 'not an address' }, { expiresAt: 'tomorrow' },
        { expiresAt: '2027-01-01' }, { text: '' }, { text: 'x'.repeat(281) },
        { text: `line${String.fromCharCode(0x2028)}break` }, { text: 'bell\u0007' }
    ]) {
        rejects(withNotice(stuckEscapeNotice(bad)), 'notice');
    }
    rejects(withNotice({ ...stuckEscapeNotice(), extra: true }), 'schema');
    rejects(mutated(activatedRegistry(), registry => {
        registry.versions[0].networks.mainnet.notices = Array.from({ length: 17 }, () => stuckEscapeNotice());
    }), 'notice');
});

test('notices: resolve to epoch milliseconds with a lowercase destination', () => {
    const registry = mutated(activatedRegistry(), copy => {
        copy.versions[0].networks.mainnet.notices = [stuckEscapeNotice({ destination: `0x${'AB'.repeat(20)}` })];
    });
    const table = resolvedTable(registry, 'mainnet');
    assert.deepEqual(table[0].notices, [{
        kind: 'stuck_escape',
        noteId: 7,
        destination: `0x${'ab'.repeat(20)}`,
        expiresAt: Date.UTC(2027, 0, 1),
        text: 'This escape cannot finalize until its destination accepts ETH.'
    }]);
    assert.deepEqual(resolvedTable(registry, 'sepolia')[0].notices, []);
});

// ---------------------------------------------------------------------------
// Forward only
// ---------------------------------------------------------------------------

test('forward-only: activation, rollback and retirement are forward moves; a revert is not', () => {
    forwardOnly(validRegistry(), validRegistry());
    // The activation change itself.
    forwardOnly(validRegistry(), activatedRegistry());
    forwardOnly(validRegistry(), partialRevertRegistry());
    forwardOnly(partialRevertRegistry(), activatedRegistry());
    // A rollback: v1 active again, v2 exit-only.
    forwardOnly(activatedRegistry(), rollbackRegistry());
    // A later version.
    forwardOnly(activatedRegistry(), threeVersionRegistry());
    // git revert of the activation.
    assert.throws(() => forwardOnly(activatedRegistry(), revertedRegistry()),
        error => error instanceof RegistryError && error.code === 'forward_only' && /moved back/.test(error.message));
    assert.throws(() => forwardOnly(activatedRegistry(), partialRevertRegistry()),
        error => error.code === 'forward_only' && /v2 on mainnet moved back from active to pending/.test(error.message));
    assert.throws(() => forwardOnly(rollbackRegistry(), revertedRegistry()),
        error => error.code === 'forward_only');
    // One network at a time is enough to fail.
    assert.throws(() => forwardOnly(activatedRegistry(), mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.sepolia.status = 'pending';
        delete registry.versions[1].networks.sepolia.activatedAt;
        registry.versions[1].networks.sepolia.config = { deployment_status: 'not_deployed' };
    })), error => error.code === 'forward_only' && /sepolia/.test(error.message));
});

test('forward-only: rows cannot be removed, renumbered or un-retired and the namespace is fixed', () => {
    const fails = (base, next, pattern) => assert.throws(() => forwardOnly(base, next), error => {
        assert.equal(error.code, 'forward_only');
        if (pattern) assert.match(error.message, pattern);
        return true;
    });
    fails(activatedRegistry(), mutated(activatedRegistry(), registry => { registry.versions.pop(); }), /removed/);
    fails(activatedRegistry(), mutated(activatedRegistry(), registry => { registry.versions[1].ordinal = 5; }), /ordinal or protocol/);
    fails(activatedRegistry(), mutated(activatedRegistry(), registry => { registry.versions[1].circuitId = 'x'; }), /ordinal or protocol/);
    fails(activatedRegistry(), mutated(activatedRegistry(), registry => { registry.lineage = 'fresh-20270101'; }), /namespace/);
    fails(activatedRegistry(), mutated(activatedRegistry(), registry => { registry.walletDatabaseVersion = 4; }), /namespace/);
    fails(activatedRegistry(), mutated(activatedRegistry(), registry => {
        registry.walletDatabase = 'zkapi-browser-wallet-{network}-{lineage}-v1';
    }), /namespace/);

    // A pending row may be dropped or reshaped before it ever activated.
    forwardOnly(validRegistry(), mutated(validRegistry(), registry => { registry.versions.pop(); }));

    // Retired is terminal.
    const retired = mutated(threeVersionRegistry(), registry => {
        const entry = registry.versions[0].networks.mainnet;
        delete entry.profile;
        entry.status = 'retired';
        entry.retiredAt = '2027-03-01T00:00:00Z';
        entry.tombstone = v1Tombstone('mainnet');
    });
    forwardOnly(threeVersionRegistry(), retired);
    fails(retired, threeVersionRegistry(), /moved back from retired to exit-only/);
});

test('forward-only: only a lower version below newer exit-only versions may reopen', () => {
    // The newest version cannot be reopened by flipping it back: no newer
    // exit-only version makes that a rollback.
    const closedNewest = mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.mainnet.status = 'exit-only';
        registry.versions[1].networks.mainnet.depositsClosedSince = '2026-11-20T00:00:00Z';
    });
    forwardOnly(activatedRegistry(), closedNewest);
    assert.throws(() => forwardOnly(closedNewest, activatedRegistry()), error => error.code === 'forward_only');
    // A middle version may be reopened only if every newer live one is exit-only.
    const base = threeVersionRegistry();
    const reopenMiddle = mutated(base, registry => {
        registry.versions[1].networks.mainnet.status = 'active';
        delete registry.versions[1].networks.mainnet.depositsClosedSince;
        registry.versions[2].networks.mainnet.status = 'exit-only';
        registry.versions[2].networks.mainnet.depositsClosedSince = '2026-12-05T00:00:00Z';
    });
    forwardOnly(base, reopenMiddle);
    const reopenWhileNewerActive = mutated(base, registry => {
        registry.versions[1].networks.mainnet.status = 'active';
        delete registry.versions[1].networks.mainnet.depositsClosedSince;
    });
    assert.throws(() => forwardOnly(base, reopenWhileNewerActive), error => error.code === 'forward_only');
});

// ---------------------------------------------------------------------------
// Forward only: identity continuity
// ---------------------------------------------------------------------------

// What the tombstone of a version names: the deployment, chain and vault its
// profile pinned while it was live.
function tombstoneOf(profile) {
    const pins = profile.trusted_deployment;
    return { deploymentId: pins.deployment_id, chainId: pins.chain_id, vault: pins.contract_address };
}
const v1Tombstone = network => tombstoneOf(noteBoundProfile(network));
const v2Tombstone = network => tombstoneOf(concessionProfile(network, { slot: 2 }));

// Retire `row` of `registry` on both networks (assets gone, tombstone kept).
function retiring(registry, index, tombstoneFor) {
    return mutated(registry, copy => {
        for (const network of NETWORKS) {
            const entry = copy.versions[index].networks[network];
            delete entry.profile;
            delete entry.config;
            delete entry.depositsClosedSince;
            entry.status = 'retired';
            entry.retiredAt = '2027-03-01T00:00:00Z';
            entry.tombstone = tombstoneFor(network);
        }
    });
}

const failsWith = (code, run, pattern = null) => assert.throws(run, error => {
    assert.ok(error instanceof RegistryError, `expected a RegistryError, got ${error}`);
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
});

test('forward-only: a retired version carries the tombstone of the deployment it had while live', () => {
    const base = threeVersionRegistry();
    // v1 names a profile FILE, v2 an inline config: both resolve.
    const retiredV1 = retiring(base, 0, v1Tombstone);
    const retiredV2 = retiring(base, 1, v2Tombstone);
    validate(retiredV1);
    forwardOnly(base, retiredV1);
    validate(retiredV2);
    forwardOnly(base, retiredV2);
    // The vault is compared as an address, not as a string (checksum casing).
    forwardOnly(base, retiring(base, 0, network => ({ ...v1Tombstone(network), vault: v1Tombstone(network).vault.toLowerCase() })));

    // A tombstone that is valid in itself but names something else.
    for (const [label, wrong] of [
        ['deployment id', network => ({ ...v1Tombstone(network), deploymentId: 'typo-deployment' })],
        ['vault', network => ({ ...v1Tombstone(network), vault: `0x${'1'.repeat(40)}` })],
        ['chain', network => ({ ...v1Tombstone(network), chainId: network === 'mainnet' ? 11155111 : 1 })],
        ['version 2 deployment', v2Tombstone]
    ]) {
        const wrongTombstone = retiring(base, 0, wrong);
        // The registry alone cannot tell: a typo in the deployment id or the
        // vault validates. (Another chain, or another live version's
        // identity, it does catch on its own.)
        if (label === 'deployment id' || label === 'vault') validate(wrongTombstone);
        failsWith('tombstone_mismatch', () => forwardOnly(base, wrongTombstone), /does not name the deployment id/);
        // There is no override for naming the wrong deployment.
        failsWith('tombstone_mismatch', () => forwardOnly(base, wrongTombstone, { allowIdentityChange: true }));
    }
    // One network is enough to fail.
    failsWith('tombstone_mismatch', () => forwardOnly(base, mutated(retiredV1, copy => {
        copy.versions[0].networks.sepolia.tombstone.deploymentId = 'typo-deployment';
    })), /v1 on sepolia/);
    // The base profile's content is what is compared, not the file name.
    const otherVault = fixtureProfiles();
    otherVault['mainnet.json'].trusted_deployment.contract_address = `0x${'7'.repeat(40)}`;
    failsWith('tombstone_mismatch', () => forwardOnly(base, retiredV1, { baseProfiles: otherVault }), /v1 on mainnet/);
});

test('forward-only: an identity that cannot be read is an error, not a pass', () => {
    const base = threeVersionRegistry();
    const retiredV1 = retiring(base, 0, v1Tombstone);
    // No profile files given: a profile-file row cannot be compared.
    failsWith('identity_unverified', () => assertForwardOnly(base, retiredV1), /profile mainnet\.json was not provided/);
    failsWith('identity_unverified', () => assertForwardOnly(base, base), /could not be read/);
    failsWith('identity_unverified', () => assertForwardOnly(base, base,
        { baseProfiles: fixtureProfiles() }), /next registry/);
    // A profile that has no pins reads the same way.
    failsWith('identity_unverified', () => forwardOnly(base, retiredV1, {
        baseProfiles: { 'mainnet.json': {}, 'sepolia.json': {} }
    }));
    // Rows that carry their profile inline need no profile files.
    const inline = mutated(base, copy => {
        for (const network of NETWORKS) {
            const entry = copy.versions[0].networks[network];
            entry.config = noteBoundProfile(network);
            delete entry.profile;
        }
    });
    assertForwardOnly(inline, inline);
    assertForwardOnly(inline, retiring(inline, 0, v1Tombstone));
    // The override skips the comparison of rows that stay live; it never
    // reads what it does not compare.
    assertForwardOnly(base, base, { allowIdentityChange: true });
    // ...but a retirement is always compared.
    failsWith('identity_unverified', () => assertForwardOnly(base, retiredV1, { allowIdentityChange: true }));
});

test('forward-only: a version that stays live keeps its deployment, chain, vault and SDK pins', () => {
    const base = threeVersionRegistry();
    // The legitimate moves of a live version are not identity changes.
    forwardOnly(base, base);
    forwardOnly(activatedRegistry(), rollbackRegistry());
    forwardOnly(validRegistry(), activatedRegistry());

    const changes = {
        'a different deployment id (inline config)': copy => {
            for (const network of NETWORKS) copy.versions[2].networks[network].config.trusted_deployment.deployment_id = 'another-deployment';
        },
        'a different vault (inline config)': copy => {
            for (const network of NETWORKS) copy.versions[2].networks[network].config.trusted_deployment.contract_address = `0x${'9'.repeat(40)}`;
        },
        'a different chain (inline config)': copy => {
            copy.versions[2].networks.sepolia.config.trusted_deployment.chain_id = 1;
        },
        'a different SDK revision': copy => {
            copy.versions[2].sdk.revision = '1'.repeat(40);
            copy.versions[2].sdk.source = `github:OpenAnonymity/zkapi#${'1'.repeat(40)}`;
            copy.versions[2].gate.recoveryReview.revision = '1'.repeat(40);
        },
        'a different wallet store hash': copy => {
            copy.versions[2].sdk.storeSha256 = 'e'.repeat(64);
        },
        'a different SDK revision of the profile-file version': copy => {
            copy.versions[0].sdk.revision = '2'.repeat(40);
        }
    };
    for (const [label, change] of Object.entries(changes)) {
        const next = mutated(base, change);
        failsWith('identity_changed', () => forwardOnly(base, next), /v[13] on/);
        // The reviewed override (an SDK pin bump, a corrected profile) passes.
        forwardOnly(base, next, { allowIdentityChange: true });
        assert.ok(label);
    }

    // A profile FILE whose content changed under the same name is the same
    // thing: the registry text is unchanged and the deployment is not.
    const swapped = fixtureProfiles();
    swapped['mainnet.json'].trusted_deployment.deployment_id = 'swapped-in-place';
    failsWith('identity_changed', () => forwardOnly(base, base, { nextProfiles: swapped }), /v1 on mainnet/);
    forwardOnly(base, base, { nextProfiles: swapped, allowIdentityChange: true });
    // Moving the same deployment between a file and an inline config is not a
    // change of identity.
    forwardOnly(base, mutated(base, copy => {
        for (const network of NETWORKS) {
            const entry = copy.versions[0].networks[network];
            entry.config = noteBoundProfile(network);
            delete entry.profile;
        }
    }));
    // A rollback is still a move of the same deployment.
    failsWith('identity_changed', () => forwardOnly(activatedRegistry(), mutated(rollbackRegistry(), copy => {
        copy.versions[0].networks.mainnet.profile = 'sepolia.json';
    })), /v1 on mainnet/);
});

test('forward-only: a version that stays live keeps its proof setup and key pins', () => {
    // The proof pins of a profile are the keys its vault verifies against. A
    // vault is deployed with one set and cannot be switched to another (a
    // development setup cannot become mpc-1 in place), so the same deployment
    // id and vault with other keys is not an edit: it is a new version.
    const base = threeVersionRegistry();
    const PINS = ['setup_id', 'request_proving_key_sha256', 'withdrawal_proving_key_sha256',
        'request_verifying_key_sha256', 'request_vk_keccak256', 'withdrawal_vk_keccak256'];
    const pinsOf = (registry, network) => registry.versions[2].networks[network].config.trusted_deployment;
    const onDevelopment = (registry, index = 2) => mutated(registry, copy => {
        for (const network of NETWORKS) copy.versions[index].networks[network].config.trusted_deployment.setup_id = 'dev';
    });

    // Every pin, on each network, fails on its own and names itself; the same
    // reviewed override as the other identity fields lifts it.
    const other = { setup_id: 'dev' };
    for (const network of NETWORKS) {
        for (const name of PINS) {
            const next = mutated(base, copy => {
                copy.versions[2].networks[network].config.trusted_deployment[name] = other[name]
                    || (name.endsWith('keccak256') ? `0x${'9'.repeat(64)}` : '9'.repeat(64));
            });
            assert.notEqual(pinsOf(next, network)[name], pinsOf(base, network)[name], name);
            failsWith('identity_changed', () => forwardOnly(base, next),
                new RegExp(`v3 on ${network} changed its proof setup or key pins \\(${name}\\)`));
            forwardOnly(base, next, { allowIdentityChange: true });
        }
    }
    // Several at once are all named, in one message.
    failsWith('identity_changed', () => forwardOnly(base, mutated(base, copy => {
        const pins = copy.versions[2].networks.mainnet.config.trusted_deployment;
        pins.setup_id = 'dev';
        pins.request_verifying_key_sha256 = '8'.repeat(64);
    })), /\(setup_id, request_verifying_key_sha256\)/);

    // Both directions: a vault deployed on dev keys is not moved to mpc-1 by
    // editing the profile, and an mpc-1 profile does not become dev either.
    const dev = onDevelopment(base);
    forwardOnly(dev, dev);
    failsWith('identity_changed', () => forwardOnly(dev, base), /changed its proof setup or key pins \(setup_id\)/);
    failsWith('identity_changed', () => forwardOnly(base, dev), /changed its proof setup or key pins \(setup_id\)/);
    // A pin that appears or disappears is a change too.
    failsWith('identity_changed', () => forwardOnly(base, mutated(base, copy => {
        delete copy.versions[2].networks.sepolia.config.trusted_deployment.request_verifying_key_sha256;
    })), /\(request_verifying_key_sha256\)/);

    // Through every move a live version can make: closing deposits, and a
    // rollback to a lower version.
    failsWith('identity_changed', () => forwardOnly(base, mutated(base, copy => {
        const entry = copy.versions[2].networks.mainnet;
        entry.status = 'exit-only';
        entry.depositsClosedSince = '2027-01-01T00:00:00Z';
        entry.config.trusted_deployment.setup_id = 'dev';
    })), /v3 on mainnet changed its proof setup or key pins/);
    const swapped = fixtureProfiles();
    swapped['sepolia.json'].trusted_deployment.withdrawal_proving_key_sha256 = '7'.repeat(64);
    failsWith('identity_changed', () => forwardOnly(activatedRegistry(), rollbackRegistry(), { nextProfiles: swapped }),
        /v1 on sepolia changed its proof setup or key pins \(withdrawal_proving_key_sha256\)/);

    // A profile FILE edited in place is read from the profiles each side was
    // committed with (the legacy family has no setup id, so adding one counts).
    failsWith('identity_changed', () => forwardOnly(base, base, { nextProfiles: swapped }),
        /v1 on sepolia changed its proof setup or key pins \(withdrawal_proving_key_sha256\)/);
    const named = fixtureProfiles();
    named['mainnet.json'].trusted_deployment.setup_id = 'mpc-1';
    failsWith('identity_changed', () => forwardOnly(base, base, { nextProfiles: named }), /v1 on mainnet.*\(setup_id\)/);
    forwardOnly(base, base, { nextProfiles: named, allowIdentityChange: true });

    // What is not a change: hash casing (the SDK reads the hashes without
    // regard to case), a pin that is the same on both sides, and the fields
    // that are not proof pins.
    forwardOnly(base, mutated(base, copy => {
        const pins = copy.versions[2].networks.mainnet.config.trusted_deployment;
        pins.request_verifying_key_sha256 = pins.request_verifying_key_sha256.toUpperCase();
        pins.request_vk_keccak256 = `0x${pins.request_vk_keccak256.slice(2).toUpperCase()}`;
    }));
    forwardOnly(base, mutated(base, copy => {
        copy.versions[2].networks.sepolia.config.trusted_deployment.rpc_url = 'https://rpc.example.test';
    }));
    // A version that was pending takes any accepted setup when it is activated.
    forwardOnly(validRegistry(), onDevelopment(activatedRegistry(), 1));

    // The way out of a vault on dev keys is a further version: the old row
    // stays on its own keys (exit-only) and a new row carries the other setup.
    const before = onDevelopment(activatedRegistry(), 1);
    const after = onDevelopment(threeVersionRegistry(), 1);
    assert.equal(after.versions[2].networks.mainnet.config.trusted_deployment.setup_id, 'mpc-1');
    validate(after);
    forwardOnly(before, after);
});

test('forward-only: a retired version keeps its tombstone', () => {
    const retired = retiring(threeVersionRegistry(), 0, v1Tombstone);
    forwardOnly(retired, retired);
    const edited = mutated(retired, copy => { copy.versions[0].networks.mainnet.tombstone.deploymentId = 'edited'; });
    failsWith('identity_changed', () => forwardOnly(retired, edited), /changed its tombstone/);
    forwardOnly(retired, edited, { allowIdentityChange: true });
});

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

test('liveVersions and depositTarget follow the lifecycle', () => {
    assert.deepEqual(liveVersions(validRegistry(), 'mainnet').map(row => row.id), ['v1']);
    assert.deepEqual(liveVersions(activatedRegistry(), 'mainnet').map(row => row.id), ['v1', 'v2']);
    assert.deepEqual(liveVersions(threeVersionRegistry(), 'sepolia').map(row => row.id), ['v1', 'v2', 'v3']);
    assert.equal(depositTarget(validRegistry(), 'mainnet').id, 'v1');
    assert.equal(depositTarget(activatedRegistry(), 'mainnet').id, 'v2');
    assert.equal(depositTarget(rollbackRegistry(), 'sepolia').id, 'v1');
    assert.equal(depositTarget(threeVersionRegistry(), 'mainnet').id, 'v3');
    // Zero targets is allowed: deposits are unavailable.
    assert.equal(depositTarget(partialRevertRegistry(), 'mainnet'), null);
    // The registry is returned in ordinal order even if rows are listed otherwise.
    const shuffled = mutated(threeVersionRegistry(), registry => { registry.versions.reverse(); });
    assert.deepEqual(liveVersions(shuffled, 'mainnet').map(row => row.id), ['v1', 'v2', 'v3']);
    // An unvalidated registry with two active rows never silently picks one.
    const twoActive = mutated(activatedRegistry(), registry => { registry.versions[0].networks.mainnet.status = 'active'; });
    assert.throws(() => depositTarget(twoActive, 'mainnet'), error => error.code === 'multiple_active');
    assert.throws(() => liveVersions(validRegistry(), 'not a network'), error => error.code === 'schema');
});

test('activation yields exactly one deposit target per network', () => {
    for (const registry of [validRegistry(), activatedRegistry(), rollbackRegistry(), threeVersionRegistry()]) {
        for (const network of REGISTRY_NETWORKS) {
            const table = resolvedTable(registry, network);
            assert.equal(table.filter(version => version.status === 'active').length, 1, network);
            assert.deepEqual(table.filter(version => version.depositsOpen).map(version => version.id),
                [depositTarget(registry, network).id]);
        }
    }
});

test('the runtime table excludes pending rows, orders live rows by ordinal and ends with tombstones', () => {
    assert.deepEqual(resolvedTable(validRegistry(), 'mainnet').map(version => version.id), ['v1']);
    assert.deepEqual(resolvedTable(partialRevertRegistry(), 'sepolia').map(version => [version.id, version.status]),
        [['v1', 'exit-only']]);
    const retired = mutated(threeVersionRegistry(), registry => {
        const entry = registry.versions[0].networks.mainnet;
        delete entry.profile;
        entry.status = 'retired';
        entry.retiredAt = '2027-03-01T00:00:00Z';
        entry.depositsClosedSince = '2026-11-01T00:00:00Z';
        entry.tombstone = {
            deploymentId: 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930',
            chainId: 1,
            vault: '0x4386FDbdA35D995beB3BF8625118Ec5982ec81fe'
        };
    });
    validate(retired);
    const table = resolvedTable(retired, 'mainnet');
    assert.deepEqual(table.map(version => [version.id, version.status]),
        [['v2', 'exit-only'], ['v3', 'active'], ['v1', 'retired']]);
    const [, , tombstone] = table;
    assert.deepEqual({ ...tombstone, transition: undefined }, {
        id: 'v1', ordinal: 1, label: 'Version 1', protocolVersion: '0.1', adapter: 'note-bound-v1',
        circuitId: 'zkapi-v2-note-bound-v1', vaultRevision: 1, status: 'retired', depositsOpen: false, depositsClosedSince: Date.UTC(2026, 10, 1),
        admissionClosesAt: null, deploymentId: 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930', chainId: 1,
        vault: '0x4386fdbda35d995beb3bf8625118ec5982ec81fe', rpcUrl: null, configSha256: null, assetBase: null,
        proxyPath: null, transition: undefined, notices: []
    });
    // The other network still lists v1 live.
    assert.deepEqual(resolvedTable(retired, 'sepolia').map(version => version.id), ['v1', 'v2', 'v3']);
});

test('resolved versions are derived from the profile and the row, not duplicated in the registry', () => {
    const table = resolvedTable(activatedRegistry(), 'sepolia');
    const [v1, v2] = table;
    const v1Pins = noteBoundProfile('sepolia').trusted_deployment;
    const v2Pins = concessionProfile('sepolia', { slot: 2 }).trusted_deployment;
    assert.equal(v1.deploymentId, v1Pins.deployment_id);
    assert.equal(v2.deploymentId, v2Pins.deployment_id);
    assert.equal(v2.chainId, 11155111);
    assert.equal(v2.vault, v2Pins.contract_address);
    assert.equal(v2.rpcUrl, v2Pins.rpc_url);
    assert.equal(v1.status, 'exit-only');
    assert.equal(v1.depositsOpen, false);
    assert.equal(v1.depositsClosedSince, Date.UTC(2026, 10, 1));
    assert.equal(v2.status, 'active');
    assert.equal(v2.depositsOpen, true);
    assert.equal(v2.depositsClosedSince, null);
    assert.equal(v2.assetBase, 'zkapi/v2c/');
    assert.equal(v2.proxyPath, '/zkapi-deployment-v2c/');
    assert.equal(v2.circuitId, 'zkapi-v2-concession-v1');
    assert.equal(v2.vaultRevision, 3);
    assert.deepEqual(v2.transition, { closeByMarginSeconds: 259200, reminderDays: [7, 3, 1], promptWindowDays: 14 });
    // The registry carries none of these as data: a row naming them is refused.
    for (const field of ['deploymentId', 'vault', 'chainId', 'rpcUrl', 'depositsOpen']) {
        rejects(mutated(activatedRegistry(), registry => { registry.versions[1][field] = 'x'; }), 'schema');
    }
    // Resolved entries are copies: mutating the table never edits the registry.
    const registry = activatedRegistry();
    const resolved = resolveRuntimeTable(registry, 'mainnet', { profiles: fixtureProfiles() });
    resolved[1].transition.reminderDays.push(99);
    resolved[1].label = 'changed';
    assert.deepEqual(registry, activatedRegistry());
});

test('admissionClosesAt and depositsClosedSince resolve to milliseconds', () => {
    const registry = mutated(activatedRegistry(), copy => {
        copy.versions[0].networks.mainnet.admissionClosesAt = '2026-12-15T00:00:00Z';
    });
    validate(registry);
    const [v1] = resolvedTable(registry, 'mainnet');
    assert.equal(v1.admissionClosesAt, Date.UTC(2026, 11, 15));
    assert.equal(v1.depositsClosedSince, Date.UTC(2026, 10, 1));
    assert.equal(resolvedTable(registry, 'sepolia')[0].admissionClosesAt, null);
});

test('configSha256 pins the exact bytes a build writes, and the deposits flag only changes honoring SDKs', () => {
    const profiles = fixtureProfiles();
    const registry = activatedRegistry();
    const table = resolvedTable(registry, 'mainnet');
    const [v1, v2] = table;

    // v1 is exit-only on an SDK that ignores the flag: its emitted config is
    // the reviewed profile, unchanged.
    const v1Row = registry.versions[0];
    assert.equal(emittedConfig(profiles['mainnet.json'], { honorsDepositsFlag: v1Row.sdk.honorsDepositsFlag, status: 'exit-only' }),
        profiles['mainnet.json']);
    assert.equal(v1.configSha256, sha256Hex(serializeConfig(profiles['mainnet.json'])));

    // v2 is active: no flag. Once exit-only the honoring SDK is told, and the
    // key lands last so the bytes are deterministic.
    const v2Config = registry.versions[1].networks.mainnet.config;
    assert.equal(emittedConfig(v2Config, { honorsDepositsFlag: true, status: 'active' }), v2Config);
    assert.equal(v2.configSha256, sha256Hex(serializeConfig(v2Config)));
    const closed = emittedConfig(v2Config, { honorsDepositsFlag: true, status: 'exit-only' });
    assert.equal(closed.trusted_deployment.deposits, 'closed');
    assert.deepEqual(Object.keys(closed.trusted_deployment).at(-1), 'deposits');
    assert.equal(v2Config.trusted_deployment.deposits, undefined, 'the reviewed profile is never modified');
    assert.notEqual(sha256Hex(serializeConfig(closed)), v2.configSha256);

    const threeVersion = resolvedTable(threeVersionRegistry(), 'mainnet');
    const middle = threeVersion.find(version => version.id === 'v2');
    assert.equal(middle.status, 'exit-only');
    assert.equal(middle.configSha256, sha256Hex(serializeConfig(closed)));
    // And the old, non-honoring v1 keeps its reviewed bytes while exit-only.
    assert.equal(threeVersion[0].configSha256, v1.configSha256);

    assert.throws(() => emittedConfig({}, { honorsDepositsFlag: true, status: 'exit-only' }),
        error => error.code === 'profile');
});

test('without a hash function configSha256 is null; a precomputed digest wins and is validated', () => {
    const registry = activatedRegistry();
    const options = { profiles: fixtureProfiles() };
    assert.deepEqual(resolveRuntimeTable(registry, 'mainnet', options).map(version => version.configSha256), [null, null]);
    const digest = 'e'.repeat(64);
    const withDigest = resolveRuntimeTable(registry, 'mainnet', { ...options, sha256: sha256Hex, configSha256: { v2: digest } });
    assert.equal(withDigest[1].configSha256, digest);
    assert.notEqual(withDigest[0].configSha256, digest);
    assert.throws(() => resolveRuntimeTable(registry, 'mainnet', { ...options, configSha256: { v2: 'xyz' } }),
        error => error.code === 'schema');
    assert.throws(() => resolveRuntimeTable(registry, 'mainnet', { ...options, sha256: () => 'XYZ' }),
        error => error.code === 'schema');
});

test('resolveRuntimeTable fails closed on a live row without a usable profile', () => {
    assert.throws(() => resolveRuntimeTable(validRegistry(), 'mainnet', { profiles: {} }),
        error => error.code === 'profile_missing');
    assert.throws(() => resolveRuntimeTable(validRegistry(), 'mainnet', { profiles: {
        'mainnet.json': { trusted_deployment: { deployment_id: 'x', chain_id: 1, contract_address: 'not an address' } }
    } }), error => error.code === 'profile');
    assert.throws(() => resolveRuntimeTable(validRegistry(), 'goerli', { profiles: fixtureProfiles() }),
        error => error.code === 'schema');
});

test('versionForDeployment finds the table entry of a deployment id', () => {
    const table = resolvedTable(activatedRegistry(), 'mainnet');
    const [v1, v2] = table;
    assert.equal(versionForDeployment(table, v1.deploymentId), v1);
    assert.equal(versionForDeployment(table, v2.deploymentId), v2);
    assert.equal(versionForDeployment(table, 'unknown'), null);
    assert.equal(versionForDeployment(table, null), null);
    assert.equal(versionForDeployment(null, v1.deploymentId), null);
});

test('adding v3 of the same family is a row, a profile and status flips only', () => {
    const registry = threeVersionRegistry();
    validate(registry);
    // v3 is a concession-v1 row: no new adapter was needed.
    assert.deepEqual(new Set(registry.versions.map(row => row.adapter)), new Set(['note-bound-v1', 'concession-v1']));
    assert.equal(registry.versions[2].adapter, registry.versions[1].adapter);
    // Its identity differs from v2's in every place the rules compare.
    const [, v2, v3] = resolvedTable(registry, 'mainnet');
    assert.notEqual(v3.deploymentId, v2.deploymentId);
    assert.notEqual(v3.vault, v2.vault);
    assert.notEqual(v3.assetBase, v2.assetBase);
    assert.notEqual(v3.proxyPath, v2.proxyPath);
    assert.equal(v3.assetBase, 'zkapi/v3c/');
    // The flip from the previous state is one forward-only change.
    forwardOnly(activatedRegistry(), registry);
    // v3 pending first, as a data-only PR before it activates.
    const pendingV3 = mutated(activatedRegistry(), copy => {
        copy.versions.push({
            id: 'v3', ordinal: 3, label: 'Version 3', adapter: 'concession-v1',
            circuitId: 'zkapi-v2-concession-v1', vaultRevision: 3,
            sdk: { alias: 'zkapi-sdk-v3c', source: null, revision: null, storeSha256: null, patches: [], honorsDepositsFlag: true },
            publicPath: '/zkapi/v3c/', proxyPath: '/zkapi-deployment-v3c/',
            transition: { closeByMarginSeconds: 259200, reminderDays: [7, 3, 1], promptWindowDays: 14 },
            gate: { recoveryReview: { revision: null, verdict: 'pending', patch: null }, protocolWiring: 'pending', manifestSha256: null },
            networks: {
                mainnet: { status: 'pending', config: { deployment_status: 'not_deployed' } },
                sepolia: { status: 'pending', config: { deployment_status: 'not_deployed' } }
            }
        });
    });
    validate(pendingV3);
    assert.deepEqual(resolvedTable(pendingV3, 'mainnet').map(version => version.id), ['v1', 'v2']);
    forwardOnly(activatedRegistry(), pendingV3);
    forwardOnly(pendingV3, registry);
});

test('an unknown adapter or a row that disagrees with its adapter is refused', () => {
    rejects(mutated(validRegistry(), registry => { registry.versions[0].adapter = 'future-family'; }), 'unknown_adapter');
    rejects(mutated(validRegistry(), registry => { registry.versions[0].circuitId = 'zkapi-v2-concession-v1'; }),
        'adapter_mismatch');
    rejects(mutated(validRegistry(), registry => { registry.versions[0].vaultRevision = 3; }), 'adapter_mismatch');
    assert.throws(() => getAdapter('future-family'), error => error.code === 'unknown_adapter');
    assert.throws(() => getAdapter('toString'), error => error.code === 'unknown_adapter');
    assert.throws(() => getAdapter(undefined), error => error.code === 'unknown_adapter');
    assert.deepEqual([...ADAPTER_IDS], ['note-bound-v1', 'concession-v1', 'concession-v2', 'leaf-bound-v2']);
});

test('the transition policy is data and is bounded', () => {
    for (const bad of [
        { closeByMarginSeconds: -1 }, { closeByMarginSeconds: 1.5 }, { closeByMarginSeconds: 91 * 86_400 },
        { promptWindowDays: 0 }, { reminderDays: [3, 7] }, { reminderDays: [7, 7] }, { reminderDays: [0] },
        { reminderDays: [20, 7], promptWindowDays: 14 }, { reminderDays: 'daily' }
    ]) {
        rejects(mutated(validRegistry(), registry => { Object.assign(registry.versions[0].transition, bad); }), 'transition');
    }
    // Per-row policy: a stricter second version is just different data.
    const custom = mutated(activatedRegistry(), registry => {
        registry.versions[0].transition = { closeByMarginSeconds: 86400, reminderDays: [2, 1], promptWindowDays: 3 };
    });
    validate(custom);
    assert.deepEqual(resolvedTable(custom, 'mainnet')[0].transition,
        { closeByMarginSeconds: 86400, reminderDays: [2, 1], promptWindowDays: 3 });
});

test('the give-up policy keys are optional row data, bounded by the family\'s smallest chat key', () => {
    const tier = getAdapter('note-bound-v1').abandon.smallestChatTierUsdMicros;
    assert.equal(tier, 1_000_000);
    const withPolicy = (row, policy) => mutated(activatedRegistry(), registry => {
        Object.assign(registry.versions[row].transition, policy);
    });
    // Absent keys are the default: the shipped registry carries neither.
    for (const row of validRegistry().versions) {
        assert.equal('dustThresholdUsdMicros' in row.transition, false);
        assert.equal('abandonEnabled' in row.transition, false);
    }
    // Every value from "dust leg off" to the smallest chat key is accepted, on
    // either family, and reaches the runtime table untouched.
    for (const row of [0, 1]) {
        for (const dustThresholdUsdMicros of [0, 1, 250_000, tier]) {
            const registry = withPolicy(row, { dustThresholdUsdMicros, abandonEnabled: false });
            validate(registry);
            const resolved = resolvedTable(registry, 'mainnet')[row].transition;
            assert.equal(resolved.dustThresholdUsdMicros, dustThresholdUsdMicros);
            assert.equal(resolved.abandonEnabled, false);
        }
    }
    validate(withPolicy(0, { abandonEnabled: true }));
    // Above the smallest chat key, fractional, negative or not a number: refused.
    for (const bad of [tier + 1, 5_000_000, 0.5, -1, '1000000', null, true, Number.NaN, Number.POSITIVE_INFINITY,
        2 ** 53]) {
        rejects(withPolicy(0, { dustThresholdUsdMicros: bad }), 'transition', /dustThresholdUsdMicros/);
        rejects(withPolicy(1, { dustThresholdUsdMicros: bad }), 'transition', /dustThresholdUsdMicros/);
    }
    for (const bad of ['yes', 1, 0, null, {}]) {
        rejects(withPolicy(0, { abandonEnabled: bad }), 'transition', /abandonEnabled/);
    }
    // A typo is still an unknown field.
    rejects(withPolicy(0, { dustThreshold: 5 }), 'schema', /unknown field "dustThreshold"/);
    rejects(withPolicy(0, { abandonEnable: true }), 'schema', /unknown field "abandonEnable"/);
    // A family that carries no abandon data cannot bound a threshold, so a row
    // of such a family may not name one (it may still switch the action off).
    const bare = { ...getAdapter('note-bound-v1'), abandon: undefined };
    rejects(withPolicy(0, { dustThresholdUsdMicros: 5 }), 'transition', /smallest chat key/,
        { adapters: id => (id === 'note-bound-v1' ? bare : getAdapter(id)) });
    validate(withPolicy(0, { abandonEnabled: false }), { adapters: id => (id === 'note-bound-v1' ? bare : getAdapter(id)) });
});

// ---------------------------------------------------------------------------
// WIRED and purity
// ---------------------------------------------------------------------------

test('WIRED lists exactly the adapter\'s requiredWiring and cannot be changed through its API', () => {
    const required = [...new Set(ADAPTER_IDS.flatMap(id => getAdapter(id).requiredWiring))];
    assert.equal(WIRED.size, required.length);
    assert.deepEqual([...WIRED].sort(), [...required].sort());
    for (const name of required) assert.equal(WIRED.has(name), true, name);
    assert.equal(WIRED.has('not-a-behavior'), false);
    assert.ok(WIRED instanceof Set);
    const before = [...WIRED];
    assert.throws(() => WIRED.add('not-a-behavior'), TypeError);
    assert.throws(() => WIRED.add('service-message'), TypeError);
    assert.throws(() => WIRED.delete('service-message'), TypeError);
    assert.throws(() => WIRED.clear(), TypeError);
    assert.deepEqual([...WIRED], before);
});

test('the registry model, wiring and adapters are pure: no Node built-ins, SDK, network or storage', () => {
    const files = [
        'chat/zkapi/versioning/registryModel.mjs',
        'chat/zkapi/versioning/serviceBase.mjs',
        'chat/zkapi/versioning/wiring.mjs',
        'chat/zkapi/versioning/adapters/index.mjs',
        'chat/zkapi/versioning/adapters/noteBoundV1.mjs',
        'chat/zkapi/versioning/adapters/concessionV1.mjs',
        'chat/zkapi/versioning/adapters/concessionV2.mjs',
        'chat/zkapi/services/tokenAmount.mjs'
    ];
    // Comments may mention anything; only code is checked.
    const withoutComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const file of files) {
        const source = withoutComments(readText(file));
        const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)]
            .map(match => match[1] || match[2]);
        for (const specifier of specifiers) {
            assert.match(specifier, /^\.{1,2}\//, `${file} imports ${specifier}`);
        }
        assert.doesNotMatch(source, /\bimport\s*\(/, `${file} must not import dynamically`);
        assert.doesNotMatch(source, /\brequire\s*\(/, file);
        assert.doesNotMatch(source, /\bprocess\./, file);
        assert.doesNotMatch(source, /\bBuffer\b/, file);
        assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|document|window|navigator|location)\b/,
            file);
        assert.doesNotMatch(source, /@openanonymity|zkapi-browser-sdk/, file);
        // Browser bundles target es2020: nothing that esbuild would have to downlevel or polyfill.
        assert.doesNotMatch(source, /\?\?=|\|\|=|&&=|\bstructuredClone\b|Object\.hasOwn\b|\.at\(|#[a-zA-Z_]+\s*[=;(]/, file);
    }
});

// ---------------------------------------------------------------------------
// One hostname for several deployments (a path prefix on the newer one)
// ---------------------------------------------------------------------------
//
// The old deployment is pinned at the root of its hostname and cannot move.
// The newer one may be served under a plain path prefix of that same hostname
// (versioning/serviceBase.mjs); the pin names the prefix, and so does the
// manifest the service publishes. Identity is the base URL, not the origin.

function onSharedHostname(registry, prefix, { network = 'mainnet', row = 1 } = {}) {
    const origin = noteBoundProfile(network).trusted_deployment.protocol_server_url;
    const base = `${origin}${prefix}`;
    const config = registry.versions[row].networks[network].config;
    config.trusted_deployment.protocol_server_url = base;
    config.trusted_deployment.indexer_url = base;
    config.deployment_manifest_url = `${base}/config.json`;
    config.allowed_deployment_manifest_urls = [`${base}/config.json`];
    return registry;
}

test('a newer version may share the older one\'s hostname under a path prefix', () => {
    for (const network of ['mainnet', 'sepolia']) {
        validate(mutated(activatedRegistry(), registry => onSharedHostname(registry, '/c', { network })));
    }
    // Two prefixes of one hostname are fine as long as neither contains the other.
    validate(mutated(threeVersionRegistry(), registry => {
        onSharedHostname(registry, '/c', { row: 1 });
        onSharedHostname(registry, '/zkapi-v3c', { row: 2 });
    }));
});

test('a prefix is a distinct service only when it does not contain, or sit inside, another', () => {
    rejects(mutated(threeVersionRegistry(), registry => {
        onSharedHostname(registry, '/c', { row: 1 });
        onSharedHostname(registry, '/c/next', { row: 2 });
    }), 'identity_collision', /protocol URL/);
    rejects(mutated(threeVersionRegistry(), registry => {
        onSharedHostname(registry, '/c', { row: 1 });
        onSharedHostname(registry, '/c', { row: 2 });
    }), 'identity_collision', /protocol URL/);
    // Prefixes named after the protocol version, upgrade after upgrade.
    validate(mutated(threeVersionRegistry(), registry => {
        onSharedHostname(registry, '/v0.2', { row: 1 });
        onSharedHostname(registry, '/v0.3', { row: 2 });
    }));
    // The bare registry ids are the protocol's own route names.
    rejects(mutated(activatedRegistry(), registry => onSharedHostname(registry, '/v2')), 'profile', null);
    // A sibling that merely starts with the same letters is another service.
    validate(mutated(threeVersionRegistry(), registry => {
        onSharedHostname(registry, '/c', { row: 1 });
        onSharedHostname(registry, '/cc', { row: 2 });
    }));
});

test('a prefix must be plain: no trailing slash, no protocol route names, no escapes', () => {
    for (const prefix of ['/c/', '/v2', '/V1', '/config.json', '/_bundler', '//c', '/c//d', '/%2e%2e', '/a/b/c/d', '/c?x=1']) {
        const registry = mutated(activatedRegistry(), candidate => {
            const origin = noteBoundProfile('mainnet').trusted_deployment.protocol_server_url;
            const base = `${origin}${prefix}`;
            const config = candidate.versions[1].networks.mainnet.config;
            config.trusted_deployment.protocol_server_url = base;
            config.trusted_deployment.indexer_url = base;
            config.deployment_manifest_url = `${base}/config.json`;
            config.allowed_deployment_manifest_urls = [`${base}/config.json`];
        });
        rejects(registry, 'profile', null);
    }
});

test('the indexer and the manifest follow the service base, not the bare origin', () => {
    // The indexer on the bare origin while the protocol server is under a prefix.
    rejects(mutated(activatedRegistry(), registry => {
        onSharedHostname(registry, '/c');
        const config = registry.versions[1].networks.mainnet.config;
        config.trusted_deployment.indexer_url = noteBoundProfile('mainnet').trusted_deployment.protocol_server_url;
    }), 'profile', /manifest, proxy and proof routes/);
    // The manifest at the origin's /config.json while the service lives under the prefix.
    rejects(mutated(activatedRegistry(), registry => {
        onSharedHostname(registry, '/c');
        const config = registry.versions[1].networks.mainnet.config;
        const origin = noteBoundProfile('mainnet').trusted_deployment.protocol_server_url;
        config.deployment_manifest_url = `${origin}/config.json`;
        config.allowed_deployment_manifest_urls = [`${origin}/config.json`];
    }), 'profile', /manifest, proxy and proof routes/);
});
