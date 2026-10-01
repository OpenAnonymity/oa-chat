import test from 'node:test';
import assert from 'node:assert/strict';
import accountService from '../../chat/services/accountService.js';
import sessionService from '../../chat/services/sessionService.js';
import syncService from '../../chat/services/encryptedSyncService.js';
import storageEvents from '../../chat/services/storageEvents.js';
import { chatDB } from '../../chat/db.js';
import { ACCOUNT_LOGIN_PENDING_KEY } from '../../chat/services/accountDataLock.js';

const A = '1111111111111111';
const B = '2222222222222222';
const token = 'a'.repeat(43);

function fixture(t, target = B) {
    const saved = new Map([['account-settings', { accountId: A, username: 'olduser' }],
        ['account-key-bundle-v1', { accountId: A }]]);
    const calls = [];
    function mock(object, name, value) {
        const previous = object[name]; object[name] = value;
        t.after(() => { object[name] = previous; });
    }
    mock(globalThis, 'window', {location:{origin:'https://chat.openanonymity.ai'}});
    mock(chatDB, 'getSetting', async key => saved.get(key));
    mock(chatDB, 'saveSetting', async (key,value) => { calls.push(['save',key]); saved.set(key,value); });
    mock(chatDB, 'updateSettings', async (sets,deletes) => {
        calls.push(['commit']);
        for (const {key,value} of sets) saved.set(key,value);
        for (const key of deletes) saved.delete(key);
    });
    mock(sessionService, 'verifySession', async () => true);
    mock(sessionService, 'fetch', async url => {
        calls.push(['fetch',String(url)]);
        if (String(url).endsWith('/complete')) assert.ok(saved.has(ACCOUNT_LOGIN_PENDING_KEY));
        return new Response(JSON.stringify(String(url).endsWith('/session')
            ? {accountId:target,email:'member@example.test',encryptionMode:'PRF_PENDING'}
            : {success:true}), {status:200,headers:{'content-type':'application/json'}});
    });
    mock(storageEvents,'init',()=>{});
    mock(storageEvents,'broadcast',(event)=>calls.push(['broadcast',event]));
    mock(syncService,'clearCredentials',()=>{});
    mock(syncService,'deactivateAccountScope',async id=>calls.push(['snapshot',id]));
    mock(syncService,'clearAll',async()=>{});
    const service = Object.create(Object.getPrototypeOf(accountService));
    service.state = {accountId:A,username:'olduser',sessionVerified:true,busy:false,encryptionMode:'LEGACY_PASSKEY'};
    service.loginGeneration = 2;
    service.syncInitializationGeneration = 1;
    service.masterKey = new Uint8Array(32).fill(8);
    service.cryptoKey = service.syncDerivationKey = service.syncIdKey = {oldKey:true};
    service.setState = patch => Object.assign(service.state,patch);
    service.updateStatus = service.notify = () => {};
    service.persistSettings = async () => {};
    service.clearPersistedMasterKey = async () => {};
    service.loadMasterKey = async () => false;
    service.initializeSync = async () => true;
    service.fetchOAuthKeyring = async () => ({accountId:target,encryptionMode:'PRF_PENDING',wrappers:[]});
    return {service,saved,calls,mock};
}

test('Google can switch from a remembered username account without inheriting its keys', async t => {
    const {service,saved,calls} = fixture(t);
    const oldKey = service.masterKey;
    const result = await service.authenticateWithOAuth('google',{completionToken:token});
    assert.deepEqual(result,{status:'keyring_setup',accountId:B});
    assert.equal(service.state.accountId,B);
    assert.equal(service.state.username,null);
    assert.equal(service.localAccountContinuity,false);
    assert.equal(saved.has('account-key-bundle-v1'),false);
    assert.equal(service.state.oauthSetupRequired,true);
    assert.equal(service.cryptoKey,null);
    assert.ok(oldKey.every(n=>n===0));
    assert.equal(saved.has(ACCOUNT_LOGIN_PENDING_KEY),false);
    assert.ok(calls.some(c=>c[0]==='snapshot' && c[1]===A));
    assert.ok(calls.findIndex(c=>c[0]==='commit') > calls.findIndex(c=>c[0]==='fetch'));
});

test('a lost OAuth exchange keeps a durable marker and blocks old local keys', async t => {
    const {service,saved,mock} = fixture(t);
    mock(sessionService,'fetch',async()=>{throw new Error('network interrupted');});
    assert.equal(await service.authenticateWithOAuth('google',{completionToken:token}),null);
    assert.equal(service.state.sessionVerified,false);
    assert.equal(service.cryptoKey,null);
    assert.ok(saved.has(ACCOUNT_LOGIN_PENDING_KEY));
});

test('a failed durable marker write cannot change the shared server session', async t => {
    const {service,calls,mock} = fixture(t);
    mock(chatDB,'saveSetting',async()=>{throw new Error('storage unavailable');});
    assert.equal(await service.authenticateWithOAuth('google',{completionToken:token}),null);
    assert.equal(calls.some(c=>c[0]==='fetch'),false);
});

test('same-account Google completion preserves the matching saved key bundle', async t => {
    const {service,saved} = fixture(t,A);
    const key = {accountId:A}; saved.set('account-key-bundle-v1',key);
    await service.completeBrowserOAuthSession('google',token,{isCurrent:()=>true,onStarted:()=>{}});
    assert.equal(saved.get('account-key-bundle-v1'),key);
    assert.equal(saved.has(ACCOUNT_LOGIN_PENDING_KEY),false);
});

test('an account change during the exchange cannot commit its stale result', async t => {
    const {service,calls,mock} = fixture(t);
    mock(sessionService,'fetch',async url=>{
        if(String(url).endsWith('/session')) service.loginGeneration++;
        return new Response(JSON.stringify({accountId:B,email:'member@example.test',encryptionMode:'PRF_PENDING'}),{status:200});
    });
    assert.equal(await service.authenticateWithOAuth('google',{completionToken:token}),null);
    assert.equal(calls.some(c=>c[0]==='commit'),false);
});


test('a failed identity commit leaves the marker for safe reload recovery', async t => {
    const {service,saved,mock} = fixture(t);
    mock(chatDB,'updateSettings',async()=>{throw new Error('storage unavailable');});
    assert.equal(await service.authenticateWithOAuth('google',{completionToken:token}),null);
    assert.ok(saved.has(ACCOUNT_LOGIN_PENDING_KEY));
    assert.equal(saved.get('account-settings').accountId,A);
    assert.equal(service.state.sessionVerified,false);
    assert.equal(service.cryptoKey,null);
});

test('an account switch while the keyring loads never offers stale account setup', async t => {
    const {service} = fixture(t);
    service.fetchOAuthKeyring = async () => {
        service.lock({accountChanged:true});
        service.state.accountId=A;
        return {accountId:B,encryptionMode:'PRF_PENDING',wrappers:[]};
    };
    assert.equal(await service.authenticateWithOAuth('google',{completionToken:token}),null);
    assert.equal(service.state.accountId,A);
    assert.equal(service.state.oauthSetupRequired,false);
    assert.equal(service.state.busy,false);
    assert.equal(service.state.action,null);
});


test('a stale OAuth completion does not clear a newer operation busy state', async t => {
    const {service} = fixture(t);
    service.fetchOAuthKeyring = async () => {
        service.lock({accountChanged:true});
        service.oauthLoginOperation = {};
        service.state.action='google_login';
        service.state.busy=true;
        return {accountId:B,encryptionMode:'PRF_PENDING',wrappers:[]};
    };
    assert.equal(await service.authenticateWithOAuth('google',{completionToken:token}),null);
    assert.equal(service.state.busy,true);
    assert.equal(service.state.action,'google_login');
});
