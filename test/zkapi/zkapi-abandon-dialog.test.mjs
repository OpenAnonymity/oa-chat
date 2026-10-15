import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MiniEvent, createDocument, keyEvent } from './_miniDom.mjs';

const { ABANDON_WORDS, abandonRefusalWords, openAbandonDialog } = await import('../../chat/zkapi/components/AbandonDialog.js');
const { ABANDON_BLOCKED_BY } = await import('../../chat/zkapi/versioning/abandonNote.mjs');
const { versionCopyText } = await import('../../chat/zkapi/versioning/copy.mjs');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// What facade.abandonPreview() answers. 140000 gwei is 0.00014 ETH, $0.42 at
// a price of $3000; the line is the smallest chat key, $1.00.
const ZERO = Object.freeze({
    kind: 'zero', noteId: 7, balanceUnits: '0', limitUnits: null, balanceUsdMicros: 0, limitUsdMicros: null,
    expiryMs: 1_800_000_000_000, currentLabel: 'Version 1', targetLabel: 'Version 2'
});
const DUST = Object.freeze({
    kind: 'dust', noteId: 7, balanceUnits: '140000', limitUnits: '333334', balanceUsdMicros: 420_000,
    limitUsdMicros: 1_000_000, expiryMs: 1_800_000_000_000, currentLabel: 'Version 1', targetLabel: 'Version 2'
});

const dialogOf = doc => doc.body.querySelector('[data-zkapi-abandon-dialog]');
const control = (dialog, name) => dialog.querySelector(`[data-zkapi-abandon-action="${name}"]`);
const statusOf = dialog => dialog.querySelector('[data-zkapi-abandon-status]');
const check = dialog => dialog.querySelector('[data-zkapi-abandon-check]');
const settle = () => new Promise(resolve => setImmediate(resolve));

function page(overrides = {}) {
    const doc = createDocument();
    const calls = { giveUp: [], reload: 0, timers: [], cleared: [] };
    let release = null;
    const giveUp = overrides.giveUp || (args => {
        calls.giveUp.push(args);
        if (overrides.hold) return new Promise(resolve => { release = resolve; });
        return Promise.resolve(overrides.answer || { done: true, kind: args && 'dust' });
    });
    const options = {
        doc,
        preview: 'preview' in overrides ? overrides.preview : DUST,
        giveUp: overrides.giveUpMissing ? undefined : giveUp,
        reload: () => { calls.reload += 1; },
        setTimer: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
        clearTimer: handle => { calls.cleared.push(handle); }
    };
    return { doc, calls, options, release: value => release(value) };
}

function open(overrides) {
    const harness = page(overrides);
    const handle = openAbandonDialog(harness.options);
    return { ...harness, handle, dialog: dialogOf(harness.doc) };
}

const tick = dialog => {
    const box = check(dialog);
    box.click();
    return box;
};

// ---------------------------------------------------------------------------
// An empty balance: one button, nothing is forfeited
// ---------------------------------------------------------------------------

test('an empty balance is one button and no checkbox, because nothing is given up', async () => {
    const { dialog, calls, handle, doc } = open({ preview: ZERO, answer: { done: true, kind: 'zero' } });
    assert.equal(dialog.tagName, 'dialog');
    assert.equal(dialog.showModalCalls, 1);
    assert.equal(dialog.querySelector('[data-zkapi-abandon-kind]').getAttribute('data-zkapi-abandon-kind'), 'zero');
    assert.equal(check(dialog), null, 'no checkbox for an empty balance');
    const confirm = control(dialog, 'confirm');
    assert.equal(confirm.disabled, false);
    assert.equal(confirm.textContent, 'Clear this balance');
    assert.equal(dialog.querySelector('#zkapi-abandon-title').textContent, 'Clear this balance');
    const words = dialog.textContent;
    assert.match(words, /This balance is empty, and version 1 no longer takes deposits\./);
    assert.match(words, /Clear it to deposit into version 2\./);
    assert.match(words, /Nothing moves on Ethereum\./);
    assert.match(words, /This app can’t bring the balance back once you give it up\./);
    assert.equal(doc.activeElement, dialog.querySelector('#zkapi-abandon-title'));

    confirm.click();
    await settle();
    // What was shown is what was asked for.
    assert.deepEqual(calls.giveUp, [{ noteId: 7, balanceUnits: '0' }]);
    assert.equal(statusOf(dialog).textContent, 'Balance cleared from this browser. Reload to add funds to version 2.');
    assert.equal(dialog.querySelector('#zkapi-abandon-title').textContent, 'Balance cleared');
    assert.equal(statusOf(dialog).getAttribute('role'), 'status');
    assert.equal(doc.activeElement, control(dialog, 'reload'), 'focus goes to what comes next');
    assert.equal(control(dialog, 'confirm'), null, 'it can not be done twice');

    control(dialog, 'reload').click();
    assert.equal(calls.reload, 1);
    assert.deepEqual(await handle.result, { done: true, kind: 'zero', why: null });
    assert.equal(dialogOf(doc), null);
});

// ---------------------------------------------------------------------------
// A balance with value: a checkbox AND a button that names the amount
// ---------------------------------------------------------------------------

test('a small balance needs the box ticked, and the button names the amount in dollars and in ether', async () => {
    const { dialog, calls, handle } = open({ preview: DUST, answer: { done: true, kind: 'dust' } });
    assert.equal(dialog.querySelector('#zkapi-abandon-title').textContent, 'Give up this balance');
    const confirm = control(dialog, 'confirm');
    assert.equal(confirm.textContent, 'Give up $0.42 (0.00014 ETH)');
    assert.equal(confirm.disabled, true, 'off until the box is ticked');
    const hint = dialog.querySelector('[data-zkapi-abandon-hint]');
    assert.equal(confirm.getAttribute('aria-describedby'), hint.id, 'the reason is announced with the button');
    assert.equal(hint.textContent, 'Check the box to continue.');
    assert.match(check(dialog).closest('label').textContent, /I understand I won’t get this balance back\./);

    // A click on a disabled button does nothing.
    confirm.click();
    await settle();
    assert.equal(calls.giveUp.length, 0);

    const box = tick(dialog);
    assert.equal(box.checked, true);
    assert.equal(confirm.disabled, false);
    assert.equal(hint.textContent, '', 'the hint goes when it has been followed');
    tick(dialog);
    assert.equal(confirm.disabled, true, 'unticking turns it off again');
    assert.equal(hint.textContent, 'Check the box to continue.');
    tick(dialog);

    const words = dialog.textContent;
    assert.match(words, /This balance is \$0\.42 \(0\.00014 ETH\), and version 1 no longer takes deposits\./);
    assert.match(words, /A withdrawal costs a network fee, which may be more than this balance is worth\./);
    assert.match(words, /Only balances below \$1\.00 \(0\.000333334 ETH\) can be given up\./);
    assert.match(words, /Nothing moves on Ethereum\./);

    confirm.click();
    await settle();
    assert.deepEqual(calls.giveUp, [{ noteId: 7, balanceUnits: '140000' }]);
    assert.equal(statusOf(dialog).textContent, 'Balance given up. It was cleared from this browser. Reload to add funds to version 2.');
    assert.equal(check(dialog), null, 'the box goes with the question');
    // The question is answered: the heading says what happened and the dialog is described by the status.
    assert.equal(dialog.querySelector('#zkapi-abandon-title').textContent, 'Balance given up');
    assert.equal(dialog.querySelector('[data-zkapi-abandon-intro]'), null);
    assert.equal(dialog.getAttribute('aria-describedby'), 'zkapi-abandon-status');
    assert.equal(statusOf(dialog).id, 'zkapi-abandon-status');
    assert.doesNotMatch(dialog.textContent, /You can give it up to deposit/);
    assert.match(dialog.textContent, /Nothing moves on Ethereum\./);
    control(dialog, 'close').click();
    assert.deepEqual(await handle.result, { done: true, kind: 'dust', why: null });
    assert.equal(calls.reload, 0, 'closing does not reload');
});

test('ether is always beside a dollar figure, and without a price it is the only figure', () => {
    const priced = open({ preview: DUST });
    const everything = `${priced.dialog.textContent} ${control(priced.dialog, 'confirm').textContent}`;
    const dollars = [...everything.matchAll(/\$[\d,]+\.\d{2}|less than \$0\.01/g)];
    assert.ok(dollars.length >= 3, 'the amount, the line and the button');
    for (const match of dollars) {
        const after = everything.slice(match.index + match[0].length);
        assert.match(after, /^ \([\d.]+ ETH\)/, `${match[0]} is followed by its ether amount`);
    }
    priced.handle.close();

    const unpriced = open({ preview: { ...DUST, balanceUsdMicros: null, limitUsdMicros: null } });
    const text = `${unpriced.dialog.textContent} ${control(unpriced.dialog, 'confirm').textContent}`;
    assert.equal(/\$/.test(text), false, 'no dollar figure is invented');
    assert.match(text, /This balance is very small \(0\.00014 ETH\), and version 1 no longer takes deposits\./);
    assert.match(text, /Only balances below 0\.000333334 ETH can be given up\./);
    assert.equal(control(unpriced.dialog, 'confirm').textContent, 'Give up 0.00014 ETH');
    unpriced.handle.close();

    // Under a cent is said as it is, with its ether amount.
    const tiny = open({ preview: { ...DUST, balanceUnits: '1', balanceUsdMicros: 3 } });
    assert.equal(control(tiny.dialog, 'confirm').textContent, 'Give up less than $0.01 (0.000000001 ETH)');
    tiny.handle.close();
});

test('the same version named as both the one given up and the one deposited into is not a move', () => {
    const { dialog, handle } = open({ preview: { ...ZERO, targetLabel: 'Version 1' } });
    assert.doesNotMatch(dialog.textContent, /deposit into version 1/);
    handle.close();
    const unnamed = open({ preview: { ...DUST, currentLabel: '', targetLabel: '' } });
    assert.match(unnamed.dialog.textContent, /this version no longer takes deposits/);
    assert.match(unnamed.dialog.textContent, /the newer version/);
    unnamed.handle.close();
});

// ---------------------------------------------------------------------------
// What the service can answer
// ---------------------------------------------------------------------------

test('a refusal that may pass is said and the same dialog can try again', async () => {
    // `busy` is the facade's own: the dialog it asks through is working on something else.
    for (const why of ['busy', 'in_flight', 'unresolved_request', 'lock_busy', 'price_unknown', 'failed',
        'a_reason_this_page_has_no_words_for']) {
        let answers = [{ done: false, why }];
        const harness = page({ giveUp: async args => { harness.calls.giveUp.push(args); return answers.shift() || { done: true, kind: 'dust' }; } });
        const handle = openAbandonDialog(harness.options);
        const dialog = dialogOf(harness.doc);
        tick(dialog);
        control(dialog, 'confirm').click();
        await settle();
        assert.equal(statusOf(dialog).textContent, abandonRefusalWords(why), why);
        assert.ok(statusOf(dialog).textContent.length > 20, why);
        assert.equal(control(dialog, 'confirm').disabled, false, `${why}: asking again is possible`);
        assert.equal(check(dialog).checked, true, 'the person’s confirmation stands');
        assert.equal(handle.close && harness.doc.activeElement, control(dialog, 'confirm'));
        // And it works the second time.
        control(dialog, 'confirm').click();
        await settle();
        assert.equal(harness.calls.giveUp.length, 2);
        assert.match(statusOf(dialog).textContent, /^Balance given up\./);
        handle.close();
        assert.deepEqual(await handle.result, { done: true, kind: 'dust', why: null });
    }
});

test('a refusal that asking again can not change leaves only Close', async () => {
    // `no_locks` is here: a browser without Web Locks stays without them, so asking again can only be
    // refused the same way and the dialog does not invite it.
    const final = ABANDON_BLOCKED_BY.filter(code => !['in_flight', 'unresolved_request', 'price_unknown'].includes(code))
        .concat(['changed', 'unavailable', 'not_available', 'no_locks']);
    for (const why of final) {
        const { dialog, handle, calls, doc } = open({ answer: { done: false, why } });
        tick(dialog);
        control(dialog, 'confirm').click();
        await settle();
        assert.equal(calls.giveUp.length, 1);
        assert.equal(statusOf(dialog).textContent, abandonRefusalWords(why), why);
        assert.equal(control(dialog, 'confirm'), null, `${why}: nothing left to press but close`);
        assert.equal(check(dialog).disabled, true);
        const close = control(dialog, 'cancel');
        assert.equal(close.textContent, ABANDON_WORDS.close);
        assert.equal(doc.activeElement, close);
        close.click();
        assert.deepEqual(await handle.result, { done: false, kind: null, why });
    }
});

test('the confirm handler itself refuses a small balance whose box is not ticked', async () => {
    // The button is off until the box is ticked, and a click on an off button never arrives. The
    // handler must hold the line on its own for a click that does (a script, a stale listener).
    const { dialog, calls, handle } = open({ preview: DUST });
    const confirm = control(dialog, 'confirm');
    assert.equal(confirm.disabled, true);
    assert.equal(check(dialog).checked, false);
    confirm.dispatchEvent(new MiniEvent('click'));
    confirm.disabled = false;
    confirm.dispatchEvent(new MiniEvent('click'));
    await settle();
    assert.equal(calls.giveUp.length, 0, 'nothing was asked for without the box');
    assert.equal(statusOf(dialog).textContent, '');
    // The same handler goes ahead once the box is ticked.
    tick(dialog);
    confirm.dispatchEvent(new MiniEvent('click'));
    await settle();
    assert.equal(calls.giveUp.length, 1);
    handle.close();
});

test('every reason the service can give has its own plain words, and an unknown one is the generic failure', () => {
    const generic = ABANDON_WORDS.refused.failed;
    const words = new Map();
    for (const code of [...ABANDON_BLOCKED_BY, 'no_locks', 'lock_busy', 'busy', 'unavailable', 'not_available', 'failed']) {
        const text = abandonRefusalWords(code);
        assert.ok(text && text.length > 10, code);
        words.set(code, text);
        // A code of its own is never answered with the generic failure.
        if (code !== 'failed') assert.notEqual(text, generic, code);
    }
    assert.ok(words.size >= ABANDON_BLOCKED_BY.length);
    assert.equal(abandonRefusalWords('something_new'), generic);
    assert.equal(abandonRefusalWords(undefined), generic);
    assert.equal(abandonRefusalWords('__proto__'), generic);
    assert.equal(abandonRefusalWords('constructor'), generic);
    // The words the requirements name.
    assert.equal(abandonRefusalWords('in_flight'), 'A chat key is still settling. Try again in a moment.');
    assert.equal(abandonRefusalWords('lock_busy'), 'Another tab is working on this balance. Close it or wait, then try again.');
    assert.match(abandonRefusalWords('not_dust'), /now worth more than can be given up here\. You can withdraw it or keep using it\./);
    assert.equal(abandonRefusalWords('price_unknown'), versionCopyText('abandon.dustNoPrice'));
});

test('a service that throws is a failure to retry, in words that claim nothing about the balance', async () => {
    let calls = 0;
    const harness = page({ giveUp: async () => { calls += 1; throw new Error('SECRET-DETAIL https://operator.example'); } });
    const handle = openAbandonDialog(harness.options);
    const dialog = dialogOf(harness.doc);
    tick(dialog);
    control(dialog, 'confirm').click();
    await settle();
    assert.equal(statusOf(dialog).textContent, ABANDON_WORDS.refused.failed);
    assert.equal(dialog.textContent.includes('SECRET-DETAIL'), false);
    assert.doesNotMatch(statusOf(dialog).textContent, /nothing (was|is) (changed|lost)|safe/i);
    assert.equal(control(dialog, 'confirm').disabled, false);
    assert.equal(calls, 1);
    handle.close();
    assert.deepEqual(await handle.result, { done: false, kind: null, why: 'failed' });
});

test('pressing the button again while the service is working asks once', async () => {
    const { dialog, calls, release, handle } = open({ hold: true });
    tick(dialog);
    const confirm = control(dialog, 'confirm');
    confirm.click();
    await settle();
    assert.equal(calls.giveUp.length, 1);
    assert.equal(statusOf(dialog).textContent, ABANDON_WORDS.working);
    assert.equal(confirm.disabled, true);
    assert.equal(check(dialog).disabled, true, 'the box can not be changed under a request');
    confirm.click();
    check(dialog).click();
    // A click that reaches the handler anyway (a script, a stale listener) is not a second request.
    confirm.dispatchEvent(new MiniEvent('click'));
    await settle();
    assert.equal(calls.giveUp.length, 1);
    release({ done: true, kind: 'dust' });
    await settle();
    assert.match(statusOf(dialog).textContent, /^Balance given up\./);
    handle.close();
    assert.deepEqual(await handle.result, { done: true, kind: 'dust', why: null });
});

test('closing while the service is working waits for its answer, and never calls an unanswered request done', async () => {
    // It answers after the window closed: the caller learns what happened.
    let session = open({ hold: true });
    tick(session.dialog);
    control(session.dialog, 'confirm').click();
    await settle();
    let reported = null;
    session.handle.result.then(value => { reported = value; });
    session.handle.close();
    assert.equal(dialogOf(session.doc), null);
    await settle();
    assert.equal(reported, null);
    session.release({ done: true, kind: 'dust' });
    assert.deepEqual(await session.handle.result, { done: true, kind: 'dust', why: null });

    // It answers with a refusal.
    session = open({ hold: true });
    tick(session.dialog);
    control(session.dialog, 'confirm').click();
    await settle();
    session.handle.close();
    session.release({ done: false, why: 'lock_busy' });
    assert.deepEqual(await session.handle.result, { done: false, kind: null, why: 'lock_busy' });

    // It does not answer in time: not known, and certainly not "done".
    session = open({ hold: true });
    tick(session.dialog);
    control(session.dialog, 'confirm').click();
    await settle();
    session.handle.close();
    assert.equal(session.calls.timers.length, 1);
    session.calls.timers[0].fn();
    assert.deepEqual(await session.handle.result, { done: false, kind: null, why: 'pending' });
});

// ---------------------------------------------------------------------------
// Closing, focus, one at a time
// ---------------------------------------------------------------------------

test('cancel, Escape and the close button leave the balance alone', async () => {
    for (const how of ['cancel', 'escape']) {
        const { dialog, doc, calls, handle } = open({ preview: DUST });
        const reached = [];
        doc.body.addEventListener('keydown', event => reached.push(event.key));
        if (how === 'cancel') control(dialog, 'cancel').click();
        else {
            dialog.dispatchEvent(keyEvent('keydown', 'Escape'));
            assert.deepEqual(reached, [], 'the balance dialog under it never sees the key');
            const event = new MiniEvent('cancel');
            dialog.dispatchEvent(event);
            assert.equal(event.defaultPrevented, true);
        }
        assert.deepEqual(await handle.result, { done: false, kind: null, why: null });
        assert.equal(calls.giveUp.length, 0);
        assert.equal(dialogOf(doc), null);
    }
});

test('focus returns to where it was, and a second request returns the dialog that is open', async () => {
    const harness = page({ preview: ZERO });
    const trigger = harness.doc.createElement('button');
    harness.doc.body.append(trigger);
    trigger.focus();
    const first = openAbandonDialog(harness.options);
    const second = openAbandonDialog(harness.options);
    assert.equal(second, first);
    assert.equal(harness.doc.body.querySelectorAll('[data-zkapi-abandon-dialog]').length, 1);
    first.close();
    await first.result;
    assert.equal(harness.doc.activeElement, trigger);
    assert.equal(harness.doc.body.querySelectorAll('[data-zkapi-abandon-dialog]').length, 0);
});

test('the dialog is labelled and described, and its outcome region is a polite status', () => {
    const { dialog, handle } = open({ preview: DUST });
    assert.equal(dialog.querySelector(`#${dialog.getAttribute('aria-labelledby')}`).tagName, 'h2');
    assert.ok(dialog.querySelector(`#${dialog.getAttribute('aria-describedby')}`));
    assert.equal(statusOf(dialog).getAttribute('role'), 'status');
    assert.equal(statusOf(dialog).getAttribute('role') === 'alert', false);
    assert.equal(check(dialog).closest('label').tagName, 'label', 'the checkbox sits inside its label');
    handle.close();
});

test('a balance the dialog can not act on opens an explanation and calls nothing', async () => {
    const bad = [
        null, undefined, {}, 'dust', 5,
        { ...DUST, kind: 'other' },
        { ...DUST, noteId: -1 },
        { ...DUST, noteId: 1.5 },
        { ...DUST, noteId: '7' },
        { ...DUST, balanceUnits: '1e3' },
        { ...DUST, balanceUnits: '-5' },
        { ...DUST, balanceUnits: '0' },
        { ...ZERO, balanceUnits: '5' },
        { ...DUST, balanceUnits: 14.5 }
    ];
    for (const preview of bad) {
        const { dialog, calls, handle } = open({ preview });
        assert.equal(dialog.querySelector('[data-zkapi-abandon-kind]').getAttribute('data-zkapi-abandon-kind'), 'unavailable');
        assert.equal(control(dialog, 'confirm'), null);
        assert.equal(check(dialog), null);
        assert.ok(dialog.textContent.includes(ABANDON_WORDS.unavailable));
        control(dialog, 'close').click();
        assert.deepEqual(await handle.result, { done: false, kind: null, why: 'unavailable' });
        assert.equal(calls.giveUp.length, 0);
    }
    const missing = open({ preview: DUST, giveUpMissing: true });
    assert.equal(control(missing.dialog, 'confirm'), null, 'no way to give up, so no button');
    missing.handle.close();
    await missing.handle.result;
});

test('a number given as the balance is asked for as the same canonical text', async () => {
    const { dialog, calls } = open({ preview: { ...DUST, balanceUnits: 140000 } });
    tick(dialog);
    control(dialog, 'confirm').click();
    await settle();
    assert.deepEqual(calls.giveUp, [{ noteId: 7, balanceUnits: '140000' }]);
});

test('labels from the registry are text, never markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { dialog, handle } = open({ preview: { ...DUST, currentLabel: hostile, targetLabel: '"><b>2</b>' } });
    assert.equal(dialog.querySelector('img'), null);
    assert.equal(dialog.querySelector('b'), null);
    assert.equal(dialog.querySelector('[onerror]'), null);
    assert.ok(dialog.textContent.includes('<img src=x onerror=alert(1)>'));
    handle.close();
});

test('there is no native confirm: nothing can be blocked or missed by a browser', async () => {
    const original = globalThis.confirm;
    globalThis.confirm = () => { throw new Error('confirm() must not be used'); };
    try {
        const { dialog, handle } = open({ preview: DUST });
        tick(dialog);
        control(dialog, 'confirm').click();
        await settle();
        assert.match(statusOf(dialog).textContent, /^Balance given up\./);
        handle.close();
        await handle.result;
    } finally {
        globalThis.confirm = original;
    }
});

// ---------------------------------------------------------------------------
// Words and styling
// ---------------------------------------------------------------------------

const FORBIDDEN = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|note\s*#|#\s*\d|unlinkable|untraceable|anonymous|zero.knowledge|proof\b|escape hatch|mutual close|nothing is lost|\bsafe(ly)?\b/i;

function assertPlainWords(text, where) {
    assert.equal(FORBIDDEN.test(text), false, `${where}: ${text}`);
    assert.equal(/!/.test(text), false, `${where}: exclamation`);
    assert.equal(/'/.test(text), false, `${where}: straight apostrophe`);
    assert.equal(/\p{Extended_Pictographic}/u.test(text), false, `${where}: emoji`);
    assert.equal(/\s{2,}|\s[.,;:?]/.test(text), false, `${where}: spacing`);
}

test('vocabulary: calm plain words, curly apostrophes, no jargon, no unit words in the templates', async () => {
    const templates = { ...ABANDON_WORDS, ...Object.fromEntries(Object.entries(ABANDON_WORDS.refused).map(([key, text]) => [`refused.${key}`, text])) };
    delete templates.refused;
    for (const [key, text] of Object.entries(templates)) {
        assert.equal(typeof text, 'string', key);
        assertPlainWords(text, key);
        assert.equal(/\b[A-Z]{3,}\b/.test(text), false, `${key}: shouting or a unit word`);
        const filled = text.replace(/\{\?(\w+)\}([\s\S]*?)\{\/\1\}/g, '$2').replace(/\{(\w+)\}/g, '2');
        for (const sentence of filled.split(/(?<=[.?])\s+/)) {
            assert.match(sentence, /^(?:[A-Z0-9]|zkAPI)/, `${key}: "${sentence}"`);
        }
    }
    // Everything the dialog renders, in every state.
    const seen = [];
    for (const preview of [ZERO, DUST, { ...DUST, balanceUsdMicros: null, limitUsdMicros: null }, null]) {
        const { dialog, handle } = open({ preview });
        seen.push(`${dialog.textContent} ${control(dialog, 'confirm')?.textContent ?? ''}`);
        handle.close();
        await handle.result;
    }
    for (const why of ABANDON_BLOCKED_BY) seen.push(abandonRefusalWords(why));
    for (const text of seen) {
        const words = text.replace(/\s+/g, ' ').trim();
        assertPlainWords(words, 'rendered');
        // Units arrive as tokens built by the component ("0.00014 ETH").
        assert.equal(/\b[A-Z]{3,}\b/.test(words.replace(/\b[\d.]+ ETH\b/g, '')), false, `shouting: ${words}`);
    }
});

test('it says what is given up and what is not, and never promises the balance back or keeps it "safe"', () => {
    const { dialog, handle } = open({ preview: DUST });
    const words = dialog.textContent;
    assert.match(words, /Nothing moves on Ethereum\./);
    assert.match(words, /service’s payment contract until it expires/);
    assert.match(words, /can’t bring the balance back/);
    assert.equal(/nothing is lost|you will get it back|refund(ed)?\b/i.test(words), false);
    handle.close();
});

test('styling: every class the dialog uses is one the app ships', async () => {
    const css = ['chat/tailwind.generated.css', 'chat/zkapi/zkapi.css', 'chat/styles.css']
        .map(file => fs.readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
    const escape = name => name.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    const classes = new Set();
    const collect = dialog => {
        for (const match of dialog.outerHTML.matchAll(/class="([^"]*)"/g)) {
            match[1].split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
        }
    };
    for (const preview of [ZERO, DUST, null]) {
        // Before anything is pressed (the checkbox goes when the answer comes), then after the answer.
        const { dialog, handle } = open({ preview });
        collect(dialog);
        if (check(dialog)) tick(dialog);
        control(dialog, 'confirm')?.click();
        await settle();
        collect(dialog);
        handle.close();
        await handle.result;
    }
    // A refusal that leaves only "Close" restyles the cancel button.
    const refused = open({ preview: DUST, answer: { done: false, why: 'changed' } });
    tick(refused.dialog);
    control(refused.dialog, 'confirm').click();
    await settle();
    collect(refused.dialog);
    refused.handle.close();
    await refused.handle.result;
    assert.ok(classes.size >= 8);
    for (const name of classes) {
        assert.ok(css.includes(`.${name}`) || css.includes(`.${escape(name)}`), `class ${name} is not in the shipped stylesheets`);
    }
});
