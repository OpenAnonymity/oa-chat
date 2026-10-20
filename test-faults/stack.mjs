// Starts the unbundled client (scripts/dev-server.mjs), the org stand-in and
// the OpenRouter stand-in, and opens Chromium with openrouter.ai mapped to the
// stand-in. Nothing real is contacted: every other host is refused.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..');
const PORTS = { chat: Number(process.env.OA_FAULTS_CHAT_PORT || 8080), org: 8005, openrouter: 8443 };
export const BASE = `http://localhost:${PORTS.chat}`;

function certificates() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-faults-certs-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'),
        '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=openrouter.ai'], { stdio: 'ignore' });
    return dir;
}

async function waitFor(url, insecure = false) {
    for (let i = 0; i < 100; i += 1) {
        try {
            const response = await fetch(url, insecure ? {} : {});
            if (response.status < 600) return;
        } catch { /* not up yet */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`${url} did not start`);
}

export async function startStack() {
    // Never mistake an unrelated or older test server for this run's stack.
    for (const port of Object.values(PORTS)) {
        await new Promise((resolve, reject) => {
            const probe = net.createServer();
            probe.once('error', reject);
            probe.listen(port, '127.0.0.1', () => probe.close(resolve));
        });
    }
    const certDir = certificates();
    const env = { ...process.env, OA_FAULTS_CERTS: certDir, OA_CHAT_DEV_PORT: String(PORTS.chat),
        OA_ORG_DEV_URL: `http://127.0.0.1:${PORTS.org}`, NODE_TLS_REJECT_UNAUTHORIZED: '0' };
    const children = [
        spawn(process.execPath, [path.join(here, 'mock-org.mjs')], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] }),
        spawn(process.execPath, [path.join(here, 'mock-openrouter.mjs')], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] }),
        spawn(process.execPath, ['scripts/dev-server.mjs'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })
    ];
    const previousTLS = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    let browser;
    const stop = async () => {
        await browser?.close().catch(() => {});
        for (const child of children) child.kill();
        if (previousTLS === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTLS;
        fs.rmSync(certDir, { recursive: true, force: true });
    };
    try {
    await waitFor(`http://127.0.0.1:${PORTS.org}/__log`);
    await waitFor(`https://127.0.0.1:${PORTS.openrouter}/__script`);
    await waitFor(`${BASE}/`);
    // Every host but the client and the OpenRouter stand-in fails to
    // resolve, so nothing real is reached (the relay included: the client
    // falls back to a direct connection as it does when the relay is down).
    browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || undefined,
        // No proxy from the environment: the stand-ins are local.
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|all|no)_proxy$/i.test(name))),
        args: ['--no-proxy-server',
            `--host-resolver-rules=MAP openrouter.ai 127.0.0.1:${PORTS.openrouter}, MAP localhost 127.0.0.1, MAP * ~NOTFOUND`]
    });
    return { browser, stop };
    } catch (error) {
        await stop();
        throw error;
    }
}

export async function script(steps, byModel = {}) {
    const response = await fetch(`https://127.0.0.1:${PORTS.openrouter}/__script`, {
        method: 'POST', body: JSON.stringify({ reset: true, script: steps, byModel })
    });
    return response.json();
}

export async function providerLog() {
    return (await (await fetch(`https://127.0.0.1:${PORTS.openrouter}/__script`)).json()).log;
}

/** A fresh browser context with tickets, Gemini selected and sign-in lifted. */
export async function openChat(browser, { model = 'google/gemini-3.8-flash' } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, ignoreHTTPSErrors: true });
    const events = [];
    await context.route(url => {
        const { hostname } = new URL(url);
        return hostname !== 'localhost' && hostname !== 'openrouter.ai';
    }, route => route.abort('connectionrefused'));
    const page = await context.newPage();
    page.on('pageerror', error => events.push(`pageerror: ${String(error).slice(0, 200)}`));
    await page.goto(`${BASE}/`);
    await page.waitForFunction(() => window.chatInputReady && window.chatDB?.db);
    await page.evaluate(async ({ model }) => {
        const tickets = Array.from({ length: 40 }, (_, i) => ({ blinded_request: `b${i}`, signed_response: `s${i}`,
            finalized_ticket: `fin-${i}-${Math.random().toString(36).slice(2)}` }));
        await window.chatDB.saveSetting('tickets-active', tickets);
        await window.chatDB.saveSetting('selectedModel', model);
    }, { model });
    await page.reload();
    await page.waitForFunction(() => window.chatInputReady && window.app?.state?.models?.length > 0, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    await page.evaluate(async () => {
        window.app.signInPolicy = { ...window.app.signInPolicy, required: false };
        window.app.accountModal?.close?.();
        // The relay is a separate fault surface; these scenarios go direct.
        await window.networkProxy?.updateSettings?.({ enabled: false }, { silent: true });
    });
    return { context, page, events };
}

export async function send(page, text) {
    const input = page.locator('textarea').first();
    await input.click();
    await input.fill(text);
    await page.locator('#send-btn').click();
}

/** True while this chat has any reply, regenerate or key request in flight. */
export async function busy(page) {
    return page.evaluate(() => {
        const app = window.app;
        const id = app?.state?.currentSessionId;
        if (!id) return Boolean(app?.getPendingSend?.(null));
        return Boolean(app.getSessionStreamingState(id).isStreaming || app.getPendingSend?.(id) || app.regenerationJobs?.has(id));
    });
}

/** Waits until nothing is in flight, then returns what the person sees and what was saved. */
export async function settled(page, { timeout = 60000 } = {}) {
    const started = Date.now();
    await page.waitForTimeout(300);
    while (await busy(page)) {
        if (Date.now() - started > timeout) throw new Error('the reply never settled');
        await page.waitForTimeout(200);
    }
    await page.waitForTimeout(500);
    return view(page);
}

export async function view(page) {
    return page.evaluate(async () => {
        const id = window.app.state.currentSessionId;
        const saved = id ? await window.chatDB.getSessionMessages(id) : [];
        const lastAssistant = saved.filter(m => m.role === 'assistant').at(-1);
        const last = lastAssistant ? document.querySelector(`[data-message-id="${CSS.escape(lastAssistant.id)}"]`) : null;
        const toasts = [...document.querySelectorAll('[role=alert],[role=status],[class*=toast]')]
            .map(el => el.innerText.trim()).filter(Boolean);
        const council = [...document.querySelectorAll('[data-lane-id], .council-response')].map(el => el.innerText.trim().slice(0, 300));
        return {
            lastReply: (last?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
            saved: saved.map(m => ({ role: m.role, content: String(m.content || '').slice(0, 200), isLocalOnly: m.isLocalOnly === true,
                notice: m.regenerationNotice || null, lanes: m.council?.stage1?.map?.(e => ({ model: e.model || e.name, status: e.status, response: String(e.response || '').slice(0, 120), error: e.error || null })) || null })),
            page: document.body.innerText,
            toasts: [...new Set(toasts)],
            council
        };
    });
}
