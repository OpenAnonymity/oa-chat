import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface } from 'ethers';
import codec from 'zkapi-sdk-v3/wallet';
import { AddressFundingProvider } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import v3 from '../../chat/zkapi/versioning/adapters/concessionV2.mjs';
import v2 from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { renderBalanceExtras } from '../../chat/zkapi/components/BalanceExtras.js';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import { concessionProfile, concessionClientSnapshot, NOW_MS } from './_registryFixtures.mjs';
import { unclassifiedDepositEntryPoints } from '../../chat/zkapi/versioning/depositGuard.mjs';
import { BrowserWalletRuntime } from 'zkapi-sdk-v3/runtime';
import { ZkapiClient } from 'zkapi-sdk-v3/client';

test('revision 4 classifies every deposit and recovery entry point and carries the fee quote', () => {
    const runtime = new BrowserWalletRuntime();
    const client = new ZkapiClient();
    assert.deepEqual(unclassifiedDepositEntryPoints({ client, runtime, adapter: v3 }), { client: [], runtime: [] });
    assert.equal(typeof client.getWithdrawalFeeBudget, 'function');
});

test('revision 4 profiles require the new circuit and revision together', () => {
    const profile = concessionProfile('sepolia');
    const ctx = { network: 'sepolia', proxyPath: profile.deployment_api_proxy_path };
    assert.throws(() => v3.validateProfile(profile, ctx), /circuit/);
    profile.trusted_deployment.circuit_id = v3.circuitId;
    assert.throws(() => v3.validateProfile(profile, ctx), /revision 4/);
    profile.trusted_deployment.vault_revision = 4;
    assert.equal(v3.validateProfile(profile, ctx), profile);
    assert.throws(() => v2.validateProfile(profile, ctx), /circuit/);
});

test('wiring:deposit-activation confirmed deposits show waiting, pause and unknown status without blocking exits', () => {
    const active = { id: 'v3', label: 'Version 3', ordinal: 3, adapter: 'concession-v2', status: 'active' };
    for (const [status, paused, pattern] of [
        ['activating', false, /waiting for activation.*withdraw before activation/],
        ['activating', true, /paused by the vault owner/],
        ['unknown', false, /Checking whether/]
    ]) {
        const raw = concessionClientSnapshot({
            wallet: { has_note: true, note: { note_id: 7, expiry_ts: NOW_MS / 1000 + 864000 } },
            config: { activation: { status, queue_position: 2, vault_paused: paused, secret: 'must-not-copy' } }
        });
        const snapshot = v3.normalizeSnapshot(raw);
        assert.deepEqual(snapshot.activation, { status, queuePosition: 2, paused });
        const state = deriveVersionState({ active, table: [active], target: active, snapshot,
            adapter: v3, now: NOW_MS, selection: { version: active, reason: 'runtime_holds_note', slotOwner: 'v3' } });
        assert.match(renderBalanceExtras(state), pattern);
        assert.equal(state.exit?.frozen ?? null, null);
        assert.doesNotMatch(JSON.stringify(state), /must-not-copy/);
    }
    assert.equal(renderBalanceExtras({ activation: { status: 'activated' } }), '');
});

test('revision 4 encoder and signer accept note-bound exits and refuse old or altered calls', async () => {
    const vault = `0x${'22'.repeat(20)}`;
    const destination = `0x${'44'.repeat(20)}`;
    const own = `0x${'66'.repeat(20)}`;
    const funding = { chain_id: 11155111, contract_address: vault, demo_rpc_url: 'https://rpc.example',
        billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000' };
    const provider = new AddressFundingProvider({ getConfig: () => funding,
        protocol: () => ({ adapter: v3, deploymentId: 'd', version: { id: 'v3' } }) });
    const ctx = await provider.context();
    const signature = '(uint16,uint64,address,uint256,uint256,uint256,uint256,uint256,uint32,uint128,address,uint256,uint8,uint256,uint128,uint64,uint256)';
    const abi = new Interface([`function mutualClose(${signature},bytes)`, `function initiateEscapeWithdrawal(${signature},bytes)`]);
    for (const mode of ['mutual', 'escape']) {
        const inputs = { protocol_version: 2, chain_id: 11155111, contract_address: vault,
            registration_commitment: '0x11', state_signing_key_x: '0x12', state_signing_key_y: '0x13',
            clearance_signing_key_x: '0x14', clearance_signing_key_y: '0x15', note_id: 7,
            final_balance: 1000, destination, withdrawal_nullifier: '0x16', kind: mode === 'mutual' ? 1 : 0,
            next_nullifier: mode === 'mutual' ? '0x0' : '0x17', conceded: 0,
            valid_until: 1800000000, deposit_amount: 1000, expiry: 1800000010 };
        const plan = { mode, public_inputs: inputs, proof: { backend: 'groth16_bn254', proof: Buffer.alloc(256).toString('base64') } };
        const data = codec.encodeWithdrawal(plan, mode, destination, vault);
        const name = mode === 'mutual' ? 'mutualClose' : 'initiateEscapeWithdrawal';
        const tuple = [2, 11155111, vault, 17, 18, 19, 20, 21, 7, 1000, destination, 22,
            inputs.kind, inputs.next_nullifier, 0, 1800000000, (1800000010n << 128n) | 1000n];
        assert.equal(data, abi.encodeFunctionData(name, [tuple, `0x${'00'.repeat(256)}`]));
        const recovery = { version: 1, kind: 'withdrawal', deploymentId: 'd', chainId: 11155111,
            contractAddress: vault, operationId: 'op', submissionId: 'sub', noteId: 7,
            destination, finalBalance: 1000, mode };
        const authorization = { kind: 'withdrawal', destination, noteId: 7, mode, conceded: '0' };
        assert.doesNotThrow(() => provider.validateCall(ctx, own, { from: own, to: vault, data }, recovery, authorization));
        assert.throws(() => provider.validateCall(ctx, own, { from: own, to: vault, data }, recovery,
            { ...authorization, destination: own }), { code: 4100 });
        const oldSelector = v2.callProfile.exits.find(exit => exit.mode === mode).selector;
        assert.throws(() => provider.validateCall(ctx, own, { from: own, to: vault, data: `0x${oldSelector}${data.slice(10)}` },
            recovery, authorization), { code: 4100 });
    }
});
