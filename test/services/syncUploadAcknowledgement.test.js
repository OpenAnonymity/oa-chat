import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDB } from '../../chat/db.js';
import { SyncService } from '../../chat/services/encryptedSyncService.js';
import { MAX_SYNC_UPLOAD_BYTES } from '../../chat/services/syncUploadBatches.js';

function fixture(t) {
    const settings = new Map([
        ['sync-account-scope', 'account-a'], ['account-settings', {accountId:'account-a'}],
        ['sync-lastSyncTime', 10], ['sync-schema-version', 3]
    ]);
    const originals = {getSetting:chatDB.getSetting, saveSetting:chatDB.saveSetting, error:console.error};
    chatDB.getSetting = async key => structuredClone(settings.get(key));
    chatDB.saveSetting = async (key, value) => settings.set(key, structuredClone(value));
    console.error = () => {};
    t.after(() => {chatDB.getSetting=originals.getSetting;chatDB.saveSetting=originals.saveSetting;console.error=originals.error;});
    function make() {
        const service = new SyncService();
        service.setCredentials(new Uint8Array(32).fill(1),'account-a');
        service._buildIdMapping = async () => new Map();
        service._pull = async () => { settings.set('sync-lastSyncTime',20); return {count:1}; };
        service._collectLocalBlobs = async () => [{id:'one',ciphertext:'synthetic',iv:'iv',version:1}];
        return service;
    }
    return {settings, make, service:make()};
}

test('pull success followed by rejected upload stays pending after status and restart; retry clears only after acceptance', async t => {
    const {service, settings, make} = fixture(t);
    service.fetchWithRetry = async () => {throw new Error('Desktop account request body is too large');};
    assert.equal((await service.sync()).success,false);
    assert.equal(settings.get('sync-lastSyncTime'),20);
    assert.equal(settings.get('sync-upload-pending'),true);
    const failure = service.lastSyncResult;
    service.fetchWithRetry = async () => Response.json({last_sync:20});
    assert.equal(await service.hasRemoteChanges(),false);
    assert.equal(service.lastSyncResult,failure);
    assert.equal(service.lastSyncTime,null);
    const restored = make();
    restored.fetchWithRetry = async (_, init) => Response.json(init.method==='POST' ? {accepted:['one']} : {last_sync:20});
    await restored.hasRemoteChanges();
    assert.equal(restored.lastSyncResult.pending,true);
    assert.equal((await restored.syncIfNeeded()).success,true);
    assert.equal(settings.get('sync-upload-pending'),false);
    assert.equal(restored.lastSyncResult.success,true);
});

for (const accepted of [undefined, [], ['wrong'], ['one','one']]) {
    test(`HTTP 200 with incomplete or invalid acknowledgment ${JSON.stringify(accepted)} stays pending`, async t => {
        const {service, settings} = fixture(t);
        service.fetchWithRetry = async () => Response.json({accepted});
        const result = await service.sync();
        assert.equal(result.success,false);
        assert.match(result.error,/not fully accepted/);
        assert.equal(settings.get('sync-upload-pending'),true);
    });
}

test('a partial later batch cannot acknowledge the full upload', async t => {
    const {service,settings} = fixture(t);
    service._collectLocalBlobs = async () => Array.from({length:101},(_,i)=>({id:String(i)}));
    let attempts=0;
    service.fetchWithRetry = async (_,request) => {
        attempts++;
        return Response.json({accepted:attempts===1 ? JSON.parse(request.body).blobs.map(b=>b.id) : []});
    };
    assert.equal((await service.sync()).success,false);
    assert.equal(attempts,2);
    assert.equal(settings.get('sync-upload-pending'),true);
});

test('status polling cannot claim success while an upload is held on the wire', async t => {
    const {service} = fixture(t);
    let release, started;
    const pending = new Promise(resolve=>{started=resolve;});
    service.fetchWithRetry = async (_, init) => {
        if(init.method==='GET') return Response.json({last_sync:20});
        started();return new Promise(resolve=>{release=()=>resolve(Response.json({accepted:['one']}));});
    };
    const syncing=service.sync();await pending;
    const status = service.hasRemoteChanges();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.lastSyncResult,null);
    assert.equal(service.lastSyncTime,null);
    release();assert.equal((await syncing).success,true);
    await status;
});

test('new-account status does not inherit the previous account upload failure', async t => {
    const {service,settings} = fixture(t);
    service.lastSyncResult={success:false,error:'account A'};
    service.setCredentials(new Uint8Array(32).fill(2),'account-b');
    settings.set('sync-account-scope','account-b');
    settings.set('account-settings',{accountId:'account-b'});
    settings.set('sync-upload-pending',false);
    settings.set('sync-upload-ack',await service.uploadFingerprint(await service.readUploadSnapshot()));
    service.fetchWithRetry=async()=>Response.json({last_sync:10});
    await service.hasRemoteChanges();
    assert.equal(service.lastSyncResult,null);
    assert(service.getAccountScopedSettingKeys().includes('sync-upload-pending'));
});


test('accepted upload then local change before debounce stays pending after restart', async t => {
    const {service,settings,make} = fixture(t);
    service.fetchWithRetry = async () => Response.json({accepted:['one']});
    assert.equal((await service.sync()).success,true);
    settings.set('tickets-active',[{finalized_ticket:'synthetic-new-ticket'}]);
    const restored=make();
    const observed=[];
    restored.subscribe(({event}) => { if(event==='sync_status_changed') observed.push(restored.lastSyncResult); });
    restored.fetchWithRetry = async (_,init) => Response.json(init.method==='POST' ? {accepted:['one']} : {last_sync:20});
    assert.equal(await restored.hasRemoteChanges(),false);
    assert.equal(restored.uploadPending,true);
    assert.equal(observed.length,1);
    assert.equal(observed[0].pending,true);
    assert.equal(restored.lastSyncResult.success,false);
    assert.equal((await restored.syncIfNeeded()).success,true);
    assert.equal(restored.uploadPending,false);
});

test('local mutation during an upload never acknowledges the newer snapshot', async t => {
    const {service,settings} = fixture(t);
    service.fetchWithRetry = async () => {
        settings.set('pref-theme','dark');
        return Response.json({accepted:['one']});
    };
    const result=await service.sync();
    assert.equal(result.success,false);
    assert.equal(settings.get('sync-upload-pending'),true);
    assert.equal(settings.has('sync-upload-ack'),false);
});

test('size-based batches retry fully after later HTTP failure, acknowledging only a complete pass', async t => {
    const {service,settings} = fixture(t);
    service._collectLocalBlobs = async () => ['a','b','c'].map(id => ({id,ciphertext:'x'.repeat(2_000_000)}));
    const attempted=[];
    service.fetchWithRetry = async (_, request) => {
        assert(Buffer.byteLength(request.body)<=MAX_SYNC_UPLOAD_BYTES);
        const ids=JSON.parse(request.body).blobs.map(b=>b.id);
        attempted.push(ids);
        return attempted.length===2 ? new Response('',{status:413}) : Response.json({accepted:ids});
    };
    assert.equal((await service.sync()).success,false);
    assert.deepEqual(attempted,[['a'],['b']]);
    assert.equal(settings.get('sync-upload-pending'),true);
    assert.equal(settings.has('sync-upload-ack'),false);
    assert.equal((await service.sync()).success,true);
    assert.deepEqual(attempted,[['a'],['b'],['a'],['b'],['c']]);
    assert.equal(settings.get('sync-upload-pending'),false);
});

test('single oversized item leaves local wallet pending and sends no earlier batches', async t => {
    const {service,settings} = fixture(t);
    const wallet=[{finalized_ticket:'synthetic-preserved'}];
    settings.set('tickets-active',wallet);
    service._collectLocalBlobs = async () => [{id:'fits'}, {id:'too-large',ciphertext:'x'.repeat(MAX_SYNC_UPLOAD_BYTES)}];
    let sends=0;
    service.fetchWithRetry = async () => {sends++;return Response.json({accepted:[]});};
    const result=await service.sync();
    assert.equal(result.success,false);
    assert.match(result.error,/local data is kept/);
    assert.equal(sends,0);
    assert.deepEqual(settings.get('tickets-active'),wallet);
    assert.equal(settings.get('sync-upload-pending'),true);
});
