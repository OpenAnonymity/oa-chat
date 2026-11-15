import test from 'node:test';
import assert from 'node:assert/strict';
import accountService from '../../chat/services/accountService.js';
import sessionService from '../../chat/services/sessionService.js';
import syncService from '../../chat/services/encryptedSyncService.js';
import {chatDB} from '../../chat/db.js';
import {createEncryptionKeyWrapperFromPrf, unlockEncryptionKeyringFromPrf} from '../../chat/services/encryptionPasskey.js';

const A='1111111111111111', B='2222222222222222';
const oldId='b2xkLWNyZWRlbnRpYWw', newId='bmV3LWNyZWRlbnRpYWw';
const oldPrf=new Uint8Array(32).fill(3), newPrf=new Uint8Array(32).fill(7);
const original=new Uint8Array(32).fill(19);
const journalKey=`account-passkey-upgrade:${A}`;
const credential=(id,prf)=>({id,getClientExtensionResults:()=>({prf:{enabled:true,results:{first:prf.slice().buffer}}})});
async function setup(t) {
    const settings=new Map([['account-settings',{accountId:A}]]);
    const wrappers=[await createEncryptionKeyWrapperFromPrf(original.slice(),oldId,oldPrf.slice())];
    const calls={create:0,post:0,finish:0};
    const replace=(obj,key,value)=>{const d=Object.getOwnPropertyDescriptor(obj,key);Object.defineProperty(obj,key,{value,writable:true,configurable:true});t.after(()=>d?Object.defineProperty(obj,key,d):delete obj[key]);};
    replace(globalThis,'window',{location:{origin:'https://chat.openanonymity.ai'},PublicKeyCredential:class{}});
    const credentials={
        get:async ({publicKey})=>publicKey.rpId
            ? credential(oldId,oldPrf):credential(newId,newPrf),
        create:async ({publicKey})=>{
            calls.create++;
            assert.equal(publicKey.rp.id,undefined,'new credential uses current origin');
            assert.equal(publicKey.authenticatorSelection.userVerification,'required');
            return credential(newId,newPrf);
        }
    };
    replace(globalThis,'navigator',{credentials});
    replace(chatDB,'getSetting',async key=>settings.get(key));
    replace(chatDB,'saveSetting',async (key,value)=>settings.set(key,structuredClone(value)));
    replace(chatDB,'deleteSetting',async key=>settings.delete(key));
    replace(chatDB,'compareAndSetSetting',async (key,expected,value)=>{
        if(JSON.stringify(settings.get(key)??null)!==JSON.stringify(expected??null))return false;
        settings.set(key,structuredClone(value));return true;
    });
    replace(chatDB,'deleteSettingsIfUnchanged',async (expected,keys)=>{
        if(!expected.every(({key,value})=>JSON.stringify(settings.get(key)??null)===JSON.stringify(value??null)))return false;
        keys.forEach(key=>settings.delete(key));return true;
    });
    replace(syncService,'clearCredentials',()=>{});
    replace(syncService,'stopPeriodicSync',()=>{});
    let loseReply=false, autoContinue=true;
    replace(sessionService,'fetch',async (_url,options)=>{
        calls.post++;
        const body=JSON.parse(options.body);
        assert.equal(body.operation,'ADD');
        assert.equal(body.expectedAccountId,A);
        assert.ok(settings.has(journalKey),'persist opaque retry before upload');
        if(!wrappers.some(x=>x.credentialId===body.credentialId)) wrappers.push(body);
        if(loseReply) throw new Error('reply lost');
        return new Response(JSON.stringify({success:true,credentialId:newId}),{status:200});
    });
    const makeService=()=>{
        const service=Object.create(Object.getPrototypeOf(accountService));
        service.state={accountId:A,sessionVerified:true,oauthProvider:'google',oauthEmail:'member@example.test',oauthKeyringRequired:true,encryptionMode:'PRF',busy:false};
        service.loginGeneration=1;service.syncInitializationGeneration=1;service.keyringWrappers=wrappers;
        service.setState=patch=>{
            Object.assign(service.state,patch);
            if(autoContinue && patch.action==='google_key_migration_ready') queueMicrotask(()=>service.continuePasskeyUpgrade());
        };
        service.notify=service.updateStatus=()=>{};
        service.fetchOAuthKeyring=async()=>({accountId:A,accountBinding:true,wrappers});
        service.finishOAuthKeyUnlock=async (key,id)=>{
            calls.finish++; assert.deepEqual(key,original);assert.equal(id,newId);key.fill(0);return true;
        };
        return service;
    };
    return {service:makeService(),makeService,settings,wrappers,calls,credentials,
        loseReply:value=>{loseReply=value;}, autoContinue:value=>{autoContinue=value;}};
}

test('preview recovery adds a final-domain passkey for the same key without replacing the old one',async t=>{
    const f=await setup(t); const oldWrapper=structuredClone(f.wrappers[0]);
    assert.equal(await f.service.unlockOAuthKeyring(null,{usePrelaunchPasskey:true}),true);
    assert.deepEqual(f.wrappers[0],oldWrapper);
    assert.equal(f.wrappers.length,2);assert.equal(f.calls.create,1);assert.equal(f.calls.finish,1);
    const newUnlock=await unlockEncryptionKeyringFromPrf(f.wrappers,newId,newPrf.slice());
    assert.deepEqual(newUnlock.masterKey,original);newUnlock.masterKey.fill(0);
    assert.equal(f.settings.has(journalKey),false);
});

test('a cancelled new passkey does not upload or replace any wrapper',async t=>{
    const f=await setup(t);
    f.credentials.create=async()=>{throw Object.assign(new Error('cancelled'),{name:'NotAllowedError'});};
    assert.equal(await f.service.unlockOAuthKeyring(null,{usePrelaunchPasskey:true}),false);
    assert.equal(f.calls.post,0);assert.equal(f.calls.finish,0);assert.equal(f.wrappers.length,1);
});

test('reload after a lost reply retries the same encrypted wrapper without creating another credential',async t=>{
    const f=await setup(t);f.loseReply(true);
    assert.equal(await f.service.unlockOAuthKeyring(null,{usePrelaunchPasskey:true}),false);
    assert.ok(f.settings.has(journalKey));assert.equal(f.wrappers.length,2);
    const saved=JSON.stringify(f.settings.get(journalKey));
    assert.ok(!saved.includes('masterKey'));assert.ok(!saved.includes('prf'));
    f.loseReply(false);
    assert.equal(await f.makeService().unlockOAuthKeyring(null,{usePrelaunchPasskey:true}),true);
    assert.equal(f.calls.create,1);assert.equal(f.calls.post,2);assert.equal(f.wrappers.length,2);
    assert.equal(f.settings.has(journalKey),false);
});

test('account switch during credential creation cannot save or upload to the replacement account',async t=>{
    const f=await setup(t);
    f.credentials.create=async()=>{f.service.lock({accountChanged:true});f.service.state.accountId=B;return credential(newId,newPrf);};
    assert.equal(await f.service.unlockOAuthKeyring(null,{usePrelaunchPasskey:true}),false);
    assert.equal(f.calls.post,0);assert.equal(f.settings.has(journalKey),false);assert.equal(f.calls.finish,0);
    assert.equal(f.service.state.busy,false);
});

test('old backend without account-bound additions refuses migration before any native prompt',async t=>{
    const f=await setup(t);f.service.fetchOAuthKeyring=async()=>({accountId:A,wrappers:f.wrappers});
    f.credentials.get=async()=>{assert.fail('native prompt must not open');};
    assert.equal(await f.service.unlockOAuthKeyring(null,{usePrelaunchPasskey:true}),false);
    assert.equal(f.calls.post,0);
});

test('closing the dialog aborts creation and cannot publish a late result',async t=>{
    const f=await setup(t);
    f.credentials.create=async({signal})=>{f.service.abortPasskeyCeremony();assert.equal(signal.aborted,true);return credential(newId,newPrf);};
    assert.equal(await f.service.unlockOAuthKeyring(null,{usePrelaunchPasskey:true}),false);
    assert.equal(f.calls.post,0);assert.equal(f.calls.finish,0);assert.equal(f.service.state.busy,false);
});

test('new credential waits for its own click and starts within that click without another await',async t=>{
    const f=await setup(t);f.autoContinue(false);
    const ready=Promise.withResolvers();
    const setState=f.service.setState;
    f.service.setState=patch=>{setState(patch);if(patch.action==='google_key_migration_ready')ready.resolve();};
    const result=f.service.unlockOAuthKeyring(null,{usePrelaunchPasskey:true});
    await ready.promise;
    assert.equal(f.calls.create,0);assert.equal(f.calls.post,0);
    f.service.continuePasskeyUpgrade();
    assert.equal(f.calls.create,1,'native creation starts synchronously in click');
    f.service.continuePasskeyUpgrade();
    assert.equal(f.calls.create,1,'double-click cannot start a second ceremony');
    assert.equal(await result,true);
});

test('closing while waiting for the confirmation click settles and clears the continuation',async t=>{
    const f=await setup(t);f.autoContinue(false);
    const ready=Promise.withResolvers();
    const setState=f.service.setState;
    f.service.setState=patch=>{setState(patch);if(patch.action==='google_key_migration_ready')ready.resolve();};
    const result=f.service.unlockOAuthKeyring(null,{usePrelaunchPasskey:true});
    await ready.promise;f.service.abortPasskeyCeremony();
    assert.equal(await result,false);assert.equal(f.service.state.busy,false);
    assert.equal(f.service.passkeyUpgradeContinuation,null);assert.equal(f.calls.create,0);
});

test('another tab winning the journal during a native prompt is never overwritten or posted over',async t=>{
    const f=await setup(t);
    const otherWrapper={...f.wrappers[0],credentialId:'b3RoZXI'};
    const winner={accountId:A,wrapper:otherWrapper};
    f.credentials.create=async()=>{
        f.settings.set(journalKey,structuredClone(winner));
        return credential(newId,newPrf);
    };
    assert.equal(await f.service.unlockOAuthKeyring(null,{usePrelaunchPasskey:true}),false);
    assert.deepEqual(f.settings.get(journalKey),winner);
    assert.equal(f.calls.post,0);assert.equal(f.wrappers.length,1);
});

test('confirmation cannot delete another tab’s newer journal',async t=>{
    const f=await setup(t);
    const winner={accountId:A,wrapper:{...f.wrappers[0],credentialId:'b3RoZXI'}};
    f.service.fetchOAuthKeyring=async()=>{
        if(f.calls.post)f.settings.set(journalKey,structuredClone(winner));
        return {accountId:A,accountBinding:true,wrappers:f.wrappers};
    };
    assert.equal(await f.service.unlockOAuthKeyring(null,{usePrelaunchPasskey:true}),true);
    assert.deepEqual(f.settings.get(journalKey),winner);
});
