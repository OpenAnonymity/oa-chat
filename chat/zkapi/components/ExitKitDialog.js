// "Create an exit kit": a standalone modal dialog that makes the encrypted
// file and hands it to the person (docs/ZKAPI_VERSIONING.md, section 7,
// "Upgrade UX").
//
// An exit kit can move the whole balance to any address, so the dialog is
// built around what must not go wrong:
//
//   - the passphrase is GENERATED (versioning/exitKit.mjs), shown once, and
//     the person retypes it before anything is created. There is no
//     person-chosen passphrase, so there is no weak one
//   - the passphrase is never written to the clipboard by this page. A
//     clipboard is read by managers, synced between devices and kept in a
//     history, none of which this app can undo, and the person already has to
//     write the passphrase down to type it back. It stays selectable text
//   - two steps. Step 1 creates the kit through the injected `exportKit`
//     (PBKDF2 plus a wait for the wallet lock can take seconds, which lapses a
//     click's user activation). Nothing is downloaded there. Step 2 is a real
//     "Save file" button, and the download runs synchronously inside THAT
//     click: never in a promise continuation, where a browser may block it
//   - what the page can know is that the download was STARTED, not that a file
//     exists (the browser may ask where to save it and be cancelled, or block
//     it). So the last step says "Download started", and offers "Save again"
//     for as long as the dialog is open
//   - the passphrase is dropped the moment the kit exists: the save step never
//     shows it. The kit text (the encrypted envelope, readable by no one
//     without the passphrase) is held only until the dialog closes, so a
//     download that did not complete can be started again without making a
//     second kit. Neither is ever placed in storage, a URL, an attribute, a
//     log, an account sync or an activity record
//   - a string that is not exactly the sealed envelope of a kit is refused,
//     never offered as a download
//   - closing before a download was started is reported as "created, not
//     saved" (`{saved: false, created: true}`): the SDK marks a kit as
//     exported BEFORE it is delivered, so the host must remember that nothing
//     was
//
// A pure view over injected functions: no facade, no SDK, no storage. The
// caller (handleVersionAction) binds `exportKit` to the facade and tells the
// facade what happened to the file.
//
// DOM hooks: [data-zkapi-exit-kit-dialog] on the <dialog>,
// [data-zkapi-kit-step="create|save|started|unavailable"],
// [data-zkapi-kit-passphrase], [data-zkapi-kit-retype],
// [data-zkapi-kit-action="create|cancel|save|again|close|done"],
// [data-zkapi-kit-status] (role status), [data-zkapi-kit-error] (role alert).
import { escapeHtml } from '../versioning/copy.mjs';
import {
    exitKitFileName, generateKitPassphrase, looksLikeExitKitEnvelope, sameRetype
} from '../versioning/exitKit.mjs';

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const EXIT_KIT_WORDS = Object.freeze({
    createTitle: 'Create an exit kit',
    intro: 'An exit kit is an encrypted file. With the zkAPI companion tool it lets you withdraw this balance '
        + 'even if the service is unavailable. This app can’t open the file.',
    warning: 'Anyone who has the file and its passphrase can move your whole balance to any address. '
        + 'Keep the file offline and keep the passphrase somewhere else.',
    passphraseLabel: 'Your passphrase',
    passphraseHint: 'Write it down now. It is shown once, and this app does not keep it.',
    retypeLabel: 'Type the passphrase again to confirm',
    retypeHint: 'The button turns on when both match.',
    mismatch: 'That doesn’t match the passphrase above.',
    create: 'Create exit kit',
    creating: 'Creating the exit kit…',
    cancel: 'Cancel',
    saveTitle: 'Save your exit kit',
    saveIntro: 'Your exit kit is ready, but it is not saved yet. Save the file now and keep it offline. '
        + 'If you close this window first, you will need to create the exit kit again.',
    save: 'Save file',
    saveFailed: 'The file couldn’t be saved. Try again.',
    close: 'Close',
    startedTitle: 'Download started',
    // What the page knows is that the download began, not that a file exists.
    started: 'The download of {file} has started. Check your downloads folder. If it isn’t there, save it again.',
    startedAgain: 'The download of {file} has started again. Check your downloads folder.',
    startedKeep: 'Keep the passphrase you wrote down with it. This app can’t show it again.',
    again: 'Save again',
    done: 'Done',
    unavailableTitle: 'Exit kit unavailable',
    unavailable: 'This browser can’t create an exit kit.',
    noBalance: 'There is no private balance to export.',
    failed: 'The exit kit could not be created. Try again.',
    unrecognized: 'This browser made a file this app doesn’t recognize, so it wasn’t offered for saving. Try again.'
});

// How long a download's object URL stays valid. Revoking in the same turn as
// the click can cancel the download in some browsers.
const REVOKE_DELAY_MS = 4000;
// How long a close that arrives mid-export waits for the SDK's answer before
// it reports the kit as created (the safe side: it asks to be made again).
const SETTLE_GRACE_MS = 3000;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function words(key, values = {}) {
    return EXIT_KIT_WORDS[key].replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : ''));
}

// What a failed export is called to the person. The SDK's text is never
// shown: it is written for an engineer.
function exportFailureWords(error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    if (code === 'exit_kit_unavailable') return EXIT_KIT_WORDS.unavailable;
    const message = isRecord(error) && typeof error.message === 'string' ? error.message : '';
    if (/no private balance/i.test(message)) return EXIT_KIT_WORDS.noBalance;
    return EXIT_KIT_WORDS.failed;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function titleHtml(text) {
    return `<h2 id="zkapi-kit-title" class="zkapi-sheet-title" tabindex="-1">${escapeHtml(text)}</h2>`;
}

function liveRegions() {
    return '<p class="zkapi-sheet-status" role="status" data-zkapi-kit-status></p>'
        + '<p class="zkapi-sheet-error" role="alert" data-zkapi-kit-error></p>';
}

function createStepHtml(passphrase) {
    return `<form class="zkapi-sheet-body" data-zkapi-kit-step="create" autocomplete="off" novalidate>
        ${titleHtml(EXIT_KIT_WORDS.createTitle)}
        <p id="zkapi-kit-intro" class="zkapi-note">${escapeHtml(EXIT_KIT_WORDS.intro)}</p>
        <p class="zkapi-note zkapi-note--attention">${escapeHtml(EXIT_KIT_WORDS.warning)}</p>
        <div class="zkapi-sheet-field">
            <span id="zkapi-kit-passphrase-label" class="zkapi-sheet-label">${escapeHtml(EXIT_KIT_WORDS.passphraseLabel)}</span>
            <div class="zkapi-sheet-secret" role="group" aria-labelledby="zkapi-kit-passphrase-label"
                aria-describedby="zkapi-kit-passphrase-hint">
                <code class="zkapi-sheet-passphrase" data-zkapi-kit-passphrase>${escapeHtml(passphrase)}</code>
            </div>
            <p id="zkapi-kit-passphrase-hint" class="zkapi-sheet-hint">${escapeHtml(EXIT_KIT_WORDS.passphraseHint)}</p>
        </div>
        <div class="zkapi-sheet-field">
            <label for="zkapi-kit-retype" class="zkapi-sheet-label">${escapeHtml(EXIT_KIT_WORDS.retypeLabel)}</label>
            <input id="zkapi-kit-retype" class="zkapi-sheet-input" data-zkapi-kit-retype type="text" name="zkapi-kit-confirm"
                autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="40"
                data-lpignore="true" data-1p-ignore="true" aria-describedby="zkapi-kit-retype-hint" />
            <p id="zkapi-kit-retype-hint" class="zkapi-sheet-hint">${escapeHtml(EXIT_KIT_WORDS.retypeHint)}</p>
        </div>
        ${liveRegions()}
        <div class="zkapi-sheet-actions">
            <button type="button" class="zkapi-quiet-button" data-zkapi-kit-action="cancel">${escapeHtml(EXIT_KIT_WORDS.cancel)}</button>
            <button type="submit" class="zkapi-primary-button" data-zkapi-kit-action="create" disabled
                aria-describedby="zkapi-kit-retype-hint">${escapeHtml(EXIT_KIT_WORDS.create)}</button>
        </div>
    </form>`;
}

function saveStepHtml() {
    return `<div class="zkapi-sheet-body" data-zkapi-kit-step="save">
        ${titleHtml(EXIT_KIT_WORDS.saveTitle)}
        <p id="zkapi-kit-intro" class="zkapi-note zkapi-note--attention">${escapeHtml(EXIT_KIT_WORDS.saveIntro)}</p>
        ${liveRegions()}
        <div class="zkapi-sheet-actions">
            <button type="button" class="zkapi-quiet-button" data-zkapi-kit-action="close">${escapeHtml(EXIT_KIT_WORDS.close)}</button>
            <button type="button" class="zkapi-primary-button" data-zkapi-kit-action="save">${escapeHtml(EXIT_KIT_WORDS.save)}</button>
        </div>
    </div>`;
}

// The intro is the status region too: the dialog is described by it, it is
// announced when the step opens, and "Save again" replaces its words.
function startedStepHtml(fileName) {
    return `<div class="zkapi-sheet-body" data-zkapi-kit-step="started">
        ${titleHtml(EXIT_KIT_WORDS.startedTitle)}
        <p id="zkapi-kit-intro" class="zkapi-note" role="status" data-zkapi-kit-status>${escapeHtml(words('started', { file: fileName }))}</p>
        <p class="zkapi-note">${escapeHtml(EXIT_KIT_WORDS.startedKeep)}</p>
        <p class="zkapi-sheet-error" role="alert" data-zkapi-kit-error></p>
        <div class="zkapi-sheet-actions">
            <button type="button" class="zkapi-quiet-button" data-zkapi-kit-action="again">${escapeHtml(EXIT_KIT_WORDS.again)}</button>
            <button type="button" class="zkapi-primary-button" data-zkapi-kit-action="done">${escapeHtml(EXIT_KIT_WORDS.done)}</button>
        </div>
    </div>`;
}

function unavailableStepHtml() {
    return `<div class="zkapi-sheet-body" data-zkapi-kit-step="unavailable">
        ${titleHtml(EXIT_KIT_WORDS.unavailableTitle)}
        <p id="zkapi-kit-intro" class="zkapi-note">${escapeHtml(EXIT_KIT_WORDS.unavailable)}</p>
        <div class="zkapi-sheet-actions">
            <button type="button" class="zkapi-primary-button" data-zkapi-kit-action="close">${escapeHtml(EXIT_KIT_WORDS.close)}</button>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

// One dialog per document: a second request returns the open one.
const open = new WeakMap();

function defaultRandomValues() {
    const source = globalThis.crypto;
    return source && typeof source.getRandomValues === 'function' ? array => source.getRandomValues(array) : null;
}

/**
 * Open the exit kit dialog.
 *
 * @param {object} options
 * @param {(passphrase: string) => Promise<string>} options.exportKit  makes the
 *   sealed kit (the facade's `exportExitKit`). Called once per "Create exit
 *   kit" click, with the generated passphrase
 * @param {Document} [options.doc]
 * @param {number|(() => number)} [options.now]  the clock for the file name
 * @param {(array: Uint8Array) => Uint8Array|void} [options.getRandomValues]
 *   the secure random source (bound `crypto.getRandomValues`)
 * @param {{createObjectURL: Function, revokeObjectURL: Function}} [options.urlApi]
 * @param {Function} [options.BlobImpl]
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 * @returns {{close: () => void, result: Promise<{saved: boolean, created: boolean}>}}
 *   `result` settles once when the dialog is gone. `created`: the SDK made a
 *   kit during this dialog (so it counts it as exported). `saved`: a download
 *   of the file was started by the person's click. That is all a page can
 *   know of it, so once it has begun the dialog's words say "started"
 */
export function openExitKitDialog(options = {}) {
    const {
        exportKit, doc = globalThis.document, now = Date.now, getRandomValues, urlApi, BlobImpl,
        setTimer = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimer = handle => globalThis.clearTimeout(handle)
    } = options;
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) {
        return { close() {}, result: Promise.resolve({ saved: false, created: false }) };
    }
    const existing = open.get(doc);
    if (existing) return existing;

    const dialog = doc.createElement('dialog');
    dialog.className = 'zkapi-sheet';
    dialog.setAttribute('aria-labelledby', 'zkapi-kit-title');
    dialog.setAttribute('aria-describedby', 'zkapi-kit-intro');
    dialog.setAttribute('data-zkapi-exit-kit-dialog', '');

    let phase = 'create';            // create | working | save | started | unavailable
    let passphrase = null;
    let kitText = null;
    let created = false;
    let saved = false;
    let closed = false;
    let exporting = null;            // the export's promise while it is in flight
    let resolveResult;
    const result = new Promise(resolve => { resolveResult = resolve; });
    const previousFocus = doc.activeElement;

    const find = selector => dialog.querySelector(selector);
    const setText = (selector, text) => {
        const element = find(selector);
        if (element) element.textContent = text;
    };
    const status = text => setText('[data-zkapi-kit-status]', text);
    const failure = text => setText('[data-zkapi-kit-error]', text);
    const focusTitle = () => {
        const title = find('#zkapi-kit-title');
        if (title && typeof title.focus === 'function') title.focus();
    };

    function setBusy(busy) {
        const retype = find('[data-zkapi-kit-retype]');
        const create = find('[data-zkapi-kit-action="create"]');
        if (retype) retype.disabled = busy;
        if (create) create.disabled = busy || !retypeMatches();
        if (dialog.setAttribute) dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    function retypeMatches() {
        const retype = find('[data-zkapi-kit-retype]');
        return Boolean(retype) && passphrase !== null && sameRetype(passphrase, retype.value);
    }

    function onRetype() {
        const retype = find('[data-zkapi-kit-retype]');
        const create = find('[data-zkapi-kit-action="create"]');
        const matches = retypeMatches();
        if (create) create.disabled = phase === 'working' || !matches;
        // A mismatch is only named once the whole passphrase has been typed,
        // so the words do not flash at the person while they type.
        const complete = Boolean(retype) && passphrase !== null && retype.value.trim().length >= passphrase.length;
        failure(complete && !matches ? EXIT_KIT_WORDS.mismatch : '');
    }

    // -- Steps ---------------------------------------------------------------
    function show(step, fileName = null) {
        phase = step;
        if (step === 'create') dialog.innerHTML = createStepHtml(passphrase);
        else if (step === 'save') dialog.innerHTML = saveStepHtml();
        else if (step === 'started') dialog.innerHTML = startedStepHtml(fileName || exitKitFileName(clock()));
        else dialog.innerHTML = unavailableStepHtml();
        wire();
        focusTitle();
    }

    function clock() {
        try {
            return typeof now === 'function' ? now() : now;
        } catch {
            return Number.NaN;
        }
    }

    function wire() {
        const on = (action, handler) => {
            const element = find(`[data-zkapi-kit-action="${action}"]`);
            if (element) element.addEventListener('click', handler);
        };
        on('cancel', requestClose);
        on('close', requestClose);
        on('done', requestClose);
        on('save', saveFile);
        on('again', saveFile);
        const form = find('form');
        if (form) form.addEventListener('submit', event => {
            event.preventDefault();
            startExport();
        });
        const retype = find('[data-zkapi-kit-retype]');
        if (retype) {
            retype.addEventListener('input', onRetype);
            retype.addEventListener('change', onRetype);
        }
    }

    // -- Actions -------------------------------------------------------------
    function startExport() {
        if (phase !== 'create' || closed || passphrase === null || typeof exportKit !== 'function') return;
        if (!retypeMatches()) return;
        phase = 'working';
        failure('');
        status(EXIT_KIT_WORDS.creating);
        setBusy(true);
        let attempt;
        try {
            attempt = Promise.resolve(exportKit(passphrase));
        } catch (error) {
            attempt = Promise.reject(error);
        }
        exporting = attempt;
        attempt.then(text => {
            exporting = null;
            // The SDK now counts a kit as created, whatever happens next.
            created = true;
            if (closed) return;
            if (typeof text !== 'string' || !looksLikeExitKitEnvelope(text)) {
                phase = 'create';
                status('');
                failure(EXIT_KIT_WORDS.unrecognized);
                setBusy(false);
                return;
            }
            // The passphrase has done its work: the second step never shows
            // it, so it is not kept a moment longer than a retry needs it.
            // The kit text stays until the dialog closes (see saveFile).
            kitText = text;
            passphrase = null;
            show('save');
        }, error => {
            exporting = null;
            if (closed) return;
            phase = 'create';
            status('');
            failure(exportFailureWords(error));
            setBusy(false);
            const retype = find('[data-zkapi-kit-retype]');
            if (retype && typeof retype.focus === 'function') retype.focus();
        });
    }

    // The click handler of "Save file" and "Save again". Everything that
    // starts the download happens here, synchronously: no await and no promise
    // continuation, so the browser still sees the person's click.
    function saveFile() {
        if ((phase !== 'save' && phase !== 'started') || kitText === null || closed) return;
        const urls = urlApi || globalThis.URL;
        const Maker = BlobImpl || globalThis.Blob;
        const fileName = exitKitFileName(clock());
        let url = null;
        let anchor = null;
        try {
            const blob = new Maker([kitText], { type: 'application/json' });
            url = urls.createObjectURL(blob);
            anchor = doc.createElement('a');
            anchor.href = url;
            anchor.download = fileName;
            anchor.rel = 'noopener';
            anchor.hidden = true;
            // Inside the dialog, not the body: while a modal dialog is open
            // the rest of the page is inert, and the link must not be.
            dialog.append(anchor);
            anchor.click();
        } catch {
            // The kit is kept: the person can press Save again.
            if (url && urls && typeof urls.revokeObjectURL === 'function') {
                try { urls.revokeObjectURL(url); } catch { /* nothing to undo */ }
            }
            failure(EXIT_KIT_WORDS.saveFailed);
            return;
        } finally {
            if (anchor && typeof anchor.remove === 'function') anchor.remove();
        }
        // Started. That is all that is known: a browser may ask where to put
        // the file and be cancelled. The kit text is kept, encrypted, until
        // the dialog closes so the person can start it again; "saved" in the
        // result means that a download was started by their click.
        saved = true;
        const revoke = () => {
            try { urls.revokeObjectURL(url); } catch { /* already gone */ }
        };
        setTimer(revoke, REVOKE_DELAY_MS);
        if (phase === 'save') {
            show('started', fileName);
            const done = find('[data-zkapi-kit-action="done"]');
            if (done && typeof done.focus === 'function') done.focus();
        } else {
            failure('');
            status(words('startedAgain', { file: fileName }));
        }
    }

    function requestClose() {
        finish();
    }

    // Tear down once; settle `result` once.
    function finish() {
        if (closed) return;
        closed = true;
        kitText = null;
        passphrase = null;
        open.delete(doc);
        try {
            if (dialog.open !== false && typeof dialog.close === 'function') dialog.close();
        } catch { /* already closed */ }
        dialog.innerHTML = '';
        if (typeof dialog.remove === 'function') dialog.remove();
        if (previousFocus && previousFocus.isConnected !== false && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
        }
        const inFlight = exporting;
        if (!inFlight) {
            resolveResult({ saved, created });
            return;
        }
        // The SDK may be marking the kit as created at this very moment.
        // Wait a moment for its answer instead of guessing; if it does not
        // come, say "created", which asks the person to make it again.
        let settled = false;
        let timer = null;
        const settle = madeIt => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimer(timer);
            created = created || madeIt;
            resolveResult({ saved, created });
        };
        inFlight.then(() => settle(true), () => settle(false));
        timer = setTimer(() => settle(true), SETTLE_GRACE_MS);
    }

    // Escape belongs to this dialog: the balance dialog under it listens on the
    // document and must not be dismissed by the same key.
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        requestClose();
    });
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') event.stopPropagation();
    });

    // -- Open ----------------------------------------------------------------
    let generated = null;
    if (typeof exportKit === 'function') {
        try {
            generated = generateKitPassphrase(getRandomValues || defaultRandomValues());
        } catch {
            generated = null;
        }
    }
    passphrase = generated;
    show(generated === null ? 'unavailable' : 'create');
    doc.body.append(dialog);
    try {
        dialog.showModal();
    } catch {
        // No modal support: an open dialog is still a dialog.
        dialog.setAttribute('open', '');
    }
    focusTitle();

    const handle = { close: requestClose, result };
    open.set(doc, handle);
    return handle;
}
