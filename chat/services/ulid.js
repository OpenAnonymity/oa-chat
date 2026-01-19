const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_ALPHABET_LOWER = ULID_ALPHABET.toLowerCase();
const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_LENGTH = 11;

function encodeUlidTime(timeMs) {
    let time = timeMs;
    const chars = new Array(ULID_TIME_LENGTH);
    for (let i = ULID_TIME_LENGTH - 1; i >= 0; i -= 1) {
        chars[i] = ULID_ALPHABET_LOWER[time % 32];
        time = Math.floor(time / 32);
    }
    return chars.join('');
}

function encodeUlidRandom() {
    const chars = new Array(ULID_RANDOM_LENGTH);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const bytes = new Uint8Array(ULID_RANDOM_LENGTH);
        crypto.getRandomValues(bytes);
        for (let i = 0; i < ULID_RANDOM_LENGTH; i += 1) {
            chars[i] = ULID_ALPHABET_LOWER[bytes[i] & 31];
        }
    } else {
        for (let i = 0; i < ULID_RANDOM_LENGTH; i += 1) {
            chars[i] = ULID_ALPHABET_LOWER[Math.floor(Math.random() * 32)];
        }
    }
    return chars.join('');
}

export function generateUlid21() {
    const timePart = encodeUlidTime(Date.now());
    const randomPart = encodeUlidRandom();
    return `${timePart}${randomPart}`;
}
