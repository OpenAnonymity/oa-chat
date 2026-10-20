// Fault-injection suite: real client UI (unbundled, scripts/dev-server.mjs),
// stand-ins for oa-org and OpenRouter, headless Chromium. Each fault the
// provider side can produce is run through each way a person asks for a
// reply: send, regenerate, a Parallel lane, and quick ask.
//
//   node test-faults/scenarios.mjs              # everything
//   node test-faults/scenarios.mjs send 429     # scenarios whose id contains every word
//
// Exit code is non-zero when any check fails. Results: test-faults/results/.
import fs from 'node:fs';
import path from 'node:path';
import { startStack, script, providerLog, openChat, send, settled, view, root } from './stack.mjs';

const GEMINI = 'google/gemini-3.8-flash';
const OTHER = 'openai/gpt-6.1';
const OK = { kind: 'ok', text: 'Here is the answer from the mock provider.' };
const http429 = seconds => ({ kind: 'http', status: 429, headers: { 'retry-after': String(seconds) } });

// What the provider does, what the person must end up seeing, and how many
// requests may go out. `answered` = the mock's answer is shown.
const FAULTS = {
    '429-retry-after-2s': { steps: [http429(2), OK], answered: true, requests: 2, minGapMs: 2000 },
    '429-retry-after-6s': { steps: [http429(6), OK], answered: true, requests: 2, minGapMs: 6000 },
    '429-retry-after-7s': { steps: [http429(7)], requests: 1, shows: /The model is temporarily busy\. Please try again\./ },
    '429-retry-after-30s': { steps: [http429(30)], requests: 1, shows: /The model is temporarily busy\. Please try again\./ },
    '429-always': { steps: [http429(2)], requests: 2, minGapMs: 2000, shows: /The model is temporarily busy\. Please try again\./ },
    '429-no-hint': { steps: [{ kind: 'http', status: 429 }, OK], answered: true, requests: 2, minGapMs: 2000 },
    '502-http-once': { steps: [{ kind: 'http', status: 502 }, OK], answered: true, requests: 2, minGapMs: 1000 },
    '503-retry-after-2s': { steps: [{ kind: 'http', status: 503, headers: { 'retry-after': '2' } }, OK], answered: true, requests: 2, minGapMs: 2000 },
    '503-retry-after-7s': { steps: [{ kind: 'http', status: 503, headers: { 'retry-after': '7' } }], requests: 1, shows: /Service unavailable \(HTTP 503\)/ },
    '504-http-once': { steps: [{ kind: 'http', status: 504 }, OK], answered: true, requests: 2, minGapMs: 1000 },
    '429-after-text': { steps: [{ kind: 'stream-error', code: 429, afterWords: 3 }], requests: 1, partial: /Here is the/,
        shows: /The model is temporarily busy\. Please try again\./ },
    '504-in-stream-once': { steps: [{ kind: 'stream-error', code: 504 }, OK], answered: true, requests: 2 },
    '504-in-stream-always': { steps: [{ kind: 'stream-error', code: 504 }], requests: 2, shows: /Gateway timeout \(provider (?:error )?504\)/ },
    'abort-before-text': { steps: [{ kind: 'cut', afterWords: 0 }, OK], answered: true, requests: 2 },
    'abort-mid-stream': { steps: [{ kind: 'cut', afterWords: 3 }], requests: 1, partial: /Here is the/,
        shows: /The connection closed before the reply finished\./ },
    'stall-mid-stream': { steps: [{ kind: 'stall', afterWords: 3 }], requests: 1, partial: /Here is the/,
        shows: /stopped responding/i, idleMs: 3000 },
    'hidden-thinking-then-504': { steps: [{ kind: 'withheld-then-error', code: 504 }], requests: 1,
        shows: /Gateway timeout \(provider (?:error )?504\)/ }
};

// Words that must never reach the person.
const FORBIDDEN = [
    [/previous answer was kept/i, 'the old regenerate status box'],
    [/provider asked to wait/i, 'a requested-wait sentence'],
    [/operation was aborted/i, 'a raw transport abort'],
    [/after \d+ retries/i, 'a retry count'],
    [/⚠️/, 'the warning emoji fallback'],
    [/signal is aborted/i, 'raw abort text'],
    [/Provider returned error/, 'the router\'s raw message'],
    [/Error: Error|Error: network error|Failed to fetch/, 'a raw browser error']
];

async function useShortWatchdog(page, idleMs) {
    if (!idleMs) return;
    await page.evaluate(ms => {
        window.openRouterAPI.options.inferenceTiming = { idleMs: ms, warningMs: ms - 500, pollMs: 100 };
    }, idleMs);
}

async function requestsTo(model) {
    return (await providerLog()).filter(entry => !model || entry.model === model);
}

function check(results, ok, label, detail = '') {
    results.push({ ok: Boolean(ok), label, ...(detail ? { detail: String(detail).slice(0, 400) } : {}) });
}

function forbiddenChecks(results, text) {
    for (const [pattern, label] of FORBIDDEN) check(results, !pattern.test(text), `no ${label}`, pattern.test(text) ? text.match(pattern)[0] : '');
}

function gapChecks(results, log, fault) {
    if (!fault.minGapMs || log.length < 2) return;
    const gap = log[1].at - log[0].at;
    check(results, gap >= fault.minGapMs, `waited at least the requested ${fault.minGapMs / 1000} s before resending`, `${gap} ms`);
    check(results, gap <= Math.min(fault.minGapMs * 1.25, 6000) + 1500, 'did not wait much longer than asked (jitter ≤ 25 %)', `${gap} ms`);
}

// ---- paths -------------------------------------------------------------

async function viaSend(browser, fault) {
    const { page, context, events } = await openChat(browser);
    await useShortWatchdog(page, fault.idleMs);
    await script([OK], { [GEMINI]: fault.steps });
    await send(page, 'Advanced AI capabilities can be used to make progress on many problems.');
    const seen = await settled(page);
    return { page, context, events, seen, log: await requestsTo(GEMINI), text: seen.lastReply };
}

async function viaRegenerate(browser, fault, { overError = false } = {}) {
    const { page, context, events } = await openChat(browser);
    await useShortWatchdog(page, fault.idleMs);
    // The reply being regenerated: a real answer, or (overError) an error row.
    await script([OK], { [GEMINI]: overError ? [{ kind: 'stream-error', code: 504 }] : [OK] });
    await send(page, 'Feels like we got a lot of filler words here.');
    const before = await settled(page);
    await script([OK], { [GEMINI]: fault.steps });
    await page.locator('.regenerate-message-btn').last().click();
    const seen = await settled(page);
    return { page, context, events, seen, before, log: await requestsTo(GEMINI), text: seen.lastReply };
}

async function viaParallel(browser, fault) {
    const { page, context, events } = await openChat(browser);
    await useShortWatchdog(page, fault.idleMs);
    await enableParallel(page);
    await script([OK], { [GEMINI]: fault.steps, [OTHER]: [{ ...OK, text: 'The other lane answers normally.' }] });
    await send(page, 'Compare these two.');
    const seen = await settled(page, { timeout: 90000 });
    const message = seen.saved.findLast(m => m.role === 'assistant');
    const lane = message?.lanes?.find(entry => /gemini/i.test(entry.model || '')) || message?.lanes?.[0] || null;
    const laneText = seen.council.find(text => /Gemini/i.test(text)) || seen.lastReply;
    return { page, context, events, seen, lane, log: await requestsTo(GEMINI), text: laneText };
}

async function viaQuickAsk(browser, fault) {
    const { page, context, events } = await openChat(browser);
    await useShortWatchdog(page, fault.idleMs);
    await script([OK]);
    await send(page, 'Give me something to select.');
    await settled(page);
    await script([OK], { [GEMINI]: fault.steps });
    await openQuickAsk(page);
    const started = Date.now();
    await page.waitForTimeout(300);
    while (await page.evaluate(() => window.app.chatArea.quickAsk.requestInFlight)) {
        if (Date.now() - started > 60000) throw new Error('quick ask never settled');
        await page.waitForTimeout(200);
    }
    await page.waitForTimeout(300);
    const text = await page.evaluate(() => (window.app.chatArea.quickAsk.window?.querySelector('.quick-ask-mini-chat, .quick-ask-answer')?.innerText || '').replace(/\s+/g, ' ').trim());
    return { page, context, events, seen: await view(page), log: await requestsTo(GEMINI), text };
}

const PATHS = {
    send: viaSend,
    regenerate: viaRegenerate,
    'regenerate-over-error': (browser, fault) => viaRegenerate(browser, fault, { overError: true }),
    parallel: viaParallel,
    'quick-ask': viaQuickAsk
};

// ---- checks ------------------------------------------------------------

function judge(pathName, faultName, fault, run) {
    const results = [];
    const { text, log, seen, events } = run;
    const answer = /Here is the answer from the mock provider\./;
    if (fault.answered) {
        check(results, answer.test(text), 'the answer arrives after the resend', text);
    } else if (pathName === 'regenerate') {
        // A real answer is kept; the failure is named once, in plain words.
        check(results, answer.test(text), 'the saved answer is kept', text);
        const toast = seen.toasts.find(t => /Couldn't regenerate/.test(t)) || '';
        check(results, Boolean(toast), 'the failure is said once ("Couldn\'t regenerate: …")', seen.toasts.join(' | '));
        if (fault.shows && !fault.partial) check(results, fault.shows.test(toast), 'with the current reason', toast);
    } else {
        if (fault.shows) check(results, fault.shows.test(text), 'the reason is shown in plain words', text);
        if (fault.partial) check(results, fault.partial.test(text), 'the partial answer is kept', text);
    }
    if (pathName === 'regenerate-over-error' && !fault.answered && fault.shows && !fault.partial) {
        check(results, !/Gateway timeout \(provider 504\)\.?$/.test(text) || fault.shows.test(text), 'the row shows the new failure', text);
    }
    check(results, log.length === fault.requests, `${fault.requests} request(s) to the provider`, `${log.length}: ${log.map(entry => entry.kind).join(', ')}`);
    gapChecks(results, log, fault);
    forbiddenChecks(results, `${text}\n${seen.page}\n${seen.toasts.join('\n')}`);
    check(results, !seen.saved.some(m => m.notice), 'no replacement notice saved');
    check(results, !events.some(e => e.startsWith('pageerror')), 'no uncaught page errors', events.join(' | '));
    if (pathName === 'parallel') {
        check(results, /The other lane answers normally/.test(seen.page), 'the healthy lane still answers');
    }
    return results;
}

async function enableParallel(page) {
    await page.getByRole('radio', { name: 'Parallel', exact: true }).click();
    await page.locator('#council-secondary-model-btn').click();
    await page.locator(`.model-option[data-model-name="${OTHER}"]`).click();
    await page.locator('#model-picker-modal').waitFor({ state: 'hidden' });
}

async function openQuickAsk(page) {
    // Select rendered answer text, then use the same Ask button as a person.
    const answer = page.locator('.message-assistant .message-content p').last();
    const box = await answer.boundingBox();
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(box.width - 2, 160), box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.locator('.quick-ask-popover-btn').click();
    await page.locator('.quick-ask-window:not(.hidden)').waitFor();
}

async function stopDuringWait(browser, pathName) {
    const { page, context, events } = await openChat(browser);
    if (pathName === 'parallel') await enableParallel(page);
    if (pathName === 'regenerate' || pathName === 'quick-ask') {
        await script([OK]);
        await send(page, 'Keep this answer.');
        await settled(page);
    }
    await script([OK], { [GEMINI]: [http429(5), OK] });
    if (pathName === 'regenerate') await page.locator('.regenerate-message-btn').last().click();
    else if (pathName === 'quick-ask') await openQuickAsk(page);
    else await send(page, 'Stop me while you wait.');
    const started = Date.now();
    while ((await requestsTo(GEMINI)).length < 1 && Date.now() - started < 15000) await page.waitForTimeout(100);
    await page.waitForTimeout(500);
    if (pathName === 'quick-ask') await page.locator('#new-chat-btn').click();
    else await page.locator('#send-btn').click();
    const seen = await settled(page);
    await page.waitForTimeout(7000); // past the maximum jittered wait
    const results = [];
    const log = await requestsTo(GEMINI);
    check(results, log.length === 1, 'Stop/leaving the chat during the wait sends nothing more', `${log.length}`);
    check(results, !/Too many requests|temporarily busy|Error/.test(seen.lastReply), 'a Stop is not shown as an error', seen.lastReply);
    if (pathName === 'regenerate') check(results, /Here is the answer/.test(seen.lastReply), 'Stop preserves the saved answer');
    forbiddenChecks(results, seen.page);
    check(results, !events.some(e => e.startsWith('pageerror')), 'no uncaught page errors', events.join(' | '));
    await context.close();
    return results;
}

// ---- runner ------------------------------------------------------------

const filters = process.argv.slice(2).map(word => word.toLowerCase());
const matches = id => filters.every(word => id.toLowerCase().includes(word));
const resultsDir = path.join(root, 'test-faults', 'results');
fs.mkdirSync(resultsDir, { recursive: true });

const stack = await startStack();
const summary = [];
try {
    const jobs = [];
    for (const [pathName, run] of Object.entries(PATHS)) {
        for (const [faultName, fault] of Object.entries(FAULTS)) jobs.push([`${pathName} · ${faultName}`, pathName, faultName, fault, run]);
    }
    for (const name of ['send', 'regenerate', 'parallel', 'quick-ask']) jobs.push([`${name} · stop-during-429-wait`, name, 'stop', null, null]);
    for (const [id, pathName, faultName, fault, run] of jobs) {
        if (!matches(id)) continue;
        let results;
        try {
            if (!run) results = await stopDuringWait(stack.browser, pathName);
            else {
                const outcome = await run(stack.browser, fault);
                results = judge(pathName, faultName, fault, outcome);
                await outcome.page.screenshot({ path: path.join(resultsDir, `${id.replace(/[^a-z0-9-]+/gi, '_')}.png`) }).catch(() => {});
                await outcome.context.close();
            }
        } catch (error) {
            results = [{ ok: false, label: 'scenario ran to the end', detail: String(error?.stack || error).slice(0, 400) }];
        }
        const passed = results.every(result => result.ok);
        summary.push({ id, passed, results });
        fs.writeFileSync(path.join(resultsDir, `${id.replace(/[^a-z0-9-]+/gi, '_')}.json`), JSON.stringify(results, null, 2));
        console.log(`${passed ? 'PASS' : 'FAIL'}  ${id}`);
        for (const result of results.filter(r => !r.ok)) console.log(`      ✗ ${result.label}${result.detail ? ` — ${result.detail}` : ''}`);
    }
} finally {
    await stack.stop();
}
fs.writeFileSync(path.join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2));
const failed = summary.filter(entry => !entry.passed).length;
console.log(`\n${summary.length - failed}/${summary.length} scenarios passed`);
process.exit(failed > 0 || summary.length === 0 ? 1 : 0);
