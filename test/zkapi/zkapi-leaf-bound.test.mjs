import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface } from 'ethers';
import codec from 'zkapi-sdk-v4/wallet';
import { BrowserWalletRuntime } from 'zkapi-sdk-v4/runtime';
import { ZkapiClient } from 'zkapi-sdk-v4/client';
import { AddressFundingProvider } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import leaf from '../../chat/zkapi/versioning/adapters/leafBoundV2.mjs';
import activation from '../../chat/zkapi/versioning/adapters/concessionV2.mjs';
import { withdrawalCallNoteId } from '../../chat/zkapi/versioning/callFields.mjs';
import { concessionProfile, concessionClientSnapshot } from './_registryFixtures.mjs';
import { unclassifiedDepositEntryPoints } from '../../chat/zkapi/versioning/depositGuard.mjs';

const word = value => BigInt(value).toString(16).padStart(64, '0');

test('leaf-bound family classifies SDK deposits without an activation wait', () => {
    const client = new ZkapiClient();
    assert.equal(typeof client.getWithdrawalFeeBudget, 'function');
    assert.deepEqual(unclassifiedDepositEntryPoints({ client, runtime: new BrowserWalletRuntime(), adapter: leaf }),
        { client: [], runtime: [] });
    assert.ok(!leaf.requiredWiring.includes('deposit-activation'));
    const snapshot = leaf.normalizeSnapshot(concessionClientSnapshot({ config: { activation: { status: 'activating' } } }));
    assert.equal(snapshot.activation, undefined);
});

test('leaf-bound profile refuses the other revision-4 ABI and missing deposit policy', () => {
    const profile = concessionProfile('sepolia');
    Object.assign(profile.trusted_deployment, { circuit_id: leaf.circuitId, vault_revision: 4 });
    const context = { network: 'sepolia', proxyPath: profile.deployment_api_proxy_path };
    assert.throws(() => leaf.validateProfile(profile, context), /leaf_bound_exit/);
    Object.assign(profile.trusted_deployment, { leaf_bound_exit: 1, min_deposit_units: 1_000_000, fresh_slot_gas: 110_000 });
    assert.equal(leaf.validateProfile(profile, context), profile);
    for (const field of ['min_deposit_units', 'fresh_slot_gas']) {
        assert.throws(() => leaf.validateProfile({ ...profile, trusted_deployment: { ...profile.trusted_deployment, [field]: 0 } }, context), new RegExp(field));
    }
});

test('packed note identity rejects overflowing fields and preserves the full uint32 ID', () => {
    const fields = leaf.callProfile.fields;
    assert.equal(withdrawalCallNoteId(fields, () => (0xffffffffn << 192n) | 1n), 0xffffffffn);
    assert.equal(withdrawalCallNoteId(fields, () => (1n << 224n) | 1n), null);
    assert.equal(withdrawalCallNoteId(fields, () => -1n), null);
    assert.equal(withdrawalCallNoteId(activation.callProfile.fields, () => 7n), 7n);
});

test('leaf-bound SDK calldata and wallet signer agree on packed notes and reject mismatches', async () => {
    const vault = `0x${'22'.repeat(20)}`;
    const destination = `0x${'44'.repeat(20)}`;
    const own = `0x${'66'.repeat(20)}`;
    const funding = { chain_id: 11155111, contract_address: vault, demo_rpc_url: 'https://rpc.example',
        billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000' };
    const provider = new AddressFundingProvider({ getConfig: () => funding,
        protocol: () => ({ adapter: leaf, deploymentId: 'leaf', version: { id: 'v4' } }) });
    const context = await provider.context();
    const signature = '(uint16,uint64,address,uint256,uint256,uint256,uint256,uint256,uint256,uint128,address,uint256,uint8,uint256,uint128,uint64)';
    const abi = new Interface([`function mutualClose(${signature},bytes)`, `function initiateEscapeWithdrawal(${signature},bytes)`]);
    for (const mode of ['mutual', 'escape']) {
        const inputs = { protocol_version: 2, chain_id: 11155111, contract_address: vault,
            note_leaf: '0x11', state_signing_key_x: '0x12', state_signing_key_y: '0x13',
            clearance_signing_key_x: '0x14', clearance_signing_key_y: '0x15', note_id: 7,
            final_balance: 1000, destination, withdrawal_nullifier: '0x16', kind: mode === 'mutual' ? 1 : 0,
            next_nullifier: mode === 'mutual' ? '0x0' : '0x17', conceded: 0,
            valid_until: 1800000000, deposit_amount: 1000, expiry_ts: 1800000010 };
        const plan = { mode, public_inputs: inputs, proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256).toString('base64') } };
        const data = codec.encodeWithdrawal(plan, mode, destination, vault);
        const name = mode === 'mutual' ? 'mutualClose' : 'initiateEscapeWithdrawal';
        const packed = (7n << 192n) | (1000n << 64n) | 1800000010n;
        const tuple = [2, 11155111, vault, 17, 18, 19, 20, 21, packed, 1000, destination, 22,
            inputs.kind, inputs.next_nullifier, 0, 1800000000];
        assert.equal(data, abi.encodeFunctionData(name, [tuple, `0x${'00'.repeat(256)}`]));
        const recovery = { version: 1, kind: 'withdrawal', deploymentId: 'leaf', chainId: 11155111,
            contractAddress: vault, operationId: 'op', submissionId: 'sub', noteId: 7,
            destination, finalBalance: 1000, mode };
        const authorization = { kind: 'withdrawal', destination, noteId: 7, mode, conceded: '0' };
        const validate = (value, auth = authorization) => provider.validateCall(context, own, { from: own, to: vault, data: value }, recovery, auth);
        assert.doesNotThrow(() => validate(data));
        assert.throws(() => validate(data, { ...authorization, noteId: 8 }), { code: 4100 });
        assert.throws(() => validate(data, { ...authorization, destination: own }), { code: 4100 });
        const words = data.slice(10).match(/.{64}/g);
        for (const bad of [(8n << 192n) | 1800000010n, (1n << 224n) | packed, 7n]) {
            const altered = [...words]; altered[8] = word(bad);
            assert.throws(() => validate(`${data.slice(0, 10)}${altered.join('')}`), { code: 4100 });
        }
        const oldSelector = activation.callProfile.exits.find(exit => exit.mode === mode).selector;
        assert.throws(() => validate(`0x${oldSelector}${data.slice(10)}`), { code: 4100 });
    }
});
