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

test('real SSE decoder passes provider code to sanitized timeline without changing HTTP or replay policy', async t => {
    const logger = (await import(url('services/networkLogger.js'))).default;
    const previous = window.networkLogger;
    window.networkLogger = logger;
    t.after(() => { window.networkLogger = previous; });
    let calls = 0;
    const api = apiFor(async () => {
        calls++;
        return response('data: {"error":{"code":429,"message":"PRIVATE_PROVIDER_BODY"}}\n\n');
    });
    await assert.rejects(stream(api), error => {
        assert.equal(error.providerReported, true);
        assert.equal(error.code, 429);
        assert.equal(error.status, undefined);
        assert.equal(error.retryable, false);
        assert.equal(error.isCancelled, undefined);
        return true;
    });
    assert.equal(calls, 1);
    assert.equal(logger.getRecentLogs(1)[0].error, 'Request failed (PROVIDER_CODE_429)');
    assert.doesNotMatch(JSON.stringify(logger.getRecentLogs(1)), /PRIVATE_PROVIDER_BODY/);
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
test('a 403 "Key limit exceeded" pre-stream rejection is a spent key; other 403s are not', async () => {
    const spent = 'Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys';
    await assert.rejects(stream(apiFor(async () => new Response(JSON.stringify({ error: { message: spent, code: 403 } }), { status: 403 }))), error => {
        assert.equal(error.status, 403);
        assert.equal(error.code, 'INFERENCE_KEY_CREDITS');
        assert.equal(isAccessCreditExhaustedError(error), true, 'the 403 shape OpenRouter sends since 2026-10 requests a new key');
        return true;
    });
    await assert.rejects(stream(apiFor(async () => new Response(JSON.stringify({ error: { message: 'Input flagged by moderation', code: 403 } }), { status: 403 }))), error => {
        assert.equal(error.status, 403);
        assert.notEqual(error.code, 'INFERENCE_KEY_CREDITS');
        assert.equal(isAccessCreditExhaustedError(error), false, 'a moderation 403 keeps the key');
        return true;
    });
});
test('reasoning carried only in reasoning_details reaches the trace; a chunk with both is not doubled; withheld reasoning is reported', async () => {
    const done = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n';
    const reasoningOf = async text => {
        const api = apiFor(async () => response(text));
        let reasoning = '';
        const withheldSignals = [];
        const result = await api.streamCompletion([{role:'user',content:'hi'}],'x-ai/grok-4.7','synthetic-key',()=>{},null,[],false,null,null,(chunk, meta) => { reasoning += chunk; if (meta?.withheld) withheldSignals.push(chunk); },true,'medium');
        return { reasoning, result, withheldSignals };
    };
    // Structured details only (no `reasoning` string on the delta).
    const detailsOnly = 'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"Looking at the post. ","format":"xai-responses-v1","index":0}]}}]}\n\n'
        + 'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","summary":"Two clips."}]}}]}\n\n' + delta + done;
    let { reasoning, result, withheldSignals } = await reasoningOf(detailsOnly);
    assert.equal(reasoning, 'Looking at the post. Two clips.');
    assert.equal(result.reasoning, 'Looking at the post. Two clips.');
    assert.equal(result.reasoningWithheld, false);
    assert.deepEqual(withheldSignals, [], 'words shown: the UI is not told the reasoning was withheld');
    // Both shapes in one chunk: the string wins, the details are not appended again.
    const both = 'data: {"choices":[{"delta":{"reasoning":"Once. ","reasoning_details":[{"type":"reasoning.text","text":"Once. "}]}}]}\n\n' + delta + done;
    ({ reasoning, result } = await reasoningOf(both));
    assert.equal(reasoning, 'Once. ');
    // Encrypted only: nothing to show, and the result says the words were withheld.
    const withheld = 'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"opaque-blob"}]}}]}\n\n' + delta + done;
    ({ reasoning, result, withheldSignals } = await reasoningOf(withheld));
    assert.equal(reasoning, '');
    assert.equal(result.reasoning, null);
    assert.equal(result.reasoningWithheld, true);
    assert.deepEqual(withheldSignals, [''], 'the UI is told once, with no words, so it can say Thinking... and time the trace');
    // A plain answer reports neither.
    ({ result } = await reasoningOf(delta + done));
    assert.equal(result.reasoningWithheld, false);
});
test('wordless thinking after part of the answer is reported as resumed and the answer continues on a new paragraph', async () => {
    const done = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n';
    const encrypted = 'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"opaque"}]}}]}\n\n';
    const say = text => `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`;
    const run = async text => {
        let content = '';
        const signals = [];
        const result = await apiFor(async () => response(text)).streamCompletion([{role:'user',content:'hi'}],'x-ai/grok-4.7','synthetic-key',chunk => { content += chunk; },null,[],false,null,null,(chunk, meta) => { if (meta?.withheld) signals.push({ ...meta }); },true,'medium');
        return { content, signals, result };
    };
    // Think, answer a line, search (thinking again, words withheld), answer on.
    let { content, signals } = await run(encrypted + say('I will look it up.') + encrypted + encrypted + say('A few repos match.') + done);
    assert.equal(content, 'I will look it up.\n\nA few repos match.');
    assert.deepEqual(signals, [{ withheld: true }, { withheld: true, resumed: true }], 'one resume per thinking segment, not per detail');
    // An answer that came first, then wordless thinking, then more answer.
    ({ content, signals } = await run(say('First.') + encrypted + say('Second.') + done));
    assert.equal(content, 'First.\n\nSecond.');
    assert.deepEqual(signals, [{ withheld: true, resumed: true }]);
    // Details riding on an answer delta are not a new thinking segment.
    const both = 'data: {"choices":[{"delta":{"content":" more","reasoning_details":[{"type":"reasoning.encrypted","data":"x"}]}}]}\n\n';
    ({ content, signals } = await run(encrypted + say('One') + both + say(' line.') + done));
    assert.equal(content, 'One more line.');
    assert.deepEqual(signals, [{ withheld: true }]);
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
function openStream(timing = {}) {
    // A provider that keeps the HTTP response open: lines are pushed by the test.
    let controller, canceled = false;
    const body = new ReadableStream({ start(c) { controller = c; }, cancel() { canceled = true; } });
    const push = text => { if (!canceled) controller.enqueue(encoder.encode(text)); };
    const api = apiFor(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), timing);
    return { api, push, get canceled() { return canceled; }, close() { try { controller.close(); } catch { /* already canceled */ } } };
}
test('a confirmed finish followed only by heartbeats completes within the tail and keeps the usage that arrives in it', async () => {
    const feed = openStream({ tailMs: 40, outputMs: 400 });
    const health = [], chunks = [];
    const started = Date.now();
    const pending = stream(feed.api, { health: h => health.push(h), chunk: c => chunks.push(c) });
    feed.push(delta + 'data: {"choices":[{"delta":{"content":" done"},"finish_reason":"stop"}]}\n\n');
    await new Promise(r => setTimeout(r, 5));
    feed.push('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n');
    const heartbeat = setInterval(() => feed.push(': OPENROUTER PROCESSING\n\n'), 3);
    try {
        const result = await pending;
        assert.ok(Date.now() - started < 300, 'settles after the tail, not after the output deadline');
        assert.equal(result.finishReason, 'stop');
        assert.equal(result.totalTokens, 5, 'usage sent after the finish reason is kept');
        assert.deepEqual(chunks, ['Partial answer', ' done']);
        assert.equal(feed.canceled, true, 'the open connection is released');
        assert.ok(!health.some(h => h?.kind === 'silence'));
    } finally { clearInterval(heartbeat); feed.close(); }
});
test('output after a finish reason disarms the tail until completion is confirmed again', async () => {
    // Leave scheduling headroom for loaded release runners. The pause below
    // still exceeds the original tail, proving that output really disarmed it.
    const feed = openStream({ tailMs: 100, idleMs: 1000, outputMs: 3000 });
    const chunks = [];
    const pending = stream(feed.api, { chunk: c => chunks.push(c) });
    feed.push(delta + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    await new Promise(r => setTimeout(r, 10));
    feed.push('data: {"choices":[{"delta":{"content":" more"}}]}\n\n');
    await new Promise(r => setTimeout(r, 150));
    assert.equal(feed.canceled, false, 'late output reopens the stream: no cut at the first finish');
    feed.push('data: {"choices":[{"delta":{"content":" end"},"finish_reason":"stop"}]}\n\n');
    const result = await pending;
    assert.deepEqual(chunks, ['Partial answer', ' more', ' end']);
    assert.equal(result.finishReason, 'stop');
    feed.close();
});
test('an error event in the tail still fails the stream; DONE still completes at once', async () => {
    const feed = openStream({ tailMs: 60, outputMs: 400 });
    const pending = stream(feed.api);
    feed.push(delta + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    await new Promise(r => setTimeout(r, 5));
    feed.push('data: {"error":{"message":"provider failed late"}}\n\n');
    await assert.rejects(pending, /provider failed late/);
    feed.close();
    const quick = openStream({ tailMs: 200 });
    const started = Date.now();
    const done = stream(quick.api);
    quick.push(delta + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    await done;
    assert.ok(Date.now() - started < 100, 'DONE does not wait for the tail');
    assert.equal(quick.canceled, true);
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
test('reasoning queued behind a delivery still running at Stop is dropped, not delivered after the cancellation', async () => {
    const feed = openStream();
    const controller = new AbortController();
    const calls = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => {
        feed.api.streamCompletion([{role:'user',content:'hi'}],'test/model','synthetic-key',()=>{},null,[],false,controller,null,
            async text => { calls.push({ text, afterStop: controller.signal.aborted }); if (calls.length === 1) { resolve(); await gate; } },
            true,'high').then(() => assert.fail('a stopped request must not complete'), error => { calls.rejected = error; });
    });
    feed.push('data: {"choices":[{"delta":{"reasoning":"first"}}]}\n\n');
    await entered;
    // Long enough to flush at once: it queues behind the delivery still running.
    feed.push('data: {"choices":[{"delta":{"reasoning":"second reasoning chunk exceeds buffer threshold"}}]}\n\n');
    await new Promise(r => setTimeout(r, 20));
    controller.abort();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(calls.rejected?.isCancelled, true);
    release();
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(calls.map(c => c.text), ['first'], 'the queued chunk never reaches the chat after Stop');
    feed.close();
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

test('model context replaces the fixed 64k cap, including when metadata is absent', () => {
    const messages = [{ role: 'user', content: 'a'.repeat(300_000) }];
    for (const model of [null, {}, { context_length: 128_000 }, { context_length: 1_000_000 }]) {
        assert.doesNotThrow(() => limits.validateInferenceInput(messages, model));
    }
    assert.throws(() => limits.validateInferenceInput(messages, { context_length: 64_000 }),
        { code: 'INFERENCE_CONTEXT_TOO_LARGE', retryable: false });
    const content = 'a'.repeat((128_000 - 8) * 4);
    limits.validateInferenceInput([{ role: 'user', content }], { context_length: 128_000 });
    assert.throws(() => limits.validateInferenceInput([{ role: 'user', content: content + 'a' }], { context_length: 128_000 }),
        { code: 'INFERENCE_CONTEXT_TOO_LARGE' });
    assert.doesNotThrow(() => limits.validateInferenceInput([
        { role: 'user', content: 'a'.repeat(150_000) },
        { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(150_000) }] }
    ], { context_length: 128_000 }));
});

test('streaming and strict requests above 64k reach access acquisition once', async () => {
    let acquired = 0;
    const sentinel = new Error('synthetic acquisition boundary');
    const api = new API({ acquireRequestAccess: () => { acquired++; throw sentinel; } });
    api.getModelBudgetMetadata = () => ({ context_length: 128_000 });
    const messages = [{ role: 'user', content: 'a'.repeat(300_000) }];
    for (const invoke of [() => api.streamCompletion(messages, 'test/model', null, () => {}),
        () => api.sendCompletionStrict(messages, 'test/model', null)]) {
        await assert.rejects(invoke(), error => error === sentinel);
    }
    assert.equal(acquired, 2);
});

test('oversized streaming and strict requests cannot acquire access or send, including system instructions', async () => {
    let acquired = 0, sent = 0;
    const api = new API({ acquireRequestAccess: () => { acquired++; throw new Error('must not acquire'); },
        networkTransport: { fetchWithRetry: () => { sent++; }, fetchWithRetryJson: () => { sent++; } } });
    api.getModelBudgetMetadata = () => ({ context_length: 64_000 });
    // This text fits alone; OA's system instructions push the final request over.
    const messages = [{ role: 'user', content: 'a'.repeat((64_000 - 8) * 4) }];
    for (const invoke of [() => api.streamCompletion(messages, 'test/model', 'synthetic', () => {}),
        () => api.sendCompletionStrict(messages, 'test/model', 'synthetic')]) {
        await assert.rejects(invoke(), error => error.code === 'INFERENCE_CONTEXT_TOO_LARGE'
            && !isAccessCreditExhaustedError(error) && !helpers.isRetryableInferenceError(error));
    }
    assert.equal(acquired, 0); assert.equal(sent, 0);
});

test('final prepared requests reject added text and converted document text before transport', () => {
    const oversized = [{ role: 'user', content: [{ type: 'text', text: 'document '.repeat(40_000) }] }];
    const api = new API({ prepareRequestBody: body => ({ ...body, messages: oversized }) });
    api.getModelBudgetMetadata = () => ({ context_length: 64_000 });
    assert.throws(() => api.prepareFetchOptions({ headers: {} }, { body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }) }),
        { code: 'INFERENCE_CONTEXT_TOO_LARGE' });
    const ordinary = new API();
    ordinary.getModelBudgetMetadata = () => ({ context_length: 64_000 });
    assert.throws(() => ordinary.prepareRequestBody({ model: 'test/model', messages: oversized }, {}),
        { code: 'INFERENCE_CONTEXT_TOO_LARGE' });
    assert.equal(ordinary.prepareRequestBody({ model: 'test/model', messages: [{ role: 'user', content: 'Short request' }] }, {}).messages[0].content, 'Short request');
});

test('large final adapter bodies remain allowed within the selected model context', () => {
    const messages = [{ role: 'user', content: 'a'.repeat(300_000) }];
    const api = new API({ prepareRequestBody: body => ({ ...body, messages }) });
    api.getModelBudgetMetadata = () => ({ context_length: 128_000 });
    assert.doesNotThrow(() => api.prepareFetchOptions({ headers: {} }, {
        body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] })
    }));
});
