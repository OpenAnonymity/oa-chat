import test from 'node:test';
import assert from 'node:assert/strict';
function installBrowser() {
    const keys = ['window', 'location', 'localStorage', 'sessionStorage', 'document', 'fetch', 'requestAnimationFrame'];
    const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    const location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
    const values = {
        window: { ...events, location, localStorage: storage, sessionStorage: storage },
        location, localStorage: storage, sessionStorage: storage,
        document: { ...events, querySelector: () => null, getElementById: () => null, activeElement: null,
            documentElement: { classList: { contains: () => false }, dataset: {} } },
        fetch: async () => { throw new Error('These controller tests must never use the network.'); },
        requestAnimationFrame: callback => callback()
    };
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    };
}


const restore=installBrowser();
globalThis.__OA_STAGING_TIMING__=true;
const timing=await import('../../chat/services/stagingRequestTiming.js');
const {default:api}=await import('../../chat/api.js');
const {default:backend}=await import('../../chat/services/inference/backends/openRouterBackend.js');
const {createInferenceService}=await import('../../chat/services/inference/inferenceService.js');
const {default:preferences}=await import('../../chat/services/preferencesStore.js');
const oldPreference=preferences.getPreference;preferences.getPreference=async()=>false;
const {ChatApp}=await import('../../chat/app.js');preferences.getPreference=oldPreference;
const rows=[];timing.setStagingTimingSink(row=>rows.push(row));

test('enabled actual service/backend/API path records milestones and strips SDK options',async()=>{
    rows.length=0;const controller=new AbortController();timing.startRequestTiming(controller.signal);
    const recorder=timing.requestTiming(controller.signal,'single','test/model');
    const options=api.options, transport=api.networkTransport;let sdkOptions, dispatched=0, text='';
    api.options={acquireRequestAccess:async(_token,opts)=>{sdkOptions=opts;opts.onProgress({phase:'verifying'});opts.onProgress({phase:'ready'});return {apiKey:'private-key',baseUrl:'https://fake.invalid',headers:{Authorization:'Bearer private-key'},release:async()=>{}};}};
    api.networkTransport={fetchWithRetry:async()=>{dispatched++;return new Response('data: '+JSON.stringify({choices:[{delta:{reasoning:'private reasoning'}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{content:'private answer'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});}};
    try {
        const service=createInferenceService({backends:[{...backend,getAccessToken:()=>null}]});
        await service.streamCompletion([{role:'user',content:'private prompt'}],'test/model',{},chunk=>{text+=chunk;},()=>{},[],false,controller,()=>{},()=>{},true,'medium',()=>{},()=>{},recorder);
        timing.finishRequestTiming(controller.signal);
        assert.equal(dispatched,1);assert.match(text,/private answer/);assert.equal(Object.hasOwn(sdkOptions,'requestTiming'),false);
        assert.equal(rows.length,1);assert.equal(rows[0].outcome,'complete');
        for(const field of ['access_ms','verification_ms','provider_dispatch_ms','response_headers_ms','first_reasoning_ms','first_answer_ms'])assert.equal(typeof rows[0][field],'number',field);
        assert.doesNotMatch(JSON.stringify(rows),/private|prompt|Authorization/);
    } finally {api.options=options;api.networkTransport=transport;}
});

test('new Parallel composer waits for real session and early preparation failure keeps lane records',()=>{
    rows.length=0;const controller=new AbortController();timing.startRequestTiming(controller.signal);
    const app=Object.assign(Object.create(ChatApp.prototype),{
        isCouncilModeActive:session=>session?.council===true,
        getModelsForSession:()=>[{id:'test/single',name:'Single'}],
        councilController:{resolveModelEntries:()=>[{laneId:'primary',id:'test/one'},{laneId:'secondary',id:'test/two'}]}
    });
    app.initializeRequestTimings(controller.signal,undefined,'Single');
    app.initializeRequestTimings(controller.signal,{council:true},'Single');
    timing.finishRequestTiming(controller.signal,'error');
    assert.deepEqual(rows.map(row=>[row.model,row.lane,row.outcome]),[['test/one','parallel','error'],['test/two','parallel','error']]);
    assert.ok(rows.every(row=>row.first_answer_ms===null));
});

// The new resend wrapper keeps the existing staging record open across a
// failed attempt. A transport AbortError must not freeze it as cancelled.
for (const fault of ['429', 'transport-abort', 'stop']) {
    test(`staging timing survives provider recovery: ${fault}`, async () => {
        rows.length = 0;
        const controller = new AbortController();
        timing.startRequestTiming(controller.signal);
        const options = api.options, transport = api.networkTransport;
        let dispatched = 0;
        api.options = { acquireRequestAccess: async () => ({ apiKey: 'synthetic', baseUrl: 'https://fake.invalid', release: async () => {} }) };
        api.networkTransport = { fetchWithRetry: async () => {
            if (++dispatched === 1) {
                if (fault === 'stop') controller.abort();
                if (fault !== '429') throw new DOMException('The operation was aborted.', 'AbortError');
                return new Response(JSON.stringify({ error: { code: 429 } }), { status: 429, headers: { 'retry-after': '1' } });
            }
            return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
        } };
        const app = Object.assign(Object.create(ChatApp.prototype), {
            runtime: { recordUsage: async () => {}, discardUsagePreview: async () => {} },
            state: { models: [] },
            inferenceService: createInferenceService({ backends: [{ ...backend, getAccessToken: () => null }] }),
            usesTicketAccess: () => false,
            getModelsForSession: () => [],
            setSessionPendingProgress() {}, setInferenceHealth() {}
        });
        try {
            const pending = app.streamCompletionWithRuntime([], 'test/model', { id: 'session' }, () => {}, null,
                [], false, controller, null, null, false, 'medium', 'synthetic-request');
            if (fault === 'stop') await assert.rejects(pending);
            else await pending;
            timing.finishRequestTiming(controller.signal);
            assert.equal(dispatched, fault === 'stop' ? 1 : 2);
            assert.equal(rows.length, 1, 'one record for the logical reply');
            assert.equal(rows[0].outcome, fault === 'stop' ? 'cancelled' : 'complete');
            if (fault !== 'stop') assert.equal(typeof rows[0].first_answer_ms, 'number');
        } finally { api.options = options; api.networkTransport = transport; }
    });
}

test.after(()=>{restore();delete globalThis.__OA_STAGING_TIMING__;});
