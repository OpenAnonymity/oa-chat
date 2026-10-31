// oa-clientd authorization in real Chromium: the unbundled client (scripts/dev-server.mjs)
// and the composed staging artifact, against a stand-in org with a virtual PRF passkey.
// Every other host fails to resolve, so no real account, Google, payment, ticket or
// inference traffic is possible. Real local servers, not page.route: Playwright does not
// intercept the request a redirect leads to, and that request would leave this machine.
//
//   npm --prefix test-faults ci
//   OA_DIST=<composed staging dist> node test-faults/daemon-authorization.mjs [scenario words]
//
// The sign-in itself is simulated by setting accountService's state; everything after it
// (dialog, code, passkey, unwrap, seal, approve) is the real client code.
// Exit code is non-zero when any assertion fails. Screenshots: OA_DAEMON_SHOTS or a temp folder.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CHAT_PORT = Number(process.env.OA_DAEMON_CHAT_PORT || 18080);
const ORG_PORT = CHAT_PORT + 1;
const DIST_PORT = CHAT_PORT + 2;
const BASE = `http://localhost:${CHAT_PORT}`;
const DIST_BASE = `http://localhost:${DIST_PORT}`;
const ACCOUNT = '1234567890123456';
const OTHER_ACCOUNT = '9999999999999999';
const CODE = 'ABCD-EFGH';
const DIST = process.env.OA_DIST ? path.resolve(process.env.OA_DIST) : null;
const SHOTS = process.env.OA_DAEMON_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-daemon-browser-'));
const ORG_PREFIXES = ['/auth/', '/api/', '/chat/v1/', '/chat/share/', '/chat/model-tier/', '/chat/free_access/'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };

fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}

const b64u = value => Buffer.from(value).toString('base64url');

function makeRequest() {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const publicKey = b64u(ecdh.getPublicKey());
    const transaction = b64u(crypto.randomBytes(32));
    return {
        ecdh, publicKey, transaction,
        hash: crypto.createHash('sha256').update(publicKey).digest('hex'),
        fragment: `#oa-daemon=${b64u(JSON.stringify({ v: 1, t: transaction, k: publicKey }))}`
    };
}

function openEnvelope(request, sealed) {
    const ephemeral = Buffer.from(sealed.ephemeralPublicKey, 'base64url');
    const shared = request.ecdh.computeSecret(ephemeral);
    const salt = crypto.createHash('sha256').update(request.transaction).digest();
    const info = `oa-daemon-auth/v1/browser->daemon|${request.ecdh.getPublicKey('hex')}|${ephemeral.toString('hex')}`;
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, 32));
    const ciphertext = Buffer.from(sealed.ciphertext, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64url'));
    decipher.setAAD(Buffer.from(`oa-daemon-auth/v1/envelope|${request.transaction}`));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]).toString());
}

// --- The org stand-in. Route rules mirror oa-org auth/daemon/router.py. ---------
const org = {};
function resetOrg() {
    Object.assign(org, {
        calls: [], requests: new Map(), approved: new Map(), denied: [], gates: new Map(),
        devices: [{ id: 'dev_1', clientVersion: '0.1.0', platform: 'darwin/arm64', authorizedAt: 1793000000 }],
        wrapped: null, credentialId: null, signedInAccount: ACCOUNT
    });
}
resetOrg();

function register(request) {
    org.requests.set(request.transaction, request);
    return request;
}

function holdRoute(route) {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    org.gates.set(route, { promise, release, reached: false });
    return () => { org.gates.delete(route); release(); };
}

async function orgRoutes(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    const pathname = new URL(request.url, 'http://x').pathname;
    org.calls.push({ method: request.method, path: pathname, origin: request.headers.origin || null, transaction: body.transaction || null });
    const reply = (status, data) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(data));
    };
    const refuse = (status, code) => reply(status, { detail: { error: code, code } });
    const gate = org.gates.get(pathname);
    if (gate) {
        gate.reached = true;
        await gate.promise;
    }
    if (pathname.startsWith('/auth/daemon/')) {
        if (!request.headers.origin) return refuse(403, 'DAEMON_AUTH_ORIGIN');
        const known = org.requests.get(body.transaction);
        switch (pathname) {
        case '/auth/daemon/lookup':
            if (!known || org.denied.includes(body.transaction) || org.approved.has(body.transaction)) return refuse(410, 'DAEMON_AUTH_EXPIRED');
            return reply(200, { clientName: 'oa-clientd', clientVersion: '0.1.0', platform: 'darwin/arm64', expiresIn: 600, sameNetwork: true, accountKind: 'username', daemonPublicKeyHash: known.hash });
        case '/auth/daemon/check-code':
            return body.userCode === CODE ? reply(200, { success: true }) : refuse(400, 'DAEMON_AUTH_BAD_CODE');
        case '/auth/daemon/reveal/challenge':
            return reply(200, { challenge: b64u(crypto.randomBytes(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: org.credentialId }], timeout: 60000, userVerification: 'required' });
        case '/auth/daemon/reveal':
            return reply(200, { wrappedKeyPasskey: org.wrapped });
        case '/auth/daemon/approve':
            if (!/^\d{16}$/.test(body.expectedAccountId || '')) return reply(422, { detail: 'expectedAccountId required' });
            if (body.expectedAccountId !== org.signedInAccount) return refuse(409, 'DAEMON_AUTH_ACCOUNT_MISMATCH');
            org.approved.set(body.transaction, body);
            return reply(200, { success: true });
        case '/auth/daemon/deny':
            org.denied.push(body.transaction);
            return reply(200, { success: true });
        case '/auth/daemon/devices/list':
            return reply(200, { devices: org.devices });
        default:
            if (request.method === 'DELETE' && pathname.startsWith('/auth/daemon/devices/')) {
                org.devices = org.devices.filter(device => !pathname.endsWith(`/${device.id}`));
                return reply(200, { success: true });
            }
            return refuse(404, 'NOT_FOUND');
        }
    }
    if (pathname === '/auth/sync/status') return reply(200, { last_sync: null });
    if (pathname === '/auth/sync') return reply(200, request.method === 'GET' ? { blobs: [], last_sync: null } : { accepted: (body.blobs || []).map(blob => blob.id) });
    if (pathname.startsWith('/auth/')) return reply(401, { message: 'unauthorised' });
    return reply(200, {});
}

const isOrgPath = pathname => ORG_PREFIXES.some(prefix => pathname.startsWith(prefix));

// The composed artifact with the shape of staging's routing: a first visit to `/` is a
// real 307 to /login, which keeps the fragment in a real browser.
const distLog = [];
function distServer() {
    return http.createServer(async (request, response) => {
        const url = new URL(request.url, DIST_BASE);
        distLog.push({ method: request.method, url: url.pathname + url.search });
        if (isOrgPath(url.pathname)) return orgRoutes(request, response);
        const passthrough = ['auth', 'tickets', 'billing', 'c', 's'].some(key => url.searchParams.has(key));
        if (url.pathname === '/' && !passthrough && !/(^|;\s*)oa_returning=/.test(request.headers.cookie || '')) {
            response.writeHead(307, { location: `/login${url.search}`, 'cache-control': 'no-store' });
            return response.end();
        }
        let file = url.pathname === '/' ? '/index.html' : url.pathname === '/login' ? '/landing/index.html' : url.pathname;
        file = path.resolve(DIST, `.${decodeURIComponent(file)}`);
        if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            response.writeHead(404);
            return response.end('not found');
        }
        response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        fs.createReadStream(file).pipe(response);
    });
}

// --- Browser helpers ------------------------------------------------------------
async function newPage(browser, { theme = 'light', viewport = { width: 1280, height: 800 } } = {}) {
    const context = await browser.newContext({ viewport, colorScheme: theme });
    await context.addInitScript(value => {
        try { localStorage.setItem('oa-theme-preference', value); } catch { /* a blank page */ }
    }, theme);
    const log = { errors: [], external: [], failed: [] };
    await context.route(url => new URL(url).hostname !== 'localhost', route => {
        log.external.push(route.request().url());
        return route.abort('connectionrefused');
    });
    const page = await context.newPage();
    page.on('pageerror', error => log.errors.push(String(error).slice(0, 300)));
    page.on('requestfailed', request => {
        if (new URL(request.url()).hostname === 'localhost') log.failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true
    } });
    const wait = async (fn, arg, label, timeout = 20000) => {
        try {
            await page.waitForFunction(fn, arg, { timeout });
            return true;
        } catch {
            console.log(`  waited for: ${label}\n  url: ${page.url()}\n  page errors: ${JSON.stringify(log.errors.slice(0, 5))}\n  failed: ${JSON.stringify(log.failed.slice(0, 5))}`);
            return false;
        }
    };
    return { context, page, log, wait };
}

const booted = s => s.wait(() => window.app && window.chatDB?.db, null, 'the app to boot', 45000);
const hasDialog = page => page.locator('.daemon-authorize-modal:not(.hidden)').count().then(count => count > 0);
const dialogText = page => page.locator('.daemon-authorize-modal:not(.hidden)').last().innerText().catch(() => '');
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const dialogShows = (s, pattern, label) => s.wait(source => new RegExp(source).test([...document.querySelectorAll('.daemon-authorize-modal:not(.hidden)')].map(el => el.textContent).join(' ')), pattern.source, label);

/** Stands in for the sign-in: real state the dialog reads, stable keys for `unlocked`. */
function signIn(page, accountId = ACCOUNT, { encryptionMode = 'LEGACY_PASSKEY', bump = false } = {}) {
    org.signedInAccount = accountId;
    return page.evaluate(async ({ accountId, encryptionMode, bump }) => {
        const { default: service } = await import('/services/accountService.js');
        window.__service = service;
        if (bump) service.loginGeneration = (service.loginGeneration || 0) + 1;
        service.cryptoKey ||= await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        service.syncDerivationKey ||= await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'HKDF', false, ['deriveKey', 'deriveBits']);
        service.syncIdKey ||= await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        service.setState({ accountId, encryptionMode, username: 'harness', sessionVerified: true, accountScopeReady: true, busy: false, accountHandoffPending: false, oauthSetupRequired: false });
    }, { accountId, encryptionMode, bump });
}

/** A passkey on the virtual authenticator, and its PRF output for this account. */
async function setUpPasskey(page, accountId = ACCOUNT) {
    const { credentialId, prf } = await page.evaluate(async accountId => {
        const created = await navigator.credentials.create({ publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { id: location.hostname, name: 'harness' },
            user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'harness', displayName: 'harness' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            extensions: { prf: {} }
        } });
        // accountService.digestAccountId: the PRF input every account unlock uses.
        const input = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accountId)));
        const got = await navigator.credentials.get({ publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
            allowCredentials: [{ type: 'public-key', id: created.rawId }], userVerification: 'required',
            extensions: { prf: { eval: { first: input } } }
        } });
        return { credentialId: created.id, prf: Array.from(new Uint8Array(got.getClientExtensionResults().prf.results.first)) };
    }, accountId);
    org.credentialId = credentialId;
    const masterKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(prf), iv);
    const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final(), cipher.getAuthTag()]);
    org.wrapped = Buffer.from(JSON.stringify({ iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') })).toString('base64');
    return masterKey;
}

async function typeCodeAndApprove(page, code = CODE) {
    await page.locator('#daemon-authorize-code').fill(code);
    await page.locator('.daemon-authorize-approve').click();
}

/** Pauses the seal's AES encryption (the only one with this additional data) until released. */
const holdSealing = page => page.evaluate(() => {
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    window.__sealReached = false;
    window.__sealGate = new Promise(resolve => { window.__releaseSeal = resolve; });
    crypto.subtle.encrypt = async (algorithm, key, data) => {
        if (algorithm.additionalData) {
            window.__sealReached = true;
            await window.__sealGate;
        }
        return original(algorithm, key, data);
    };
});

const approvals = () => org.calls.filter(call => call.path === '/auth/daemon/approve').length;
const lookupsOf = request => org.calls.filter(call => call.path === '/auth/daemon/lookup' && call.transaction === request.transaction).length;
// The live dialog's own session. The heading cannot tell: an approving dialog keeps "Authorize this computer".
const active = page => page.evaluate(() => {
    const modal = window.app?.ui?.daemonAuthorizeModal;
    return { transaction: modal?.transaction ?? null, status: modal?.session?.getState().status ?? null };
});
const setHash = (page, hash) => page.evaluate(value => { location.hash = value; }, hash);

// --- Scenarios ------------------------------------------------------------------
const scenarios = {
    async 'first visit to the composed artifact'(browser) {
        if (!DIST || !fs.existsSync(path.join(DIST, 'landing/index.html'))) {
            check('A OA_DIST points at a composed staging build', false, String(DIST));
            return;
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'build-manifest.json'), 'utf8'));
        const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        check('A the artifact is built from this checkout', manifest.oaChat?.gitSha === head, `artifact ${manifest.oaChat?.gitSha}, checkout ${head}`);
        distLog.length = 0;
        const s = await newPage(browser);
        const request = register(makeRequest());
        const navigations = [];
        s.page.on('framenavigated', frame => {
            if (frame === s.page.mainFrame()) navigations.push(frame.url());
        });
        const statuses = [];
        s.page.on('response', response => {
            if (response.request().isNavigationRequest()) statuses.push(`${response.status()} ${new URL(response.url()).pathname}${new URL(response.url()).search}`);
        });
        await s.page.goto(`${DIST_BASE}/${request.fragment}`, { waitUntil: 'commit' });
        await s.wait(() => location.pathname === '/' && !location.hash && !location.search && sessionStorage.getItem('oa-daemon-authorization'), null, 'the fragment to be captured', 45000);
        const seen = distLog.filter(entry => entry.method === 'GET').map(entry => entry.url);
        check('A the server redirected the first visit with a real 307', statuses.includes('307 /'), statuses.join(', '));
        check('A the landing page was served and fetched its script', seen.includes('/login') && seen.some(url => url.startsWith('/landing/landing.js')), seen.slice(0, 6).join(', '));
        check('A the landing page handed off to the chat', seen.includes('/?auth=daemon'), navigations.join(', '));
        const state = await s.page.evaluate(() => ({ href: location.href, saved: JSON.parse(sessionStorage.getItem('oa-daemon-authorization') || 'null') }));
        check('A the address is clean', state.href === `${DIST_BASE}/`, state.href);
        check('A the request is saved with no secret', state.saved?.transaction === request.transaction && Object.keys(state.saved).sort().join() === 'daemonPublicKey,savedAt,transaction', JSON.stringify(Object.keys(state.saved || {})));
        const offered = await s.wait(() => { const modal = document.getElementById('account-modal'); return modal && !modal.classList.contains('hidden'); }, null, 'sign-in to be offered', 30000);
        check('A a signed-out person is offered sign-in', offered);
        await shot(s.page, 'A-first-visit-signed-out');
        check('A nothing outside this machine was reachable', true, `${s.log.external.length} attempts refused`);
        await s.context.close();
    },

    async 'approve, wrong code, failed unwrap, and light screenshots'(browser) {
        const s = await newPage(browser);
        const request = register(makeRequest());
        await s.page.goto(`${BASE}/?auth=daemon${request.fragment}`);
        await booted(s);
        check('B fragment and hand-off query left the address', await s.wait(() => !location.hash && !location.search, null, 'address cleanup'));
        const masterKey = await setUpPasskey(s.page);
        await signIn(s.page);
        check('B the dialog opens once the account is ready', await dialogShows(s, /Authorize this computer/, 'review'));
        await shot(s.page, 'B-review-light');
        check('B a link alone sends nothing sensitive', !org.calls.some(call => /approve|reveal/.test(call.path)));

        await typeCodeAndApprove(s.page, 'WRONG-CODE');
        check('B a wrong code is reported', await dialogShows(s, /does not match your terminal/, 'bad code'));
        check('B a wrong code reaches no passkey prompt', !org.calls.some(call => call.path.includes('/reveal')));
        await shot(s.page, 'B-wrong-code-light');

        const goodWrapper = org.wrapped;
        org.wrapped = Buffer.from(JSON.stringify({ iv: crypto.randomBytes(12).toString('base64'), ciphertext: crypto.randomBytes(48).toString('base64') })).toString('base64');
        await typeCodeAndApprove(s.page);
        check('B a wrapper that will not open is reported', await dialogShows(s, /That did not work\. Nothing was sent/, 'unwrap failure'));
        check('B a failed unwrap sends no approval', approvals() === 0);

        org.wrapped = goodWrapper;
        await typeCodeAndApprove(s.page);
        check('B approval completes', await dialogShows(s, /oa-clientd is authorized/, 'done'));
        await shot(s.page, 'B-authorized-light');
        const approved = org.approved.get(request.transaction);
        check('B the approval names the bound account', approved?.expectedAccountId === ACCOUNT);
        check('B the org receives no plaintext key', approved && !JSON.stringify(approved).includes(b64u(masterKey)) && !JSON.stringify(approved).includes(masterKey.toString('base64')));
        check('B the key hash matches the link', approved?.daemonPublicKeyHash === request.hash);
        const opened = approved && openEnvelope(request, approved.sealed);
        check('B the daemon opens the envelope to the real key', opened?.masterKey === b64u(masterKey) && opened?.accountId === ACCOUNT && opened?.origin === BASE && opened?.transaction === request.transaction);
        check('B the finished request is no longer saved', await s.page.evaluate(() => sessionStorage.getItem('oa-daemon-authorization') === null));
        check('B every browser call carried an Origin', org.calls.filter(call => call.path.startsWith('/auth/daemon/')).every(call => call.origin === BASE));
        check('B no page errors', s.log.errors.length === 0, JSON.stringify(s.log.errors.slice(0, 3)));
        await s.context.close();
    },

    async 'device list and revoke, dark and phone'(browser) {
        const s = await newPage(browser, { theme: 'dark', viewport: { width: 390, height: 844 } });
        await s.page.goto(`${BASE}/`);
        await booted(s);
        const request = register(makeRequest());
        await signIn(s.page);
        await setHash(s.page, request.fragment);
        check('C review on a phone in dark', await dialogShows(s, /Authorize this computer/, 'review'));
        await shot(s.page, 'C-review-dark-phone');
        await s.page.locator('.daemon-authorize-decline').click();
        check('C declining reaches the org', await s.wait(() => !document.querySelector('.daemon-authorize-modal:not(.hidden)'), null, 'dialog closed') && org.denied.includes(request.transaction));

        await setHash(s.page, '#oa-daemon-devices');
        check('C the list opens from a hash change', await dialogShows(s, /Authorized computers[\s\S]*darwin\/arm64/, 'device list'));
        const list = org.calls.find(call => call.path === '/auth/daemon/devices/list');
        check('C the list is a POST with an Origin', list?.method === 'POST' && list?.origin === BASE, JSON.stringify(list));
        await shot(s.page, 'C-devices-dark-phone');
        await s.page.locator('.daemon-device-revoke').click();
        check('C revoke empties the list', await dialogShows(s, /No computers are authorized/, 'empty list'));
        check('C revoke is a DELETE of that computer', org.calls.some(call => call.method === 'DELETE' && call.path === '/auth/daemon/devices/dev_1' && call.origin === BASE));
        await shot(s.page, 'C-devices-empty-dark-phone');
        await s.page.keyboard.press('Escape');
        await s.context.close();
    },

    async 'account changes while sealing never approve'(browser) {
        for (const [name, change] of [
            ['another account', page => signIn(page, OTHER_ACCOUNT, { bump: true })],
            ['logout and back to the same account', page => signIn(page, ACCOUNT, { bump: true })]
        ]) {
            resetOrg();
            const s = await newPage(browser);
            const request = register(makeRequest());
            await s.page.goto(`${BASE}/${request.fragment}`);
            await booted(s);
            await setUpPasskey(s.page);
            await signIn(s.page);
            await dialogShows(s, /Authorize this computer/, 'review');
            await holdSealing(s.page);
            await typeCodeAndApprove(s.page);
            check(`D ${name}: sealing is reached`, await s.wait(() => window.__sealReached, null, 'the seal'));
            await change(s.page);
            check(`D ${name}: the dialog ends at once`, await dialogShows(s, /Authorization failed[\s\S]*account changed/, 'failed'));
            await s.page.evaluate(() => window.__releaseSeal());
            await s.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
            check(`D ${name}: no approval was sent`, approvals() === 0, String(approvals()));
            await s.context.close();
        }
    },

    async 'a stale response cannot draw over a newer dialog'(browser) {
        const s = await newPage(browser);
        await s.page.goto(`${BASE}/`);
        await booted(s);
        await signIn(s.page);
        const releaseList = holdRoute('/auth/daemon/devices/list');
        await setHash(s.page, '#oa-daemon-devices');
        await s.wait(() => document.querySelector('.daemon-authorize-modal:not(.hidden)'), null, 'the list dialog');
        await s.page.keyboard.press('Escape');
        const request = register(makeRequest());
        await setHash(s.page, request.fragment);
        check('E the new request reaches review', await dialogShows(s, /Authorize this computer/, 'review'));
        releaseList();
        await s.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
        const text = await dialogText(s.page);
        check('E the old list did not replace it', /Authorize this computer/.test(text) && !/Authorized computers/.test(text), text.slice(0, 60));
        await s.context.close();
    },

    async 'a new link during review and during an approval'(browser) {
        const s = await newPage(browser);
        await s.page.goto(`${BASE}/`);
        await booted(s);
        await setUpPasskey(s.page);
        await signIn(s.page);
        const first = register(makeRequest());
        await setHash(s.page, first.fragment);
        await dialogShows(s, /Authorize this computer/, 'first review');
        const second = register(makeRequest());
        await setHash(s.page, second.fragment);
        for (let i = 0; i < 100 && !org.denied.includes(first.transaction); i += 1) await s.page.waitForTimeout(100);
        check('F a newer link replaces an idle review and declines it', org.denied.includes(first.transaction));

        const releaseApprove = holdRoute('/auth/daemon/approve');
        await dialogShows(s, /Authorize this computer/, 'second review');
        await typeCodeAndApprove(s.page);
        for (let i = 0; i < 100 && !org.gates.get('/auth/daemon/approve')?.reached; i += 1) await s.page.waitForTimeout(100);
        check('F the approval has reached the org', org.gates.get('/auth/daemon/approve')?.reached === true);
        const third = register(makeRequest());
        await setHash(s.page, third.fragment);
        await s.page.waitForTimeout(1200);
        check('F a link during an approval does not take the screen', /Waiting for passkey/.test(await dialogText(s.page)));
        const during = await active(s.page);
        check('F the running approval still owns the dialog', during.transaction === second.transaction && during.status === 'approving', JSON.stringify(during));
        check('F the waiting link has not been loaded', lookupsOf(third) === 0, String(lookupsOf(third)));
        const saved = await s.page.evaluate(() => JSON.parse(sessionStorage.getItem('oa-daemon-authorization')).transaction);
        check('F the newest request is what is saved', saved === third.transaction);
        releaseApprove();
        check('F the waiting link then opens', await s.wait(transaction => {
            const modal = window.app?.ui?.daemonAuthorizeModal;
            return modal?.transaction === transaction && modal.session?.getState().status === 'review';
        }, third.transaction, 'the third request in review'));
        check('F its review is on screen, ready for a code', /Approve with passkey/.test(await dialogText(s.page)), (await dialogText(s.page)).slice(0, 80));
        check('F the approval was not lost or mixed', org.approved.has(second.transaction) && !org.approved.has(third.transaction));
        // Three poll intervals: a retry loop in the flow would load again in this time.
        await s.page.waitForTimeout(1600);
        const counts = [first, second, third].map(lookupsOf);
        check('F each accepted request loaded exactly once', counts.every(count => count === 1), counts.join(','));
        const settled = await active(s.page);
        check('F the third request still owns the dialog', settled.transaction === third.transaction && settled.status === 'review', JSON.stringify(settled));
        await s.context.close();
    },

    async 'the device list survives a same-tab sign-in'(browser) {
        const s = await newPage(browser);
        await s.page.goto(`${BASE}/#oa-daemon-devices`);
        await booted(s);
        check('G the address is cleaned and the request saved', await s.wait(() => !location.hash && sessionStorage.getItem('oa-daemon-devices'), null, 'saved devices request'));
        await s.page.reload();
        await booted(s);
        await s.wait(() => { const modal = document.getElementById('account-modal'); return modal && !modal.classList.contains('hidden'); }, null, 'sign-in offered');
        check('G the request survives the reload', await s.page.evaluate(() => !!sessionStorage.getItem('oa-daemon-devices')));
        await signIn(s.page);
        check('G the list opens after sign-in', await dialogShows(s, /Authorized computers/, 'device list'));
        check('G the saved request is used up', await s.page.evaluate(() => sessionStorage.getItem('oa-daemon-devices') === null));
        await signIn(s.page, OTHER_ACCOUNT, { bump: true });
        check('G another account closes the list', await s.wait(() => !document.querySelector('.daemon-authorize-modal:not(.hidden)'), null, 'list closed'));
        await s.context.close();
    },

    async 'a new account is not interrupted'(browser) {
        const s = await newPage(browser);
        const request = register(makeRequest());
        await s.page.goto(`${BASE}/${request.fragment}`);
        await booted(s);
        await s.wait(() => window.app?.accountModal?.isOpen, null, 'sign-in offered');
        await s.page.evaluate(() => { window.app.accountModal.creationStep = 'recovery'; });
        await signIn(s.page);
        await s.page.waitForTimeout(1500);
        check('H the dialog waits while the recovery step is open', !(await hasDialog(s.page)) && await s.page.evaluate(() => window.app.accountModal.isOpen));
        await s.page.evaluate(() => {
            window.app.accountModal.creationStep = 'idle';
            window.app.accountModal.close();
        });
        check('H the dialog follows when that step is done', await dialogShows(s, /Authorize this computer/, 'review'));
        await s.context.close();
    }
};

// --- Run ------------------------------------------------------------------------
const orgServer = http.createServer((request, response) => {
    orgRoutes(request, response).catch(error => {
        console.error('org stand-in failed', error);
        response.destroy(error);
    });
});
await new Promise((resolve, reject) => orgServer.once('error', reject).listen(ORG_PORT, '127.0.0.1', resolve));
const artifactServer = DIST ? distServer() : null;
if (artifactServer) await new Promise((resolve, reject) => artifactServer.once('error', reject).listen(DIST_PORT, '127.0.0.1', resolve));
const chatServer = spawn(process.execPath, ['scripts/dev-server.mjs'], {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, OA_CHAT_DEV_PORT: String(CHAT_PORT), OA_ORG_DEV_URL: `http://127.0.0.1:${ORG_PORT}` }
});
let browser;
try {
    for (let i = 0; ; i += 1) {
        try {
            await fetch(`${BASE}/`);
            break;
        } catch (error) {
            if (i > 100) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || undefined,
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|all|no)_proxy$/i.test(name))),
        args: ['--no-proxy-server', '--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND']
    });
    const words = process.argv.slice(2);
    for (const [name, run] of Object.entries(scenarios)) {
        if (!words.every(word => name.includes(word))) continue;
        console.log(`\n# ${name}`);
        resetOrg();
        try {
            await run(browser);
        } catch (error) {
            check(`${name}: ran to the end`, false, String(error).slice(0, 400));
        }
    }
} finally {
    await browser?.close().catch(() => {});
    chatServer.kill();
    orgServer.close();
    artifactServer?.close();
}
const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
process.exit(failed.length || results.length === 0 ? 1 : 0);
