import test from 'node:test';
import assert from 'node:assert/strict';
import { ZkapiClient } from '@openanonymity/zkapi-browser-sdk/client';
import { withWalletProviderRead } from '../../chat/zkapi/services/walletProviderAccess.mjs';

const vault = `0x${'11'.repeat(20)}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const externalWallet of ['missing', 'wrong-network']) {
    test(`address quote reads use the configured provider when MetaMask is ${externalWallet}`, async t => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'ethereum');
        const external = externalWallet === 'missing' ? undefined : {
            request() { assert.fail('Address quote must never read the unrelated extension network'); }
        };
        Object.defineProperty(globalThis, 'ethereum', { value: external, configurable: true, writable: true });
        t.after(() => { if (previous) Object.defineProperty(globalThis, 'ethereum', previous); else delete globalThis.ethereum; });
        const client = new ZkapiClient();
        const pending = gate();
        const requests = [];
        const addressProvider = { async request(request) {
            requests.push(request);
            await pending.promise;
            return '0x123';
        } };
        // Exercise the real SDK method used by prepareDepositQuote to read
        // currentRoot, including the SDK's real operation/provider wrapper.
        const quoted = withWalletProviderRead(client, addressProvider,
            () => client.readContractUint(vault, '0xabcdef01'));
        assert.equal(client.walletProviderBusy, true, 'SDK captured address provider before the helper yielded');
        assert.equal(client.ethereum, addressProvider);
        assert.throws(() => client.setWalletProvider(null), { code: 'wallet_provider_busy' });
        assert.equal(globalThis.ethereum, external, 'the extension provider is never overwritten');
        pending.resolve();
        assert.equal(await quoted, 0x123n);
        assert.deepEqual(requests, [{ method: 'eth_call', params: [{ to: vault, data: '0xabcdef01' }, 'latest'] }]);
        client.setWalletProvider(null);
        assert.equal(client.ethereum, external);
    });
}

test('a canceled stale quote cannot activate its provider when an older SDK read finishes', async () => {
    const client = new ZkapiClient();
    const pending = gate();
    const oldProvider = { request: () => pending.promise };
    client.setWalletProvider(oldProvider);
    const activeRead = client.readContractUint(vault, '0xabcdef01');
    const retry = gate();
    let current = true;
    let quoted = false;
    const newProvider = { request() { assert.fail('stale quote cannot reach RPC'); } };
    const stale = withWalletProviderRead(client, newProvider, () => { quoted = true; }, {
        isCurrent: () => current, wait: () => retry.promise
    });
    current = false;
    pending.resolve('0x1');
    await activeRead;
    retry.resolve();
    await assert.rejects(stale, { code: 'address_quote_stopped' });
    assert.equal(quoted, false);
    assert.equal(client.ethereum, oldProvider);
});

test('fresh same-provider quote can enter an explicit address action without waiting on itself', async () => {
    const client = new ZkapiClient();
    const outerRead = gate();
    let calls = 0;
    const addressProvider = { request: () => ++calls === 1 ? outerRead.promise : Promise.resolve('0x2') };
    client.setWalletProvider(addressProvider);
    const active = client.readContractUint(vault, '0xabcdef01');
    assert.equal(client.walletProviderBusy, true);
    assert.equal(await withWalletProviderRead(client, addressProvider,
        () => client.readContractUint(vault, '0xabcdef01')), 2n);
    outerRead.resolve('0x1');
    assert.equal(await active, 1n);
});

test('waiting activation invokes only the still-current read after the SDK releases its provider', async () => {
    const client = new ZkapiClient();
    const pending = gate();
    const oldProvider = { request: () => pending.promise };
    client.setWalletProvider(oldProvider);
    const activeRead = client.readContractUint(vault, '0xabcdef01');
    const retry = gate();
    const addressProvider = { request: async () => '0x3' };
    const read = withWalletProviderRead(client, addressProvider,
        () => client.readContractUint(vault, '0xabcdef01'), { wait: () => retry.promise });
    await tick();
    assert.equal(client.ethereum, oldProvider);
    pending.resolve('0x1');
    await activeRead;
    retry.resolve();
    assert.equal(await read, 3n);
    assert.equal(client.ethereum, addressProvider);
});
