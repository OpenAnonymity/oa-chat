// Minimal oa-org stand-in for the fault-injection suite: issues a key for
// every request_key and answers the catalogue calls the chat makes on boot.
import http from 'node:http';

const port = Number(process.env.OA_FAULTS_ORG_PORT || 8005);
const log = [];
const key = () => ({
    key: `sk-or-v1-mock-${Math.random().toString(36).slice(2)}`, key_hash: 'h', station_id: 'st-mock',
    station_url: 'https://station.mock', station_signature: 'sig', org_signature: 'osig',
    expires_at: new Date(Date.now() + 20 * 60e3).toISOString(),
    expires_at_unix: Math.floor(Date.now() / 1000) + 1200, duration_minutes: 20, credit_limit: 1, tickets_consumed: 1
});
const routes = [
    [/^POST \/api\/request_key/, () => key()],
    [/^GET \/chat\/pinned-models/, () => []],
    [/^GET \/chat\/model-tickets/, () => ({ 'google/gemini-3.8-flash': 1, 'openai/gpt-6.1': 1 })],
    [/^POST \/chat\/v1\/analytics/, () => ({})]
];

http.createServer(async (req, res) => {
    let raw = '';
    for await (const piece of req) raw += piece;
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__log') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(log));
    }
    const line = `${req.method} ${url.pathname}`;
    log.push({ at: Date.now(), line });
    const route = routes.find(([pattern]) => pattern.test(line));
    res.writeHead(route ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(route ? route[1]() : { error: 'mock: no route', path: url.pathname }));
}).listen(port, '127.0.0.1', () => console.log(`mock org on ${port}`));
