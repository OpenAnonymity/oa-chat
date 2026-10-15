// The pure half of "Create an exit kit" (docs/ZKAPI_VERSIONING.md, section 7,
// "Upgrade UX").
//
// An exit kit is an encrypted file that can move a whole balance to any
// address, so the decisions that protect the person live here, away from the
// DOM where they can be pinned by plain tests:
//
//   - the passphrase is generated, never chosen. A person-chosen passphrase is
//     as weak as the person's habits; a generated one carries 100 bits, which
//     the SDK's PBKDF2 setting then makes expensive to guess offline. The
//     length-only policy of the SDK (10 characters) is a floor, not a design
//   - the file name carries a local date and nothing that identifies a
//     balance, a version or a person
//   - a file is offered for saving only when it is shaped exactly like the
//     encrypted envelope the SDK documents. A string that is anything else (an
//     error text, a payload that was not sealed) must never reach a download
//
// No DOM, no storage, no clock, no SDK: the random source and the date arrive
// as arguments. Nothing in this module logs or serializes a passphrase.

// 32 symbols, so a byte reduced to its low five bits is uniform (256 is a
// multiple of 32). Without I, O, 0 and 1, which are misread when handwritten.
export const PASSPHRASE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PASSPHRASE_LENGTH = 20;
export const PASSPHRASE_GROUP = 5;
/** Entropy of a generated passphrase, in bits (20 symbols of 5 bits). */
export const PASSPHRASE_BITS = 100;

/** The envelope format the SDK seals (services/zkapiExitKit.mjs). */
export const EXIT_KIT_FORMAT = 'zkapi-exit-kit-v1';
const KIT_FILE_PREFIX = 'oa-chat-exit-kit';
// The SDK refuses to open a kit sealed with fewer iterations.
const MIN_KDF_ITERATIONS = 100_000;
// A real kit is a few kilobytes; a string far beyond that is not one.
const MAX_KIT_CHARACTERS = 262_144;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function kitError(message, code) {
    return Object.assign(new Error(message), { code });
}

function sameKeys(value, keys) {
    const own = Object.keys(value).sort();
    return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

/**
 * A generated exit kit passphrase: 20 symbols from a 32-symbol alphabet shown
 * as `XXXXX-XXXXX-XXXXX-XXXXX` (100 bits). The hyphenated string is the
 * passphrase: it is what the SDK seals with and what the companion tool asks
 * for, so it is also what the person writes down.
 *
 * `getRandomValues` is `crypto.getRandomValues`, bound. Throws an error with
 * `code: 'exit_kit_unavailable'` when there is no usable secure random source
 * (no function, a function that throws, or one that returns the same value
 * twenty times, which no real source does).
 *
 * @param {(array: Uint8Array) => Uint8Array|void} getRandomValues
 * @returns {string}
 */
export function generateKitPassphrase(getRandomValues) {
    if (typeof getRandomValues !== 'function') {
        throw kitError('This browser has no secure random source.', 'exit_kit_unavailable');
    }
    const bytes = new Uint8Array(PASSPHRASE_LENGTH);
    let filled;
    try {
        filled = getRandomValues(bytes);
    } catch {
        throw kitError('This browser has no secure random source.', 'exit_kit_unavailable');
    }
    // `crypto.getRandomValues` fills in place and returns the same array; a
    // stand-in may hand back another one of the right size.
    const source = filled instanceof Uint8Array && filled.length === PASSPHRASE_LENGTH ? filled : bytes;
    const symbols = Array.from(source, byte => byte & 31);
    if (symbols.every(symbol => symbol === symbols[0])) {
        throw kitError('This browser has no secure random source.', 'exit_kit_unavailable');
    }
    const letters = symbols.map(symbol => PASSPHRASE_ALPHABET[symbol]);
    const groups = [];
    for (let at = 0; at < letters.length; at += PASSPHRASE_GROUP) {
        groups.push(letters.slice(at, at + PASSPHRASE_GROUP).join(''));
    }
    return groups.join('-');
}

/**
 * Whether what the person typed is the passphrase that was shown. Surrounding
 * whitespace is ignored (a paste carries it); nothing else is: case matters
 * and so do the hyphens, because the companion tool is exact.
 */
export function sameRetype(shown, typed) {
    if (typeof shown !== 'string' || typeof typed !== 'string') return false;
    const expected = shown.trim();
    return expected.length > 0 && expected === typed.trim();
}

/**
 * `oa-chat-exit-kit-YYYY-MM-DD.json`, from the LOCAL date of `date` (a Date or
 * epoch milliseconds). No id of a balance, version or person is in the name. A
 * date that is not one gives `oa-chat-exit-kit.json`.
 */
export function exitKitFileName(date) {
    const when = date instanceof Date ? date : typeof date === 'number' ? new Date(date) : null;
    if (!when || Number.isNaN(when.getTime())) return `${KIT_FILE_PREFIX}.json`;
    const two = value => String(value).padStart(2, '0');
    const year = String(when.getFullYear()).padStart(4, '0');
    return `${KIT_FILE_PREFIX}-${year}-${two(when.getMonth() + 1)}-${two(when.getDate())}.json`;
}

/**
 * Whether `text` is, exactly, the sealed envelope of an exit kit
 * (`zkapi-exit-kit-v1`: `format`, `kdf {name, hash, iterations, salt}`,
 * `cipher {name, iv}`, `ciphertext`) and nothing more.
 *
 * The check is deliberately strict. Its job is to keep a file that is not an
 * encrypted kit from being offered for download as one (a plaintext payload
 * would hold the balance's secret). A future envelope format must be taught to
 * this function together with the SDK pin that produces it.
 */
export function looksLikeExitKitEnvelope(text) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_KIT_CHARACTERS) return false;
    let kit;
    try {
        kit = JSON.parse(text);
    } catch {
        return false;
    }
    if (!isRecord(kit) || !sameKeys(kit, ['cipher', 'ciphertext', 'format', 'kdf'])) return false;
    if (kit.format !== EXIT_KIT_FORMAT) return false;
    const { kdf, cipher } = kit;
    if (!isRecord(kdf) || !sameKeys(kdf, ['hash', 'iterations', 'name', 'salt'])) return false;
    if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') return false;
    if (!Number.isSafeInteger(kdf.iterations) || kdf.iterations < MIN_KDF_ITERATIONS) return false;
    if (typeof kdf.salt !== 'string' || !BASE64.test(kdf.salt)) return false;
    if (!isRecord(cipher) || !sameKeys(cipher, ['iv', 'name'])) return false;
    if (cipher.name !== 'AES-256-GCM' || typeof cipher.iv !== 'string' || !BASE64.test(cipher.iv)) return false;
    return typeof kit.ciphertext === 'string' && BASE64.test(kit.ciphertext);
}
