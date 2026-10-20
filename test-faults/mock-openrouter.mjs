// Scriptable stand-in for openrouter.ai, for the fault-injection suite.
// Chromium reaches it through --host-resolver-rules (openrouter.ai → here).
//
// POST /__script {reset?, script: [step, …], byModel?: {model: [step, …]}}
// queues one step per chat/completions request (the last step repeats); a
// model listed in byModel follows its own queue (Parallel lanes). GET /__script returns
// the request log with arrival times. Steps:
//   {kind:'ok', text?}                         normal stream ending in [DONE]
//   {kind:'http', status, headers?, body?}     an HTTP error before any stream
//   {kind:'stream-error', code, afterWords?}   200, then OpenRouter's error event
//   {kind:'cut', afterWords}                   200, words, then the socket closes
//   {kind:'stall', afterWords}                 200, words, then silence
//   {kind:'withheld-then-error', code}         hidden thinking, then an error event
import https from 'node:https';
import fs from 'node:fs';

const certDir = process.env.OA_FAULTS_CERTS;
const port = Number(process.env.OA_FAULTS_OPENROUTER_PORT || 8443);
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': '*' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODELS = ['google/gemini-3.8-flash', 'openai/gpt-6.1'];

let script = [{ kind: 'ok' }];
let byModel = {};
let cursor = 0;
const cursors = new Map();
const log = [];
const openStreams = new Set();

const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...cors, ...headers });
    res.end(JSON.stringify(body));
};
const chunk = (data) => `data: ${JSON.stringify(data)}\n\n`;
const word = (text, model) => chunk({ id: 'gen-mock', object: 'chat.completion.chunk', model: model || 'google/gemini-3.8-flash',
    choices: [{ index: 0, delta: { content: text } }] });

async function stream(res, step, model) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...cors });
    openStreams.add(res);
    res.on('close', () => openStreams.delete(res));
    const words = String(step.text || 'Here is the answer from the mock provider.').split(' ');
    const stopAt = step.kind === 'ok' ? words.length : Math.min(step.afterWords ?? 0, words.length);
    // OpenRouter sends a keep-alive comment while the provider works.
    res.write(': OPENROUTER PROCESSING\n\n');
    if (step.kind === 'withheld-then-error') {
        res.write(chunk({ id: 'gen-mock', choices: [{ index: 0, delta: { content: '', reasoning: null,
            reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }] } }] }));
        await sleep(300);
        res.write(chunk({ error: { code: step.code || 504, message: 'Provider returned error' } }));
        return res.end();
    }
    for (let i = 0; i < stopAt; i += 1) {
        res.write(word(`${words[i]}${i < words.length - 1 ? ' ' : ''}`, model));
        await sleep(30);
    }
    if (step.kind === 'ok') {
        res.write(chunk({ id: 'gen-mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: words.length } }));
        res.write('data: [DONE]\n\n');
        return res.end();
    }
    if (step.kind === 'stream-error') {
        res.write(chunk({ error: { code: step.code, message: 'Provider returned error',
            metadata: { provider_name: 'Google AI Studio', raw: 'mock upstream failure' } } }));
        return res.end();
    }
    if (step.kind === 'cut') return res.socket.destroy();
    if (step.kind === 'stall') return; // never another byte
}

const server = https.createServer({
    key: fs.readFileSync(`${certDir}/key.pem`), cert: fs.readFileSync(`${certDir}/cert.pem`)
}, async (req, res) => {
    const url = new URL(req.url, 'https://openrouter.ai');
    let raw = '';
    for await (const piece of req) raw += piece;
    if (url.pathname === '/__script') {
        if (req.method === 'POST') {
            const body = JSON.parse(raw || '{}');
            if (body.reset) {
                log.length = 0;
                cursor = 0;
                for (const open of openStreams) open.socket?.destroy();
            }
            if (body.script) { script = body.script; cursor = 0; }
            if (body.script || body.reset) { byModel = body.byModel || {}; cursors.clear(); }
        }
        return json(res, 200, { log, script, cursor });
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (url.pathname.endsWith('/models')) {
        return json(res, 200, { data: MODELS.map(id => ({ id, name: id, context_length: 128000,
            pricing: { prompt: '0.000001', completion: '0.000002' },
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            supported_parameters: ['reasoning'] })) });
    }
    if (url.pathname.endsWith('/chat/completions')) {
        let model = '';
        try { model = JSON.parse(raw).model || ''; } catch { /* not JSON */ }
        let step;
        // Web search adds ":online"; title generation and other helpers use
        // other models and fall through to the default script.
        const base = model.replace(/:online$/, '');
        if (Array.isArray(byModel[base])) {
            const at = cursors.get(base) || 0;
            step = byModel[base][Math.min(at, byModel[base].length - 1)];
            cursors.set(base, at + 1);
        } else {
            step = script[Math.min(cursor, script.length - 1)];
            cursor += 1;
        }
        log.push({ at: Date.now(), model: base, kind: step.kind, status: step.status || step.code || 200 });
        if (step.kind === 'http') {
            return json(res, step.status, step.body || { error: { code: step.status, message: 'Provider returned error',
                metadata: { provider_name: 'Google AI Studio', raw: 'mock upstream failure' } } }, step.headers || {});
        }
        return stream(res, step, base);
    }
    return json(res, 404, { error: { message: 'mock: no route' } });
});
server.listen(port, '127.0.0.1', () => console.log(`mock openrouter on ${port}`));
