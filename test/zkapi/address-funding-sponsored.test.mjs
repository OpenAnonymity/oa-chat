// The Send Ethereum signer and sponsored (ERC-4337) withdrawals.
//
// The browser-held key signs without a prompt, so what it may sign and what
// may leave the browser under it is the whole security of the method:
//
//   personal_sign   only the 32-byte hash of an operation, only for this
//                   address, only inside a running action that carries a
//                   sponsored confirmation, a bounded number of times;
//   the bundler     a transport the provider owns. It forwards a small set of
//                   JSON-RPC methods to the same-origin route and judges an
//                   operation (services/sponsoredOperation.mjs) against the
//                   running action before eth_sendUserOperation leaves.
//
// The operation is Foundry's (test/fixtures/zkapi-sponsored-vectors.json).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet, getBytes, verifyMessage } from 'ethers';
import vectors from '../fixtures/zkapi-sponsored-vectors.json' with { type: 'json' };
import { AddressFundingProvider } from '../../chat/zkapi/services/addressFundingProvider.mjs';
import { readSponsoredPins } from '../../chat/zkapi/services/sponsoredOperation.mjs';
import { concessionV1 } from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { noteBoundV1 } from '../../chat/zkapi/versioning/adapters/noteBoundV1.mjs';

const V = vectors;
const C = V.close;
const BUNDLER = 'https://app.example/zkapi-deployment-v2c/_bundler';
const DEPLOYMENT = 'zkapi-native-eth-sepolia-concession-v1-fixture';
const hex = value => `0x${BigInt(value).toString(16)}`;
const low = value => String(value).toLowerCase();

const trusted = {
    gasless: {
        entry_point_address: V.entry_point,
        withdrawal_paymaster_address: V.paymaster,
        withdrawal_account_factory_address: V.factory,
        account_creation_code: V.account_creation_code,
        account_creation_code_keccak256: V.account_creation_code_keccak256,
        bundler_url: 'https://bundler.example/rpc',
        policy: { max_sponsored_cost_wei: V.policy.max_sponsored_cost, flat_fee_wei: V.policy.flat_fee_wei },
        fee_ceilings: { max_fee_wei: V.policy.max_fee_ceiling, priority_fee_wei: V.policy.priority_fee_ceiling }
    }
};
const pins = readSponsoredPins(trusted);

function vectorOperation(changes = {}) {
    return {
        sender: C.sender, nonce: hex(C.nonce), factory: C.init_code.slice(0, 42), factoryData: `0x${C.init_code.slice(42)}`,
        callData: C.call_data, callGasLimit: hex(C.call_gas_limit), verificationGasLimit: hex(C.verification_gas_limit),
        preVerificationGas: hex(C.pre_verification_gas), maxFeePerGas: hex(C.max_fee_per_gas),
        maxPriorityFeePerGas: hex(C.max_priority_fee_per_gas), paymaster: V.paymaster,
        paymasterVerificationGasLimit: hex(C.paymaster_verification_gas_limit),
        paymasterPostOpGasLimit: hex(C.paymaster_post_op_gas_limit),
        paymasterData: `0x${BigInt(C.fee_cap_wei).toString(16).padStart(24, '0')}`, signature: C.signature, ...changes
    };
}

const authorization = (extra = {}) => ({
    kind: 'withdrawal', destination: V.payee, mode: 'mutual', noteId: Number(C.note_id),
    sponsored: { feeCapWei: C.fee_cap_wei, maxCostWei: C.max_cost }, ...extra
});

function memoryStore() {
    const data = new Map();
    return { data, load: async scope => structuredClone(data.get(scope) ?? null),
        async save(scope, envelope, { createOnly = false } = {}) {
            if (createOnly && data.has(scope)) throw new Error('exists');
            data.set(scope, structuredClone(envelope));
        } };
}

function locks() {
    const tails = new Map();
    return { request(name, options, callback) {
        const before = tails.get(name) || Promise.resolve();
        const run = before.then(() => callback({ name }));
        tails.set(name, run.catch(() => {}));
        return run;
    } };
}

function harness({ adapter = concessionV1, pinned = pins, bundlerUrl = BUNDLER, bundlerAnswers = {} } = {}) {
    const requests = [];
    const funding = { chain_id: V.chain_id, contract_address: V.vault, demo_rpc_url: 'https://rpc.example',
        billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000', demo_billing_token_address: null };
    const transport = async (url, options) => {
        const request = JSON.parse(options.body);
        requests.push({ url, ...request, options });
        if (url === BUNDLER) {
            const answer = bundlerAnswers[request.method];
            if (typeof answer === 'function') return answer(request);
            return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: answer ?? `0x${'ab'.repeat(32)}` }) };
        }
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: hex(V.chain_id) }) };
    };
    const provider = new AddressFundingProvider({
        getConfig: () => funding, store: memoryStore(), locks: locks(), createChannel: () => null,
        createWallet: () => new Wallet(V.owner_private_key), transport,
        protocol: () => ({ adapter, deploymentId: DEPLOYMENT, version: { id: 'v2' } }),
        sponsoredPins: () => pinned, bundlerUrl: () => bundlerUrl
    });
    return { provider, requests, bundlerRequests: () => requests.filter(entry => entry.url === BUNDLER) };
}

const signHash = hash => ({ method: 'personal_sign', params: [hash, V.owner] });
const sendOp = (op = vectorOperation(), entryPoint = V.entry_point) => ({ method: 'eth_sendUserOperation', params: [op, entryPoint] });

test('without the protocol, a pin set or a route, there is no bundler transport and nothing is signed', async () => {
    for (const options of [{ adapter: noteBoundV1 }, { pinned: null }, { bundlerUrl: null }]) {
        const h = harness(options);
        await h.provider.ensureAddress();
        assert.equal(h.provider.zkapiBundler, undefined);
        await assert.rejects(h.provider.withAuthorizedAction(authorization(), () => h.provider.request(signHash(C.user_op_hash))),
            error => error.code === 4100);
    }
    const h = harness();
    assert.equal(typeof h.provider.zkapiBundler?.request, 'function');
    assert.equal(typeof h.provider.zkapiBundler?.sendUserOperation, 'function');
    assert.ok(Object.isFrozen(h.provider.zkapiBundler));
});

test('personal_sign signs a hash only inside a sponsored action, for this address, as the EIP-191 digest of its raw bytes', async () => {
    const h = harness();
    await h.provider.ensureAddress();
    // Outside any action: nothing.
    await assert.rejects(h.provider.request(signHash(C.user_op_hash)), error => error.code === 4100);
    // Inside an action that confirmed a plain (wallet-paid) withdrawal: nothing.
    const plain = authorization();
    delete plain.sponsored;
    await assert.rejects(h.provider.withAuthorizedAction(plain, () => h.provider.request(signHash(C.user_op_hash))),
        error => error.code === 4100);
    // Inside the sponsored action it signs, and the signature is the owner's
    // over the raw 32 bytes, which is what the transit account verifies.
    const signature = await h.provider.withAuthorizedAction(authorization(), () => h.provider.request(signHash(C.user_op_hash)));
    assert.equal(low(verifyMessage(getBytes(C.user_op_hash), signature)), low(V.owner));
    assert.equal(signature, C.signature, 'Foundry signed the same hash with the same key');
    // The address is the provider's, in any casing.
    await h.provider.withAuthorizedAction(authorization(), async () => {
        await h.provider.request({ method: 'personal_sign', params: [C.user_op_hash, V.owner.toUpperCase().replace('0X', '0x')] });
        await assert.rejects(h.provider.request({ method: 'personal_sign', params: [C.user_op_hash, `0x${'12'.repeat(20)}`] }),
            error => error.code === 4100);
    });
});

test('only a 32-byte hash is signed: no message, no typed data, no extra parameters', async () => {
    const h = harness();
    await h.provider.ensureAddress();
    const cases = [
        ['0x68656c6c6f', V.owner], // "hello"
        [`0x${'ab'.repeat(31)}`, V.owner],
        [`0x${'ab'.repeat(33)}`, V.owner],
        ['not hex', V.owner],
        [C.user_op_hash],
        [C.user_op_hash, V.owner, 'extra'],
        [C.user_op_hash, 12]
    ];
    await h.provider.withAuthorizedAction(authorization(), async () => {
        for (const params of cases) {
            await assert.rejects(h.provider.request({ method: 'personal_sign', params }), error => error.code === 4100, JSON.stringify(params));
        }
        for (const method of ['eth_sign', 'eth_signTypedData_v4', 'eth_signTransaction']) {
            await assert.rejects(h.provider.request({ method, params: [V.owner, C.user_op_hash] }), error => error.code === 4200, method);
        }
    });
});

test('one action asks for a bounded number of signatures', async () => {
    const h = harness();
    await h.provider.ensureAddress();
    await h.provider.withAuthorizedAction(authorization(), async () => {
        for (let index = 0; index < 12; index += 1) {
            await h.provider.request(signHash(`0x${index.toString(16).padStart(64, '0')}`));
        }
        await assert.rejects(h.provider.request(signHash(C.user_op_hash)), error => error.code === 4100 && /signature limit/.test(error.message));
    });
    // The next action starts again.
    await h.provider.withAuthorizedAction(authorization(), () => h.provider.request(signHash(C.user_op_hash)));
});

test('the bundler transport forwards a short list of methods to the route and nothing else', async () => {
    const h = harness({ bundlerAnswers: { eth_chainId: '0x7a69', eth_supportedEntryPoints: [V.entry_point] } });
    await h.provider.ensureAddress();
    const bundler = h.provider.zkapiBundler;
    assert.equal(await bundler.request({ method: 'eth_chainId', params: [] }), '0x7a69');
    assert.deepEqual(await bundler.request({ method: 'eth_supportedEntryPoints', params: [] }), [V.entry_point]);
    for (const method of ['eth_getUserOperationReceipt', 'eth_getUserOperationByHash']) {
        await bundler.request({ method, params: [C.user_op_hash] });
    }
    await bundler.request({ method: 'eth_estimateUserOperationGas', params: [vectorOperation({ signature: `0x${'00'.repeat(65)}` }), V.entry_point] });
    const sent = h.bundlerRequests();
    assert.equal(sent.length, 5);
    for (const request of sent) {
        assert.equal(request.url, BUNDLER, 'only the same-origin route is ever called');
        assert.equal(request.options.credentials, 'omit');
        assert.equal(request.options.cache, 'no-store');
        assert.equal(request.options.redirect, 'error');
    }
    // Any other method is not this provider's to forward.
    for (const method of ['eth_sendRawTransaction', 'eth_call', 'debug_traceCall', 'eth_getBalance', 'personal_sign', '']) {
        await assert.rejects(bundler.request({ method, params: [] }), error => error.code === 'bundler_method', method);
    }
    await assert.rejects(bundler.request({ method: 'eth_chainId', params: {} }), error => error.code === 'bundler_method');
    assert.equal(h.bundlerRequests().length, 5, 'nothing else left the browser');
});

test('an operation is sent only inside the action it was confirmed in, and only when it is the confirmed one', async () => {
    const h = harness({ bundlerAnswers: { eth_sendUserOperation: C.user_op_hash } });
    await h.provider.ensureAddress();
    const bundler = h.provider.zkapiBundler;
    const countSends = () => h.bundlerRequests().filter(entry => entry.method === 'eth_sendUserOperation').length;
    // No action: a journaled operation resent from a background check is not
    // an action the person confirmed.
    await assert.rejects(bundler.request(sendOp()), error => /continue the withdrawal/.test(error.message));
    assert.equal(countSends(), 0);
    // An action that confirmed another withdrawal.
    await assert.rejects(h.provider.withAuthorizedAction(authorization({ destination: `0x${'ee'.repeat(20)}` }),
        () => bundler.request(sendOp())), error => error.code === 4100);
    await assert.rejects(h.provider.withAuthorizedAction(authorization({ noteId: 9 }),
        () => bundler.request(sendOp())), error => error.code === 4100);
    await assert.rejects(h.provider.withAuthorizedAction(authorization({ mode: 'escape' }),
        () => bundler.request(sendOp())), error => error.code === 4100);
    assert.equal(countSends(), 0);
    // A different EntryPoint in the call, a changed field, an unsigned copy.
    await assert.rejects(h.provider.withAuthorizedAction(authorization(), () => bundler.request(sendOp(vectorOperation(), `0x${'12'.repeat(20)}`))),
        error => error.code === 4100);
    await assert.rejects(h.provider.withAuthorizedAction(authorization(), () => bundler.request(sendOp(vectorOperation({ callGasLimit: '0x1' })))),
        error => error.code === 4100);
    await assert.rejects(h.provider.withAuthorizedAction(authorization(), () => bundler.request(sendOp(vectorOperation({ signature: '0x' })))),
        error => error.code === 4100);
    assert.equal(countSends(), 0, 'no refused operation reached the route');
    // The confirmed one goes, and the bundler's hash comes back.
    const hash = await h.provider.withAuthorizedAction(authorization(), () => bundler.request(sendOp()));
    assert.equal(hash, C.user_op_hash);
    assert.equal(countSends(), 1);
    const [request] = h.bundlerRequests().filter(entry => entry.method === 'eth_sendUserOperation');
    assert.deepEqual(request.params, [vectorOperation(), V.entry_point]);
});

test('a refusal says why in words, names no bytes, and a bundler refusal keeps its numbers', async () => {
    const h = harness({ bundlerAnswers: { eth_sendUserOperation: request => ({ ok: true, json: async () => ({
        jsonrpc: '2.0', id: request.id, error: { code: -32507, message: 'AA24 signature error', data: { secret: 'x' } } }) }) } });
    await h.provider.ensureAddress();
    const bundler = h.provider.zkapiBundler;
    const refusal = await h.provider.withAuthorizedAction(authorization({ concededMax: '0' }), async () => {
        try {
            await bundler.request(sendOp(vectorOperation({ paymasterData: '0x01' })));
        } catch (error) { return error; }
        return null;
    });
    assert.ok(refusal);
    assert.doesNotMatch(refusal.message, /0x[0-9a-f]{16}/i);
    const forwarded = await h.provider.withAuthorizedAction(authorization(), async () => {
        try { await bundler.request(sendOp()); } catch (error) { return error; }
        return null;
    });
    assert.equal(forwarded.rpcCode, -32507);
    assert.match(forwarded.message, /AA24/);
    assert.deepEqual(forwarded.data, { secret: 'x' });
});

test('an unreachable bundler is bundler_unavailable and an answer for another request is not trusted', async () => {
    const down = harness({ bundlerAnswers: { eth_chainId: () => { throw new Error('offline'); } } });
    await down.provider.ensureAddress();
    await assert.rejects(down.provider.zkapiBundler.request({ method: 'eth_chainId', params: [] }),
        error => error.code === 'bundler_unavailable');
    const wrongId = harness({ bundlerAnswers: { eth_chainId: () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 999, result: '0x1' }) }) } });
    await wrongId.provider.ensureAddress();
    await assert.rejects(wrongId.provider.zkapiBundler.request({ method: 'eth_chainId', params: [] }),
        error => error.code === 'bundler_unavailable');
    const notOk = harness({ bundlerAnswers: { eth_chainId: () => ({ ok: false, json: async () => ({}) }) } });
    await notOk.provider.ensureAddress();
    await assert.rejects(notOk.provider.zkapiBundler.request({ method: 'eth_chainId', params: [] }),
        error => error.code === 'bundler_unavailable');
});

test('a sponsored confirmation does not loosen the transaction rules', async () => {
    const h = harness();
    await h.provider.ensureAddress();
    // A transaction to the vault that does not match the confirmed note.
    const wrong = { from: V.owner, to: V.vault, data: `0x72cd2e44${'00'.repeat(26 * 32)}` };
    await assert.rejects(h.provider.withAuthorizedAction(authorization(), () => h.provider.request({
        method: 'eth_sendTransaction', params: [wrong],
        zkapiRecovery: { version: 1, kind: 'withdrawal', deploymentId: DEPLOYMENT, chainId: V.chain_id, contractAddress: V.vault }
    })), error => error.code === 4100);
    // Plain value sends are still the sweep action's alone.
    await assert.rejects(h.provider.withAuthorizedAction(authorization(), () => h.provider.request({
        method: 'eth_sendTransaction', params: [{ from: V.owner, to: V.payee, value: '0x1' }], zkapiRecovery: null
    })), error => error.code === 4100);
});
