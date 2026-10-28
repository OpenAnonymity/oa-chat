import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';

function request(url, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); req.end();
    });
}

// Exercise the real HTTP server, not a source-pattern proxy for browser imports.
test('local server delivers browser-loadable QR modules and supports HEAD', async () => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, ['scripts/dev-server.mjs'], {
        cwd: process.cwd(),
        env: { ...process.env, OA_CHAT_DEV_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    const exited = once(child, 'exit');
    let startupTimer;
    try {
        await Promise.race([
            once(child.stdout, 'data'),
            exited.then(() => { throw new Error('local server exited during startup'); }),
            new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('local server startup timed out')), 10000); })
        ]);
        clearTimeout(startupTimer);
        const base = `http://localhost:${port}`;
        for (const path of ['/services/phonePairingQr.js', '/zkapi/components/FundingPaymentQr.js']) {
            const response = await request(base + path);
            assert.equal(response.status, 200);
            assert.match(response.headers['content-type'], /javascript/);
            const body = response.body;
            const module = await import('data:text/javascript;base64,' + Buffer.from(body).toString('base64'));
            if (module.pairingQrSvg) assert.match(module.pairingQrSvg('test-pairing-payload'), /^<svg/);
            else assert.equal(typeof module.renderFundingPaymentQr, 'function');
            const head = await request(base + path, 'HEAD');
            assert.equal(head.body, '');
            assert.equal(Number(head.headers['content-length']), Buffer.byteLength(body));
        }
        assert.match((await request(base + '/')).body, /__OA_LOCAL_ORG_PROXY__/);
    } finally {
        clearTimeout(startupTimer);
        child.kill(); await exited;
    }
});
