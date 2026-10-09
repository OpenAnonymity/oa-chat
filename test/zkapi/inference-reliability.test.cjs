const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const url = relative => pathToFileURL(path.join(__dirname, '../../chat', relative)).href;
let API, helpers, limits, proxy, fetchRetry, isAccessCreditExhaustedError;
test.before(async () => {
    globalThis.window = globalThis;
    window.location = {hostname:'localhost',origin:'http://localhost',search:''};
    globalThis.localStorage = globalThis.sessionStorage = {getItem(){return null;},setItem(){},removeItem(){}};
    globalThis.document = {querySelector(){return null;},getElementById(){return null;},addEventListener(){},documentElement:{classList:{contains(){return false;}}}};
    API = (await import(url('api.js'))).OpenRouterAPI;
    helpers = await import(url('services/inference/reliability.js'));
    limits = await import(url('services/inference/inputLimits.js'));
    proxy = (await import(url('services/networkProxy.js'))).default;
    fetchRetry = (await import(url('services/fetchRetry.js'))).fetchRetry;
    ({ isAccessCreditExhaustedError } = await import(url('application/accessController.js')));
});
const encoder = new TextEncoder();
const delta = 'data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n\n';
function response(text, open = false, cancel = () => {}) {
    return new Response(new ReadableStream({start(c){if(text)c.enqueue(encoder.encode(text));if(!open)c.close();},cancel}),{headers:{'Content-Type':'text/event-stream'}});
}
function apiFor(fetchFn, timing = {}) {
    return new API({networkTransport:{fetchWithRetry:fetchFn},inferenceTiming:{warningMs:15,connectionMs:70,idleMs:70,outputMs:200,pollMs:2,...timing}});
}
function stream(api, {controller,health,chunk,opened} = {}) {
    return api.streamCompletion([{role:'user',content:'hi'}],'test/model','synthetic-key',chunk || (()=>{}),null,[],false,controller,opened,null,true,'high',null,health);
}

test('valid DONE without finish_reason succeeds; cancel need not resolve', async () => {
    const api = apiFor(async () => response(delta+'data:[DONE]\n',true,()=>new Promise(()=>{})));
    await stream(api);
});
test('empty, malformed and truncated streams reject rather than succeed', async () => {
    for (const [text,code] of [['','INFERENCE_TRUNCATED'],[delta,'INFERENCE_TRUNCATED'],['data: {bad}\n','INFERENCE_INVALID_STREAM'],['data: [DONE]\n','INFERENCE_EMPTY']]) {
        await assert.rejects(stream(apiFor(async()=>response(text))),{code});
    }
});
test('provider error and explicit incomplete events reject', async () => {
    await assert.rejects(stream(apiFor(async()=>response(delta+'data: {"error":{"message":"provider failed"}}\n'))),/provider failed/);
    await assert.rejects(stream(apiFor(async()=>response(delta+'data: {"type":"response.incomplete"}\n'))),{code:'INFERENCE_INCOMPLETE'});
});
test('nested HTTP and stream errors retain text and metadata without dumping request data', async () => {
    const detail = { message: { detail: [{ msg: 'Model unavailable', input: 'private input' }] }, code: 400 };
    await assert.rejects(stream(apiFor(async () => new Response(JSON.stringify({ error: detail }), { status: 400 }))),
        error => error.message === 'Model unavailable' && error.status === 400);
    await assert.rejects(stream(apiFor(async () => response(delta + `data: ${JSON.stringify({ error: detail })}\n`))),
        error => error.message === 'Model unavailable' && error.isStreamError === true && error.retryable === false);
});
test('richer nested provider credit messages never authorize extra ticket spending', async () => {
    for (const message of ['This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 54775.',
        'Insufficient credits']) {
        const data = { error: { message: { message } } };
        await assert.rejects(stream(apiFor(async () => new Response(JSON.stringify(data), { status: 402 }))), error => {
            assert.equal(error.message, message);
            assert.equal(error.status, 402);
            assert.equal(isAccessCreditExhaustedError(error), false);
            return true;
        });
    }
    const data = { error: { message: { message: 'Key credits exhausted' }, metadata: { limit_source: 'openrouter_key_limit' } } };
    await assert.rejects(stream(apiFor(async () => new Response(JSON.stringify(data), { status: 402 }))), error => {
        assert.equal(isAccessCreditExhaustedError(error), true, 'explicit key-limit policy remains unchanged');
        return true;
    });
});
test('connection timeout bounds fetch that ignores abort', async () => {
    await assert.rejects(stream(apiFor(()=>new Promise(()=>{}))),{code:'INFERENCE_CONNECTION_TIMEOUT',retryable:false});
});
test('late response after connection timeout is canceled', async () => {
    let deliver, canceled = false;
    const pending = stream(apiFor(()=>new Promise(resolve=>{deliver=resolve;})));
    await assert.rejects(pending,{code:'INFERENCE_CONNECTION_TIMEOUT'});
    deliver(response('',true,()=>{canceled=true;}));
    await new Promise(r=>setTimeout(r,0));
    assert.equal(canceled,true);
});
test('stalled HTTP error bodies are canceled and unlocked on timeout', async () => {
    let canceled = false;
    const body = new ReadableStream({start(c){c.enqueue(encoder.encode('{'));},cancel(){canceled=true;}});
    await assert.rejects(stream(apiFor(async()=>new Response(body,{status:503}))),{code:'INFERENCE_IDLE_TIMEOUT'});
    assert.equal(canceled,true);
    assert.equal(body.locked,false);
});
test('stalled stream-open callbacks time out and release the response', async () => {
    let canceled = false;
    const result = response('',true,()=>{canceled=true;});
    await assert.rejects(stream(apiFor(async()=>result),{opened:()=>new Promise(()=>{})}),{code:'INFERENCE_IDLE_TIMEOUT'});
    assert.equal(canceled,true);
    assert.equal(result.body.locked,false);
});
test('explicit completion events and clean EOF after finish_reason succeed', async () => {
    await stream(apiFor(async()=>response(delta+'data: {"type":"response.completed"}\n',true)));
    await stream(apiFor(async()=>response(delta+'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n')));
});
test('silent stream warns and times out, retaining already delivered output', async () => {
    const health = [], chunks = [];
    await assert.rejects(stream(apiFor(async()=>response(delta,true)),{health:h=>health.push(h),chunk:c=>chunks.push(c)}),{code:'INFERENCE_IDLE_TIMEOUT'});
    assert.deepEqual(chunks,['Partial answer']);
    assert.equal(health[0].kind,'silence');
    assert.equal(health.at(-1),null);
});
test('activity clears warning; heartbeats cannot hold open no-output forever', async () => {
    let now=0;
    const changes=[];
    const guard=helpers.createInferenceWatchdog({onHealth:h=>changes.push(h),now:()=>now,timing:{warningMs:10,idleMs:40,outputMs:60,pollMs:1}});
    try {
        guard.opened(); now=12; await new Promise(r=>setTimeout(r,5));
        assert.equal(changes[0].kind,'silence');
        guard.activity(); assert.equal(changes.at(-1),null);
        now=65; guard.activity(); await new Promise(r=>setTimeout(r,5));
        assert.equal(guard.signal.reason.code,'INFERENCE_OUTPUT_TIMEOUT');
    } finally {guard.dispose();}
});
test('Stop rejects promptly as cancellation, not timeout', async () => {
    const controller=new AbortController();
    const pending=stream(apiFor(async()=>response('',true)),{controller});
    setTimeout(()=>controller.abort(),5);
    await assert.rejects(pending,error=>error.name==='AbortError' && error.isCancelled===true);
});
test('retryable responses release tracked bodies before next attempt', async () => {
    proxy.emitChange=()=>{}; proxy.activeRequestCount=0; let attempt=0;
    const result=await fetchRetry('https://example.invalid/test',{}, {maxAttempts:3,baseDelayMs:1,maxDelayMs:1,timeoutMs:0,fetchFn:async()=>{
        attempt++; proxy.activeRequestCount++;
        return proxy.wrapResponseForTracking(new Response('{}',{status:attempt<3?503:200}));
    }});
    await result.text(); assert.equal(proxy.activeRequestCount,0);
});
test('permanent errors and started-stream failures never auto-retry', () => {
    for(const status of [400,401,402,403,404,413,422]) assert.equal(helpers.isRetryableInferenceError({status}),false);
    assert.equal(helpers.isRetryableInferenceError({status:503}),true);
    assert.equal(helpers.isRetryableInferenceError({status:503,isStreamError:true}),false);
});
test('aggregate attachment and model context limits reject locally', async () => {
    assert.throws(()=>limits.validateInferenceInput([],{},[{size:26*1024*1024,type:'image/png'}]),{code:'INFERENCE_INPUT_TOO_LARGE'});
    const files=Array.from({length:33},()=>({type:'image/png',dataUrl:'data:image/png;base64,AA'}));
    assert.throws(()=>limits.validateInferenceInput([{files}]),{code:'INFERENCE_TOO_MANY_IMAGES'});
    assert.throws(()=>limits.validateInferenceInput([{content:'x'.repeat(500)}],{context_length:100}),{code:'INFERENCE_CONTEXT_TOO_LARGE'});
    let acquired=false;
    const api=new API({acquireRequestAccess:()=>{acquired=true;throw new Error('must not acquire');}});
    await assert.rejects(api.streamCompletion([{files}],'test/model','test',()=>{}),{code:'INFERENCE_TOO_MANY_IMAGES'});
    assert.equal(acquired,false);
});

test('a stalled credit-error body is canceled when the shared request times out', async () => {
    let canceled = false;
    const body = new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode('{')); },
        cancel() { canceled = true; }
    });
    const result = new Response(body, { status: 402 });
    let calls = 0;
    await assert.rejects(stream(apiFor(async () => { calls++; return result; })), {
        code: 'INFERENCE_CONNECTION_TIMEOUT'
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1, 'timeout must not retry the request');
    assert.equal(canceled, true, 'both response branches must stop reading after timeout');
    assert.equal(result.body.locked, false);
});

test('64k estimated input boundary includes every message and applies without model metadata', () => {
    const content = 'a'.repeat((64_000 - 8) * 4);
    limits.validateInferenceInput([{ role: 'user', content }], null);
    assert.throws(() => limits.validateInferenceInput([{ role: 'user', content: content + 'a' }], { context_length: 1_000_000 }),
        { code: 'INFERENCE_INPUT_TOKEN_LIMIT', retryable: false });
    assert.throws(() => limits.validateInferenceInput([
        { role: 'user', content: 'a'.repeat(150_000) },
        { role: 'assistant', content: 'b'.repeat(150_000) }
    ]), { code: 'INFERENCE_INPUT_TOKEN_LIMIT' });
    assert.throws(() => limits.validateInferenceInput([{ role: 'user', content: [
        { type: 'text', text: 'a'.repeat(130_000) }, { type: 'text', text: 'b'.repeat(130_000) }
    ] }]), { code: 'INFERENCE_INPUT_TOKEN_LIMIT' });
});

test('oversized streaming and strict requests cannot acquire access or send, including system instructions', async () => {
    let acquired = 0, sent = 0;
    const api = new API({ acquireRequestAccess: () => { acquired++; throw new Error('must not acquire'); },
        networkTransport: { fetchWithRetry: () => { sent++; }, fetchWithRetryJson: () => { sent++; } } });
    // This text fits alone; OA's system instructions push the final request over.
    const messages = [{ role: 'user', content: 'a'.repeat((64_000 - 8) * 4) }];
    for (const invoke of [() => api.streamCompletion(messages, 'test/model', 'synthetic', () => {}),
        () => api.sendCompletionStrict(messages, 'test/model', 'synthetic')]) {
        await assert.rejects(invoke(), error => error.code === 'INFERENCE_INPUT_TOKEN_LIMIT'
            && !isAccessCreditExhaustedError(error) && !helpers.isRetryableInferenceError(error));
    }
    assert.equal(acquired, 0); assert.equal(sent, 0);
});

test('final prepared requests reject added text and converted document text before transport', () => {
    const oversized = [{ role: 'user', content: [{ type: 'text', text: 'document '.repeat(40_000) }] }];
    const api = new API({ prepareRequestBody: body => ({ ...body, messages: oversized }) });
    assert.throws(() => api.prepareFetchOptions({ headers: {} }, { body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }) }),
        { code: 'INFERENCE_INPUT_TOKEN_LIMIT' });
    const ordinary = new API();
    assert.throws(() => ordinary.prepareRequestBody({ model: 'test/model', messages: oversized }, {}),
        { code: 'INFERENCE_INPUT_TOKEN_LIMIT' });
    assert.equal(ordinary.prepareRequestBody({ model: 'test/model', messages: [{ role: 'user', content: 'Short request' }] }, {}).messages[0].content, 'Short request');
});
