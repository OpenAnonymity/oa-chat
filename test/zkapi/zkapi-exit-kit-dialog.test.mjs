import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    PASSPHRASE_ALPHABET, PASSPHRASE_BITS, PASSPHRASE_LENGTH, exitKitFileName, generateKitPassphrase,
    looksLikeExitKitEnvelope, sameRetype
} from '../../chat/zkapi/versioning/exitKit.mjs';
import { MiniEvent, createDocument, keyEvent } from './_miniDom.mjs';

const { EXIT_KIT_WORDS, openExitKitDialog } = await import('../../chat/zkapi/components/ExitKitDialog.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// An exit kit sealed by the REAL 0.2.0 SDK module (services/zkapiExitKit.mjs
// `sealExitKit`, PBKDF2 600000 iterations) over a synthetic payload with a
// throwaway passphrase: the exact envelope shape a person's browser produces,
// with no secret in it.
const REAL_ENVELOPE = '{"format":"zkapi-exit-kit-v1","kdf":{"name":"PBKDF2","hash":"SHA-256","iterations":600000,'
    + '"salt":"vUKxt2x70xzwmSNJ1ALPYQ=="},"cipher":{"name":"AES-256-GCM","iv":"+p8NzqNzsBFTamwD"},'
    + '"ciphertext":"U21leLs1D/1QFvelUBItpURd3EXycAzPcY0vXGm8BSDhClc3rmyL6DSKbfCy8wp2BqO2iZjZspbp3TkYEJ911gIaICsNU4Xb6/LSj1K8+FCFO0MgV83iU9rVZRO0CPKvUjcBkD8Yn9TTbUdtdYFZwmxR96ZBAR9lVFSimElOM2HefEkCNLlz3rZgSBvA3Tq7DwdAykohbFed3TPrQiCUVZZascCp0xdofRPFGa12esvyBGAEjJNIB4TlUGj9xpo/OPnYvELJSAC/6yKWGkJjZTVGvwzU2dAxbfSAs4n+GTf7tVAQARBHe5snULuHfYtTxgvJ29QXGjohi/nZrGpUuce/HmrvE9FL4KToOpHDHTDS4nD4u4ZSiGWQeGv/4ci0CvFcZJPNRUmCI+gVmQTbp4K9J1tIFYWQvM59n8mlt3pDTtZNAhbeMNIp+nDVZJItGHPXiO61t/k0wAHRrP8PtewAZFFwN0sa0G5SzeQ8lQeLQuIWMiOV7aeYZ/tByTqmoRLxtirQ4NTyIUllaLoDBfxA6+5ygiWdRFX+TGJ/TrSvynq0PjYPbIYEkBEtL7msH9rxMZsIp434nknUrJ98qoZyGtURzzV4Dei1idsDxOm+ytTHYKu8lM3IU9Q55ik9lGVG+XrN5vFtmCKLKY+WGZLdkh9efwLoDpOHF3bupOyeVaFFoJtMFzveLxEVR5UH7L5HPUQdYK6p+V/5BW3ET9vZAgrDnJYtHzMitQ=="}';

const PASSPHRASE_SHAPE = /^[A-HJ-NP-Z2-9]{5}(?:-[A-HJ-NP-Z2-9]{5}){3}$/;
const LOCAL_NOON = new Date(2026, 9, 12, 12, 0).getTime();
const FILE_NAME = 'oa-chat-exit-kit-2026-10-12.json';

// ---------------------------------------------------------------------------
// The pure policy
// ---------------------------------------------------------------------------

test('a generated passphrase has twenty unambiguous symbols in four groups and carries 100 bits', () => {
    assert.equal(PASSPHRASE_ALPHABET.length, 32);
    assert.equal(PASSPHRASE_LENGTH * Math.log2(PASSPHRASE_ALPHABET.length), PASSPHRASE_BITS);
    for (const confusable of 'IO01') assert.equal(PASSPHRASE_ALPHABET.includes(confusable), false, confusable);
    const random = array => globalThis.crypto.getRandomValues(array);
    const seen = new Set();
    const symbols = new Set();
    for (let draw = 0; draw < 2000; draw += 1) {
        const passphrase = generateKitPassphrase(random);
        assert.match(passphrase, PASSPHRASE_SHAPE);
        seen.add(passphrase);
        for (const symbol of passphrase.replaceAll('-', '')) symbols.add(symbol);
    }
    assert.equal(seen.size, 2000, 'no repeats in 2000 draws');
    assert.equal(symbols.size, 32, 'every symbol of the alphabet is used');
});

test('every byte value maps to a symbol evenly, so the passphrase is uniform', () => {
    // 256 is a multiple of 32: feeding every byte value once gives each symbol exactly eight.
    let next = 0;
    const counting = array => {
        for (let at = 0; at < array.length; at += 1) { array[at] = next; next = (next + 1) % 256; }
        return array;
    };
    const counts = new Map();
    for (let draw = 0; draw < 13; draw += 1) {
        const passphrase = generateKitPassphrase(counting).replaceAll('-', '');
        for (const symbol of passphrase) counts.set(symbol, (counts.get(symbol) || 0) + 1);
    }
    // 13 draws consume 260 bytes: 256 evenly, then 4 more.
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    assert.equal(total, 260);
    for (const symbol of PASSPHRASE_ALPHABET) {
        assert.ok(counts.get(symbol) >= 8 && counts.get(symbol) <= 9, `${symbol}: ${counts.get(symbol)}`);
    }
});

test('no secure random source, a throwing one or a constant one is refused, never worked around', () => {
    const refused = random => assert.throws(() => generateKitPassphrase(random), { code: 'exit_kit_unavailable' });
    refused(undefined);
    refused(null);
    refused('crypto');
    refused(() => { throw new TypeError('Illegal invocation'); });
    refused(array => array.fill(7));
    refused(array => array.fill(0));
    // Bytes that agree in their low five bits are one symbol, however they differ above.
    refused(array => { for (let at = 0; at < array.length; at += 1) array[at] = 32 * (at % 8) + 5; return array; });
    // A stand-in that hands back another array of the right size is read from that array.
    const other = Uint8Array.from({ length: 20 }, (value, at) => at * 3 + 1);
    const fromOther = generateKitPassphrase(() => other);
    assert.match(fromOther, PASSPHRASE_SHAPE);
    assert.equal(fromOther, generateKitPassphrase(array => { array.set(other); return array; }));
});

test('retyping ignores surrounding whitespace and nothing else', () => {
    const shown = 'ABCDE-FGHJK-LMNPQ-RSTUV';
    assert.equal(sameRetype(shown, shown), true);
    assert.equal(sameRetype(shown, `  ${shown}\n`), true);
    assert.equal(sameRetype(`${shown} `, shown), true);
    assert.equal(sameRetype(shown, shown.toLowerCase()), false, 'case matters');
    assert.equal(sameRetype(shown, shown.replaceAll('-', '')), false, 'the hyphens matter');
    assert.equal(sameRetype(shown, 'ABCDE FGHJK LMNPQ RSTUV'), false, 'inner whitespace is not a hyphen');
    assert.equal(sameRetype(shown, 'ABCDE-FGHJK-LMNPQ-RSTUW'), false);
    assert.equal(sameRetype(shown, ''), false);
    assert.equal(sameRetype('', ''), false, 'nothing shown is nothing to confirm');
    assert.equal(sameRetype(shown, undefined), false);
    assert.equal(sameRetype(null, shown), false);
    assert.equal(sameRetype(12345, 12345), false);
});

test('the file name is the local date and names no balance, version or person', () => {
    assert.equal(exitKitFileName(new Date(2026, 9, 12, 23, 59, 59)), FILE_NAME);
    assert.equal(exitKitFileName(new Date(2026, 0, 5, 0, 0, 1).getTime()), 'oa-chat-exit-kit-2026-01-05.json');
    assert.equal(exitKitFileName(new Date(2026, 11, 31, 12)), 'oa-chat-exit-kit-2026-12-31.json');
    assert.equal(exitKitFileName(new Date(Number.NaN)), 'oa-chat-exit-kit.json');
    assert.equal(exitKitFileName(undefined), 'oa-chat-exit-kit.json');
    assert.equal(exitKitFileName('2026-10-12'), 'oa-chat-exit-kit.json', 'a string is not a date');
    assert.match(exitKitFileName(LOCAL_NOON), /^oa-chat-exit-kit-\d{4}-\d{2}-\d{2}\.json$/);
});

test('the file name is the local date, whatever the time zone makes of the UTC date', () => {
    const original = process.env.TZ;
    try {
        // UTC+14: half past midnight here is still the evening before in UTC.
        process.env.TZ = 'Pacific/Kiritimati';
        assert.equal(exitKitFileName(new Date(2026, 9, 12, 0, 30)), FILE_NAME);
        assert.equal(new Date(2026, 9, 12, 0, 30).getUTCDate(), 11);
        // The year and the month turn over locally before they do in UTC.
        assert.equal(exitKitFileName(new Date(2027, 0, 1, 0, 30)), 'oa-chat-exit-kit-2027-01-01.json');
        assert.equal(new Date(2027, 0, 1, 0, 30).getUTCFullYear(), 2026);
        // UTC-11: half past eleven at night here is already the next day in UTC.
        process.env.TZ = 'Pacific/Pago_Pago';
        assert.equal(exitKitFileName(new Date(2026, 9, 12, 23, 30)), FILE_NAME);
        assert.equal(new Date(2026, 9, 12, 23, 30).getUTCDate(), 13);
    } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
    }
});

test('only the exact sealed envelope of a kit is a file worth offering', () => {
    assert.equal(looksLikeExitKitEnvelope(REAL_ENVELOPE), true, 'the real sealed kit');
    const envelope = () => JSON.parse(REAL_ENVELOPE);
    const refuses = (mutate, why) => {
        const kit = envelope();
        mutate(kit);
        assert.equal(looksLikeExitKitEnvelope(JSON.stringify(kit)), false, why);
    };
    refuses(kit => { kit.format = 'zkapi-exit-kit-v2'; }, 'another format');
    refuses(kit => { kit.kdf.iterations = 99_999; }, 'iterations below what the SDK opens');
    refuses(kit => { kit.kdf.iterations = '600000'; }, 'iterations as text');
    refuses(kit => { kit.kdf.name = 'scrypt'; }, 'another kdf');
    refuses(kit => { kit.kdf.hash = 'SHA-1'; }, 'another hash');
    refuses(kit => { kit.cipher.name = 'AES-128-CBC'; }, 'another cipher');
    refuses(kit => { kit.ciphertext = ''; }, 'no ciphertext');
    refuses(kit => { kit.ciphertext = 'not base64!'; }, 'ciphertext that is not base64');
    refuses(kit => { kit.kdf.salt = 5; }, 'salt that is not text');
    refuses(kit => { kit.note = { secret_s: 'SECRET' }; }, 'an extra top-level key');
    refuses(kit => { kit.kdf.extra = 1; }, 'an extra kdf key');
    refuses(kit => { kit.cipher.tag = 'x'; }, 'an extra cipher key');
    refuses(kit => { delete kit.cipher; }, 'a missing section');
    refuses(kit => { kit.ciphertext = 'A'.repeat(300_000); }, 'a size no kit has');
    // What must never be offered as a kit.
    const plaintext = JSON.stringify({ format: 'zkapi-exit-kit-v1', note: { secret_s: 'SECRET' }, bound_at_state: '0' });
    assert.equal(looksLikeExitKitEnvelope(plaintext), false, 'the unsealed payload');
    assert.equal(looksLikeExitKitEnvelope('There is no private balance to export.'), false);
    for (const value of ['', '{}', '[]', 'null', '"text"', '{', undefined, null, 5, {}, [], 'x'.repeat(300_000)]) {
        assert.equal(looksLikeExitKitEnvelope(value), false, String(value).slice(0, 20));
    }
});

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

// A page with an observable URL API, Blob, timers and random source.
function page(overrides = {}) {
    const doc = createDocument();
    const anchors = [];
    const createElement = doc.createElement.bind(doc);
    const calls = { exported: [], urls: [], revoked: [], timers: [], cleared: [], linkParents: [] };
    doc.createElement = tag => {
        const element = createElement(tag);
        if (tag === 'a') {
            anchors.push(element);
            // Where the link sits when it is followed.
            const follow = element.click.bind(element);
            element.click = () => {
                calls.linkParents.push(element.parentNode ? element.parentNode.tagName : null);
                follow();
            };
        }
        return element;
    };
    const exportKit = overrides.exportKit || (async passphrase => {
        calls.exported.push(passphrase);
        return overrides.kit || REAL_ENVELOPE;
    });
    let seed = overrides.seed ?? 1;
    const getRandomValues = overrides.getRandomValues || (array => {
        for (let at = 0; at < array.length; at += 1) array[at] = (seed * 37 + at * 11 + (at % 3) * 5) % 256;
        seed += 1;
        return array;
    });
    class FakeBlob {
        constructor(parts, init) {
            this.parts = parts;
            this.type = init?.type;
        }
    }
    const urlApi = overrides.urlApi || {
        createObjectURL(blob) {
            calls.urls.push(blob);
            return `blob:kit-${calls.urls.length}`;
        },
        revokeObjectURL(url) { calls.revoked.push(url); }
    };
    const options = {
        doc, exportKit, getRandomValues, now: overrides.now ?? LOCAL_NOON, urlApi, BlobImpl: FakeBlob,
        setTimer: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
        clearTimer: handle => { calls.cleared.push(handle); }
    };
    return { doc, calls, anchors, options, FakeBlob };
}

const dialogOf = doc => doc.body.querySelector('[data-zkapi-exit-kit-dialog]');
const find = (dialog, selector) => dialog.querySelector(selector);
const action = (dialog, name) => dialog.querySelector(`[data-zkapi-kit-action="${name}"]`);
const stepOf = dialog => dialog.querySelector('[data-zkapi-kit-step]')?.getAttribute('data-zkapi-kit-step') ?? null;
const passphraseOf = dialog => find(dialog, '[data-zkapi-kit-passphrase]').textContent;
const settle = () => new Promise(resolve => setImmediate(resolve));

function typeInto(dialog, value) {
    const input = find(dialog, '[data-zkapi-kit-retype]');
    input.value = value;
    input.dispatchEvent(new MiniEvent('input'));
}

// Open, retype the passphrase correctly and press "Create exit kit".
async function createdKit(overrides = {}) {
    const harness = page(overrides);
    const handle = openExitKitDialog(harness.options);
    const dialog = dialogOf(harness.doc);
    typeInto(dialog, passphraseOf(dialog));
    action(dialog, 'create').click();
    await settle();
    return { ...harness, handle, dialog };
}

test('wiring:exit-kit opening the dialog shows a generated passphrase and asks for it again before creating anything', async () => {
    const { doc, options, calls } = page();
    const handle = openExitKitDialog(options);
    const dialog = dialogOf(doc);
    assert.ok(dialog, 'a dialog was placed in the page');
    assert.equal(dialog.tagName, 'dialog');
    assert.equal(dialog.showModalCalls, 1, 'modal, so the page behind it is inert');
    assert.equal(stepOf(dialog), 'create');
    const passphrase = passphraseOf(dialog);
    assert.match(passphrase, PASSPHRASE_SHAPE);
    assert.equal(calls.exported.length, 0, 'opening creates nothing');

    // The button is off until the passphrase is typed back, exactly.
    const create = action(dialog, 'create');
    assert.equal(create.disabled, true);
    typeInto(dialog, passphrase.slice(0, -1));
    assert.equal(create.disabled, true);
    typeInto(dialog, passphrase.toLowerCase());
    assert.equal(create.disabled, true, 'case matters');
    typeInto(dialog, ` ${passphrase} `);
    assert.equal(create.disabled, false, 'whitespace does not');
    typeInto(dialog, passphrase.replace(/.$/, character => (character === 'A' ? 'B' : 'A')));
    assert.equal(create.disabled, true);

    // A submit that arrives while the field does not match does nothing.
    find(dialog, 'form').dispatchEvent(new MiniEvent('submit'));
    await settle();
    assert.equal(calls.exported.length, 0);
    handle.close();
    assert.deepEqual(await handle.result, { saved: false, created: false });
});

test('wiring:exit-kit the kit is created once with the shown passphrase and nothing is downloaded in that step', async () => {
    const { dialog, calls, anchors, handle } = await createdKit();
    assert.equal(calls.exported.length, 1);
    assert.match(calls.exported[0], PASSPHRASE_SHAPE);
    assert.equal(stepOf(dialog), 'save', 'the second step is a Save button');
    assert.equal(calls.urls.length, 0, 'no object URL yet');
    assert.equal(anchors.length, 0, 'no download link yet');
    assert.ok(action(dialog, 'save'));
    assert.equal(find(dialog, '[data-zkapi-kit-passphrase]'), null, 'the passphrase is gone from the page');
    assert.doesNotMatch(dialog.outerHTML, new RegExp(calls.exported[0]));
    assert.equal(dialog.outerHTML.includes('ciphertext'), false, 'the kit is not rendered');
    assert.equal(dialog.querySelector('[data-zkapi-kit-error]').textContent, '');
    handle.close();
});

test('wiring:exit-kit "Save file" starts the download synchronously inside the click and says only that it started', async () => {
    const { dialog, calls, anchors, doc, handle } = await createdKit();
    const save = action(dialog, 'save');
    assert.equal(calls.urls.length, 0);

    save.click();
    // Not after an await: by the time click() returned, the download started.
    assert.equal(calls.urls.length, 1, 'the object URL was made inside the click');
    assert.equal(anchors.length, 1);
    const [anchor] = anchors;
    assert.equal(anchor.clickCalls, 1, 'and its link was followed inside the click');
    assert.equal(anchor.download, FILE_NAME);
    assert.equal(anchor.href, 'blob:kit-1');
    assert.equal(anchor.isConnected, false, 'the link was removed again');
    // While a modal dialog is open the rest of the page is inert: the link is followed from inside it.
    assert.deepEqual(calls.linkParents, ['dialog']);
    assert.deepEqual(calls.urls[0].parts, [REAL_ENVELOPE], 'the file is exactly what the SDK produced');
    assert.equal(calls.urls[0].type, 'application/json');
    assert.equal(doc.body.querySelectorAll('a').length, 0);

    // The object URL outlives the click and is revoked afterwards.
    assert.deepEqual(calls.revoked, []);
    assert.equal(calls.timers.length, 1);
    assert.ok(calls.timers[0].ms >= 1000, `revoked after ${calls.timers[0].ms} ms`);
    calls.timers[0].fn();
    assert.deepEqual(calls.revoked, ['blob:kit-1']);

    // What the person is told: a download started. A page can not know that a file exists (the browser
    // may have asked where to put it and been cancelled), so nothing here says "saved".
    assert.equal(stepOf(dialog), 'started');
    assert.equal(find(dialog, '#zkapi-kit-title').textContent, 'Download started');
    const status = dialog.querySelector('[data-zkapi-kit-status]');
    assert.equal(status.textContent,
        `The download of ${FILE_NAME} has started. Check your downloads folder. If it isn’t there, save it again.`);
    assert.equal(status.getAttribute('role'), 'status', 'announced when the step opens');
    assert.equal(dialog.getAttribute('aria-describedby'), status.id, 'and what the dialog is described by');
    assert.doesNotMatch(dialog.textContent, /\bsaved\b/i);
    assert.equal(action(dialog, 'save'), null, 'the first button is replaced');
    assert.equal(action(dialog, 'again').textContent, 'Save again');
    // The passphrase and the kit are never rendered.
    assert.equal(dialog.textContent.includes(calls.exported[0]), false);
    assert.doesNotMatch(dialog.outerHTML, /ciphertext|zkapi-exit-kit-v1/);

    action(dialog, 'done').click();
    assert.deepEqual(await handle.result, { saved: true, created: true });
    assert.equal(doc.body.querySelector('[data-zkapi-exit-kit-dialog]'), null);
});

test('wiring:exit-kit "Save again" starts the same download again inside its own click, from the same kit', async () => {
    // A browser can ask where to save a file and be cancelled; the person must not have to make a new kit
    // (and keep a second passphrase) for that.
    const { dialog, calls, anchors, handle } = await createdKit();
    action(dialog, 'save').click();
    assert.equal(calls.urls.length, 1);
    action(dialog, 'again').click();
    assert.equal(calls.urls.length, 2, 'the second object URL was made inside the second click');
    assert.deepEqual(calls.urls[1].parts, [REAL_ENVELOPE], 'the same file');
    assert.equal(anchors.length, 2);
    assert.equal(anchors[1].clickCalls, 1);
    assert.equal(anchors[1].download, FILE_NAME);
    assert.deepEqual(calls.linkParents, ['dialog', 'dialog']);
    assert.equal(stepOf(dialog), 'started', 'still on the same step, not a new one');
    assert.equal(find(dialog, '[data-zkapi-kit-status]').textContent,
        `The download of ${FILE_NAME} has started again. Check your downloads folder.`);
    assert.equal(calls.exported.length, 1, 'no second kit was made');
    // Each object URL is revoked in its time.
    assert.equal(calls.timers.length, 2);
    calls.timers.forEach(timer => timer.fn());
    assert.deepEqual(calls.revoked, ['blob:kit-1', 'blob:kit-2']);

    // The kit is held only while the dialog is open.
    action(dialog, 'done').click();
    assert.deepEqual(await handle.result, { saved: true, created: true });
    assert.equal(calls.urls.length, 2);
});

test('a second download that can not start says so and does not undo the first', async () => {
    let calls = 0;
    const harness = await createdKit({
        urlApi: {
            createObjectURL() {
                calls += 1;
                if (calls > 1) throw new Error('blocked');
                return 'blob:first';
            },
            revokeObjectURL() {}
        }
    });
    const { dialog, handle } = harness;
    action(dialog, 'save').click();
    assert.equal(stepOf(dialog), 'started');
    action(dialog, 'again').click();
    assert.equal(find(dialog, '[data-zkapi-kit-error]').textContent, EXIT_KIT_WORDS.saveFailed);
    assert.equal(stepOf(dialog), 'started');
    // The first one started, and that is what is reported.
    action(dialog, 'done').click();
    assert.deepEqual(await handle.result, { saved: true, created: true });
});

test('wiring:exit-kit closing without saving says the kit was created and not saved, and downloads nothing', async () => {
    const { dialog, calls, anchors, handle } = await createdKit();
    assert.equal(stepOf(dialog), 'save');
    action(dialog, 'close').click();
    assert.deepEqual(await handle.result, { saved: false, created: true });
    assert.equal(calls.urls.length, 0);
    assert.equal(anchors.length, 0);
});

test('wiring:exit-kit cancelling before anything was created creates nothing and reports nothing created', async () => {
    const { doc, options, calls } = page();
    const handle = openExitKitDialog(options);
    action(dialogOf(doc), 'cancel').click();
    assert.deepEqual(await handle.result, { saved: false, created: false });
    assert.equal(calls.exported.length, 0);
    assert.equal(dialogOf(doc), null);
    assert.equal(doc.body.children.length, 0);
});

test('Escape closes the dialog and is not passed on to the balance dialog under it', async () => {
    const { doc, options } = page();
    const handle = openExitKitDialog(options);
    const dialog = dialogOf(doc);
    const reached = [];
    doc.body.addEventListener('keydown', event => reached.push(event.key));
    dialog.dispatchEvent(keyEvent('keydown', 'Escape'));
    assert.deepEqual(reached, [], 'the key stops at the dialog');
    dialog.dispatchEvent(keyEvent('keydown', 'a'));
    assert.deepEqual(reached, ['a'], 'other keys pass');
    const cancel = new MiniEvent('cancel');
    dialog.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true, 'the native close is replaced by ours');
    assert.deepEqual(await handle.result, { saved: false, created: false });
    assert.equal(dialogOf(doc), null);
});

test('a failed export is said in plain words, never in the SDK’s, and the dialog can be used again', async () => {
    const outcomes = [
        [Object.assign(new Error('The wallet has no WebCrypto: SECRET-DETAIL'), { code: 'exit_kit_unavailable' }), EXIT_KIT_WORDS.unavailable],
        [new Error('There is no private balance to export.'), EXIT_KIT_WORDS.noBalance],
        [Object.assign(new Error('BrowserWalletHttpError 500 https://operator.example/SECRET-DETAIL'), { code: 'weird' }), EXIT_KIT_WORDS.failed],
        ['a string', EXIT_KIT_WORDS.failed]
    ];
    for (const [error, expected] of outcomes) {
        let attempts = 0;
        const harness = page({
            exportKit: async passphrase => {
                attempts += 1;
                if (attempts === 1) throw error;
                harness.calls.exported.push(passphrase);
                return REAL_ENVELOPE;
            }
        });
        const handle = openExitKitDialog(harness.options);
        const dialog = dialogOf(harness.doc);
        const passphrase = passphraseOf(dialog);
        typeInto(dialog, passphrase);
        action(dialog, 'create').click();
        await settle();
        const alert = find(dialog, '[data-zkapi-kit-error]');
        assert.equal(alert.textContent, expected);
        assert.equal(alert.getAttribute('role'), 'alert');
        assert.equal(dialog.textContent.includes('SECRET-DETAIL'), false, 'the SDK text is never shown');
        assert.equal(stepOf(dialog), 'create', 'still on the first step');
        assert.equal(action(dialog, 'create').disabled, false, 'the same passphrase can be tried again');
        assert.equal(find(dialog, '[data-zkapi-kit-retype]').disabled, false);
        assert.equal(passphraseOf(dialog), passphrase, 'the passphrase on screen is the one that is retried');

        action(dialog, 'create').click();
        await settle();
        assert.equal(stepOf(dialog), 'save', 'the second attempt works');
        assert.equal(harness.calls.exported.length, 1);
        handle.close();
        assert.deepEqual(await handle.result, { saved: false, created: true });
    }
});

test('a result that is not the sealed envelope is never offered for download', async () => {
    const plaintext = JSON.stringify({ format: 'zkapi-exit-kit-v1', note: { secret_s: 'SECRET-PLAINTEXT' }, bound_at_state: '0' });
    for (const bad of [plaintext, 'There is no private balance to export.', '', null, 42]) {
        const { dialog, calls, anchors, handle } = await createdKit({ exportKit: async () => bad });
        assert.equal(find(dialog, '[data-zkapi-kit-error]').textContent, EXIT_KIT_WORDS.unrecognized);
        assert.equal(stepOf(dialog), 'create');
        assert.equal(action(dialog, 'save'), null);
        assert.equal(calls.urls.length, 0);
        assert.equal(anchors.length, 0);
        assert.equal(dialog.outerHTML.includes('SECRET-PLAINTEXT'), false, 'the payload is not shown');
        handle.close();
        // The SDK counts a kit as created whatever the host does with it.
        assert.deepEqual(await handle.result, { saved: false, created: true });
    }
});

test('a download that cannot start keeps the kit so Save can be pressed again', async () => {
    let fail = true;
    const harness = await createdKit({
        urlApi: {
            createObjectURL(blob) {
                if (fail) throw new Error('blocked');
                return 'blob:retry';
            },
            revokeObjectURL() {}
        }
    });
    const { dialog, handle, anchors } = harness;
    action(dialog, 'save').click();
    assert.equal(find(dialog, '[data-zkapi-kit-error]').textContent, EXIT_KIT_WORDS.saveFailed);
    assert.equal(stepOf(dialog), 'save');
    assert.equal(anchors.length, 0);
    fail = false;
    action(dialog, 'save').click();
    assert.equal(stepOf(dialog), 'started');
    assert.equal(anchors[0].href, 'blob:retry');
    action(dialog, 'done').click();
    assert.deepEqual(await handle.result, { saved: true, created: true });

    // A download that never starts is never reported as saved: closing after it says "created, not saved".
    const blocked = await createdKit({
        urlApi: { createObjectURL() { throw new Error('blocked'); }, revokeObjectURL() {} }
    });
    action(blocked.dialog, 'save').click();
    assert.equal(find(blocked.dialog, '[data-zkapi-kit-error]').textContent, EXIT_KIT_WORDS.saveFailed);
    action(blocked.dialog, 'close').click();
    assert.deepEqual(await blocked.handle.result, { saved: false, created: true });
});

test('wiring:exit-kit the passphrase and the kit reach no storage, log, address or markup', async () => {
    const written = [];
    const sink = name => (...args) => { written.push([name, ...args.map(arg => String(arg))]); };
    const saved = {};
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
        saved[level] = console[level];
        console[level] = sink(level);
    }
    const storage = { getItem: () => null, setItem: sink('setItem'), removeItem: sink('removeItem'), clear: sink('clear') };
    const priorLocal = globalThis.localStorage;
    const priorSession = globalThis.sessionStorage;
    globalThis.localStorage = storage;
    globalThis.sessionStorage = storage;
    const priorIndexedDb = globalThis.indexedDB;
    globalThis.indexedDB = { open: sink('indexedDB.open') };
    const priorFetch = globalThis.fetch;
    globalThis.fetch = sink('fetch');
    let passphrase;
    try {
        const { dialog, doc, handle, calls } = await createdKit();
        passphrase = calls.exported[0];
        action(dialog, 'save').click();
        action(dialog, 'done').click();
        await handle.result;
        assert.equal(doc.documentElement.outerHTML.includes(passphrase), false);
        assert.equal(doc.documentElement.outerHTML.includes('zkapi-exit-kit-v1'), false);
    } finally {
        Object.assign(console, saved);
        globalThis.localStorage = priorLocal;
        globalThis.sessionStorage = priorSession;
        globalThis.indexedDB = priorIndexedDb;
        globalThis.fetch = priorFetch;
    }
    assert.match(passphrase, PASSPHRASE_SHAPE);
    assert.deepEqual(written, [], 'nothing was written anywhere');
});

// The comments of a source file removed, so a scan reads only what runs.
function codeOf(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the passphrase never reaches a clipboard: no button, no clipboard API, no copy command, no seam', async () => {
    // Clipboard managers, synced clipboards and clipboard history keep what is
    // written there, so the passphrase is shown as selectable text and nothing
    // more. Every way a page could write one is trapped.
    const touched = [];
    const trap = name => () => {
        touched.push(name);
        return Promise.reject(new Error(`${name} must not be used`));
    };
    const clipboard = { writeText: trap('writeText'), write: trap('write'), readText: trap('readText'), read: trap('read') };
    const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true, writable: true });
    try {
        const harness = page();
        harness.doc.execCommand = trap('execCommand');
        // A caller written for a page that had the old seam is simply ignored.
        const handle = openExitKitDialog({ ...harness.options, writeClipboard: trap('writeClipboard seam') });
        const dialog = dialogOf(harness.doc);

        assert.equal(action(dialog, 'copy'), null, 'no copy action');
        assert.equal(dialog.querySelectorAll('[data-zkapi-kit-action]').length, 2, 'cancel and create are all there is');
        for (const button of dialog.querySelectorAll('button')) {
            const name = `${button.textContent} ${button.getAttribute('aria-label') ?? ''}`;
            assert.doesNotMatch(name, /copy|clipboard/i, name);
        }
        assert.doesNotMatch(dialog.textContent, /clipboard|\bcopy\b|\bcopied\b/i, 'no sentence offers or asks for one');
        // The passphrase is plain text in the page, the thing a person selects and writes down.
        const shown = find(dialog, '[data-zkapi-kit-passphrase]');
        assert.equal(shown.tagName, 'code');
        assert.match(shown.textContent, PASSPHRASE_SHAPE);

        typeInto(dialog, passphraseOf(dialog));
        action(dialog, 'create').click();
        await settle();
        assert.equal(stepOf(dialog), 'save');
        action(dialog, 'save').click();
        action(dialog, 'again').click();
        action(dialog, 'done').click();
        assert.deepEqual(await handle.result, { saved: true, created: true });
    } finally {
        if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator);
        else delete globalThis.navigator;
    }
    assert.deepEqual(touched, [], 'nothing was written to or read from a clipboard');

    // And the module does not so much as name one of the ways to do it.
    const source = fs.readFileSync(path.join(repoRoot, 'chat/zkapi/components/ExitKitDialog.js'), 'utf8');
    assert.doesNotMatch(codeOf(source), /clipboard|execCommand|writeText|ClipboardItem/i);
    assert.equal(Object.keys(EXIT_KIT_WORDS).some(key => /copy|copied|clipboard/i.test(key)), false);
});

test('each opening makes its own passphrase from the random source, and never from Math.random', async () => {
    const original = Math.random;
    Math.random = () => { throw new Error('Math.random must not make a passphrase'); };
    try {
        const first = page({ seed: 1 });
        const a = openExitKitDialog(first.options);
        const one = passphraseOf(dialogOf(first.doc));
        a.close();
        await a.result;
        const second = page({ seed: 2 });
        const b = openExitKitDialog(second.options);
        const two = passphraseOf(dialogOf(second.doc));
        b.close();
        await b.result;
        assert.match(one, PASSPHRASE_SHAPE);
        assert.match(two, PASSPHRASE_SHAPE);
        assert.notEqual(one, two);
        // The same random source gives the same passphrase: it is the source's.
        const again = page({ seed: 1 });
        const c = openExitKitDialog(again.options);
        assert.equal(passphraseOf(dialogOf(again.doc)), one);
        c.close();
        await c.result;
    } finally {
        Math.random = original;
    }
});

test('a page without a secure random source opens an explanation and no passphrase', async () => {
    const { doc, options, calls } = page({ getRandomValues: () => { throw new TypeError('no crypto'); } });
    const handle = openExitKitDialog(options);
    const dialog = dialogOf(doc);
    assert.equal(stepOf(dialog), 'unavailable');
    assert.equal(find(dialog, '[data-zkapi-kit-passphrase]'), null);
    assert.equal(find(dialog, '[data-zkapi-kit-retype]'), null);
    assert.ok(dialog.textContent.includes(EXIT_KIT_WORDS.unavailable));
    action(dialog, 'close').click();
    assert.deepEqual(await handle.result, { saved: false, created: false });
    assert.equal(calls.exported.length, 0);

    // The same for a caller that has no way to make a kit.
    const bare = page();
    const noExport = openExitKitDialog({ ...bare.options, exportKit: undefined });
    assert.equal(stepOf(dialogOf(bare.doc)), 'unavailable');
    noExport.close();
    assert.deepEqual(await noExport.result, { saved: false, created: false });
});

test('closing while the SDK is still working waits for its answer and reports a kit that was made', async () => {
    let finish;
    let fail;
    const slow = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const open = async () => {
        const harness = page({ exportKit: async () => slow() });
        const handle = openExitKitDialog(harness.options);
        const dialog = dialogOf(harness.doc);
        typeInto(dialog, passphraseOf(dialog));
        action(dialog, 'create').click();
        await settle();
        // The work is in flight: controls are off, and it is said.
        assert.equal(action(dialog, 'create').disabled, true);
        assert.equal(find(dialog, '[data-zkapi-kit-retype]').disabled, true);
        assert.equal(dialog.getAttribute('aria-busy'), 'true');
        assert.equal(find(dialog, '[data-zkapi-kit-status]').textContent, EXIT_KIT_WORDS.creating);
        return { ...harness, handle, dialog };
    };

    // It finishes after the window was closed: made, never offered.
    let session = await open();
    let reported = null;
    session.handle.result.then(value => { reported = value; });
    session.handle.close();
    assert.equal(dialogOf(session.doc), null, 'the window is gone at once');
    await settle();
    assert.equal(reported, null, 'the answer is awaited');
    finish(REAL_ENVELOPE);
    assert.deepEqual(await session.handle.result, { saved: false, created: true });
    assert.equal(session.calls.urls.length, 0, 'a kit that arrives late is not downloaded');

    // It fails after the window was closed: nothing was made.
    session = await open();
    session.handle.close();
    fail(new Error('lock busy'));
    assert.deepEqual(await session.handle.result, { saved: false, created: false });

    // It never answers: the safe side after a bounded wait.
    session = await open();
    session.handle.close();
    assert.equal(session.calls.timers.length, 1);
    session.calls.timers[0].fn();
    assert.deepEqual(await session.handle.result, { saved: false, created: true });
});

test('a second request while the dialog is open returns the same dialog, not another', async () => {
    const { doc, options } = page();
    const first = openExitKitDialog(options);
    const second = openExitKitDialog(options);
    assert.equal(second, first);
    assert.equal(doc.body.querySelectorAll('[data-zkapi-exit-kit-dialog]').length, 1);
    first.close();
    await first.result;
    assert.equal(doc.body.querySelectorAll('[data-zkapi-exit-kit-dialog]').length, 0);
    const again = openExitKitDialog(options);
    assert.notEqual(again, first);
    again.close();
    await again.result;
});

test('focus: the heading on every step, and back to where it was when the dialog closes', async () => {
    const harness = page();
    const opener = harness.doc.createElement('button');
    harness.doc.body.append(opener);
    opener.focus();
    const handle = openExitKitDialog(harness.options);
    const dialog = dialogOf(harness.doc);
    const heading = () => find(dialog, '#zkapi-kit-title');
    assert.equal(harness.doc.activeElement, heading());
    assert.equal(heading().getAttribute('tabindex'), '-1');
    typeInto(dialog, passphraseOf(dialog));
    action(dialog, 'create').click();
    await settle();
    assert.equal(harness.doc.activeElement, heading(), 'the next step starts at its heading');
    action(dialog, 'save').click();
    assert.equal(harness.doc.activeElement, action(dialog, 'done'), 'then at what comes next');
    action(dialog, 'done').click();
    await handle.result;
    assert.equal(harness.doc.activeElement, opener);
});

test('the dialog is labelled, its fields are kept from autofill, and its status regions are live', () => {
    const { doc, options } = page();
    const handle = openExitKitDialog(options);
    const dialog = dialogOf(doc);
    const labelled = find(dialog, `#${dialog.getAttribute('aria-labelledby')}`);
    assert.ok(labelled && labelled.tagName === 'h2');
    const described = find(dialog, `#${dialog.getAttribute('aria-describedby')}`);
    assert.ok(described);
    const input = find(dialog, '[data-zkapi-kit-retype]');
    assert.equal(input.getAttribute('type'), 'text', 'not a password field the browser would offer to save');
    assert.equal(input.getAttribute('autocomplete'), 'off');
    assert.equal(input.getAttribute('spellcheck'), 'false');
    assert.equal(input.getAttribute('autocorrect'), 'off');
    assert.equal(input.getAttribute('autocapitalize'), 'characters');
    assert.equal(input.getAttribute('data-lpignore'), 'true');
    assert.equal(input.getAttribute('data-1p-ignore'), 'true');
    assert.equal(find(dialog, 'form').getAttribute('autocomplete'), 'off');
    assert.equal(find(dialog, `label[for="${input.id}"]`).textContent, EXIT_KIT_WORDS.retypeLabel);
    assert.ok(find(dialog, `#${input.getAttribute('aria-describedby')}`), 'the hint the field points at exists');
    assert.equal(find(dialog, '[data-zkapi-kit-status]').getAttribute('role'), 'status');
    assert.equal(find(dialog, '[data-zkapi-kit-error]').getAttribute('role'), 'alert');

    // The passphrase is heard with its label and its hint.
    const group = find(dialog, '[role="group"]');
    assert.ok(group, 'the passphrase is a labelled group');
    assert.ok(group.contains(find(dialog, '[data-zkapi-kit-passphrase]')));
    assert.equal(find(dialog, `#${group.getAttribute('aria-labelledby')}`).textContent, EXIT_KIT_WORDS.passphraseLabel);
    assert.equal(find(dialog, `#${group.getAttribute('aria-describedby')}`).textContent, EXIT_KIT_WORDS.passphraseHint);
    handle.close();
});

test('a mismatch is named only once the whole passphrase was typed', () => {
    const { doc, options } = page();
    const handle = openExitKitDialog(options);
    const dialog = dialogOf(doc);
    const passphrase = passphraseOf(dialog);
    const error = () => find(dialog, '[data-zkapi-kit-error]').textContent;
    typeInto(dialog, passphrase.slice(0, 6));
    assert.equal(error(), '', 'not while the person is still typing');
    typeInto(dialog, `${passphrase.slice(0, -1)}${passphrase.at(-1) === 'A' ? 'B' : 'A'}`);
    assert.equal(error(), EXIT_KIT_WORDS.mismatch);
    typeInto(dialog, passphrase);
    assert.equal(error(), '');
    handle.close();
});

// ---------------------------------------------------------------------------
// Words and styling
// ---------------------------------------------------------------------------

const FORBIDDEN = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|note\s*#|#\s*\d|unlinkable|untraceable|anonymous|zero.knowledge|proof\b|escape hatch|mutual close|nothing is lost|backup|restore/i;

function assertPlainWords(text, where) {
    assert.equal(FORBIDDEN.test(text), false, `${where}: ${text}`);
    assert.equal(/!/.test(text), false, `${where}: exclamation`);
    assert.equal(/'/.test(text), false, `${where}: straight apostrophe`);
    assert.equal(/\p{Extended_Pictographic}/u.test(text), false, `${where}: emoji`);
    assert.equal(/\s{2,}|\s[.,;:?]/.test(text), false, `${where}: spacing`);
}

test('vocabulary: calm plain words, curly apostrophes, no jargon, no unit words', async () => {
    for (const [key, text] of Object.entries(EXIT_KIT_WORDS)) {
        assert.equal(typeof text, 'string', key);
        assertPlainWords(text, key);
        assert.equal(/\b[A-Z]{3,}\b/.test(text), false, `${key}: shouting or a unit word`);
        for (const sentence of text.replace(/\{file\}/g, 'oa-chat.json').split(/(?<=[.?])\s+/)) {
            assert.match(sentence, /^(?:[A-Z0-9]|zkAPI)/, `${key}: "${sentence}"`);
        }
    }
    // And of what each step actually renders, passphrase aside.
    const steps = [];
    const first = page();
    const handle = openExitKitDialog(first.options);
    const dialog = dialogOf(first.doc);
    const shown = passphraseOf(dialog);
    steps.push(dialog.textContent.replace(shown, ''));
    typeInto(dialog, shown);
    action(dialog, 'create').click();
    await settle();
    steps.push(dialog.textContent);
    action(dialog, 'save').click();
    steps.push(dialog.textContent);
    handle.close();
    await handle.result;
    const failing = page({ exportKit: async () => { throw new Error('x'); } });
    const other = openExitKitDialog(failing.options);
    const otherDialog = dialogOf(failing.doc);
    typeInto(otherDialog, passphraseOf(otherDialog));
    action(otherDialog, 'create').click();
    await settle();
    steps.push(otherDialog.textContent.replace(passphraseOf(otherDialog), ''));
    other.close();
    await other.result;
    assert.equal(steps.length, 4);
    for (const text of steps) {
        const words = text.replace(/\s+/g, ' ').trim();
        assertPlainWords(words, 'rendered');
        assert.equal(/\b[A-Z]{3,}\b/.test(words), false, `shouting: ${words}`);
    }
});

test('the dialog tells the person what the file can do and what this app can not', () => {
    assert.match(EXIT_KIT_WORDS.warning, /whole balance to any address/);
    assert.match(EXIT_KIT_WORDS.warning, /offline/);
    assert.match(EXIT_KIT_WORDS.intro, /zkAPI companion tool/);
    assert.match(EXIT_KIT_WORDS.intro, /can’t open the file/);
    assert.match(EXIT_KIT_WORDS.passphraseHint, /shown once/);
    assert.match(EXIT_KIT_WORDS.saveIntro, /not saved yet/);
    assert.match(EXIT_KIT_WORDS.startedKeep, /can’t show it again/);
    // After the click only "started" is true: no title or sentence says the file is saved.
    for (const key of ['startedTitle', 'started', 'startedAgain', 'startedKeep']) {
        assert.doesNotMatch(EXIT_KIT_WORDS[key], /\bsaved\b/i, key);
    }
    assert.match(EXIT_KIT_WORDS.started, /save it again/);
    // Never a promise of an in-app restore, and never "safe".
    for (const text of Object.values(EXIT_KIT_WORDS)) assert.equal(/\bsafe(ly)?\b|import|restore/i.test(text), false, text);
});

test('styling: every class the dialog uses is one the app ships', async () => {
    const css = ['chat/tailwind.generated.css', 'chat/zkapi/zkapi.css', 'chat/styles.css']
        .map(file => fs.readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
    const escape = name => name.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    const { doc, options } = page();
    const handle = openExitKitDialog(options);
    const dialog = dialogOf(doc);
    const markup = [dialog.outerHTML];
    typeInto(dialog, passphraseOf(dialog));
    action(dialog, 'create').click();
    await settle();
    markup.push(dialog.outerHTML);
    action(dialog, 'save').click();
    markup.push(dialog.outerHTML);
    handle.close();
    await handle.result;
    const classes = new Set();
    for (const html of markup) {
        for (const match of html.matchAll(/class="([^"]*)"/g)) match[1].split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
    }
    assert.ok(classes.size >= 10);
    for (const name of classes) {
        assert.ok(css.includes(`.${name}`) || css.includes(`.${escape(name)}`), `class ${name} is not in the shipped stylesheets`);
    }
});
