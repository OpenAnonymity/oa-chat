import test from 'node:test';
import assert from 'node:assert/strict';
import accountService from '../../chat/services/accountService.js';
import sessionService from '../../chat/services/sessionService.js';

const accountId = '1234567890123456';
const b64 = value => Buffer.from(value).toString('base64');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function setup(t, interrupt) {
    const service = Object.create(Object.getPrototypeOf(accountService));
    service.state = { accountId, sessionVerified: true, username: 'winter-owl', encryptionMode: 'LEGACY_PASSKEY' };
    service.loginGeneration = 1;
    service.pairingAccountKind = () => 'username';
    const abort = new AbortController();
    const prf = new Uint8Array(32).fill(4), masterKey = new Uint8Array(32).fill(7);
    const aes = await crypto.subtle.importKey('raw', prf, 'AES-GCM', false, ['encrypt']);
    const iv = new Uint8Array(12).fill(3);
    const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv}, aes, masterKey);
    const wrapper = b64(JSON.stringify({iv:b64(iv),ciphertext:b64(encrypted)}));
    const calls = [];
    const oldFetch = sessionService.fetch;
    sessionService.fetch = async (url, options) => {
        const path = new URL(url).pathname;
        calls.push({path, body:JSON.parse(options.body)});
        if (path.endsWith('/challenge')) {
            if (interrupt === 'challenge') service.loginGeneration++;
            return Response.json({ challengeId:'c'.repeat(43), publicKey:{challenge:b64('challenge'),rpId:'localhost'} });
        }
        assert.ok(path.endsWith('/credentials/grant'), 'must not change the login session');
        assert.equal(calls.at(-1).body.tunnelId, 't'.repeat(22));
        assert.equal(calls.at(-1).body.challengeId, 'c'.repeat(43));
        assert.equal(calls.at(-1).body.assertion.id, 'credential');
        if (interrupt === 'grant') service.loginGeneration++;
        return Response.json({grant:'g'.repeat(43),accountId,wrappedKeyPasskey:wrapper});
    };
    t.after(() => { sessionService.fetch = oldFetch; });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis,'navigator');
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{credentials:{get:async options=>{
        assert.equal(options.publicKey.userVerification,'required');
        assert.equal(options.signal,abort.signal);
        if (interrupt === 'prompt') service.loginGeneration++;
        if (interrupt === 'cancel') abort.abort();
        return {id:'credential',rawId:new Uint8Array([1]).buffer,type:'public-key',
            response:{clientDataJSON:new Uint8Array([2]),authenticatorData:new Uint8Array([3]),signature:new Uint8Array([4]),userHandle:null},
            getClientExtensionResults:()=>({prf:{results:{first:prf.buffer}}})};
    }}}});
    t.after(()=>Object.defineProperty(globalThis,'navigator',descriptor));
    return {service,abort,calls,masterKey,prf};
}

test('fresh approval verifies the assertion and unwraps without replacing the session', async t => {
    const f = await setup(t);
    const result = await f.service.approveUsernamePairing({tunnelId:'t'.repeat(22),signal:f.abort.signal});
    assert.deepEqual(result.masterKey,f.masterKey);
    assert.equal(result.grant,'g'.repeat(43));
    assert.equal(f.calls.length,2);
    assert.ok(f.prf.every(b=>b===0));
    assert.equal(f.service.loginGeneration,1);
});
for (const stage of ['challenge','prompt','grant','cancel']) {
    test(`account change/cancel at ${stage} cannot return the key`, async t => {
        const f = await setup(t,stage);
        await assert.rejects(f.service.approveUsernamePairing({tunnelId:'t'.repeat(22),signal:f.abort.signal}),{name:'AbortError'});
        assert.equal(f.calls.length,stage==='grant'?2:1);
        if (stage==='grant') assert.ok(f.prf.every(b=>b===0));
    });
}
