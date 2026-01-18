/**
 * Recovery code helpers.
 * Generates human-friendly pseudo-words without shipping a massive wordlist.
 *
 * ENTROPY ANALYSIS
 * ----------------
 * Each syllable: 32 consonants × 8 vowels = 256 combinations (8 bits)
 * Each word: 2 syllables = 256² = 65,536 combinations (16 bits)
 * 5 words: 2^80 combinations (~80 bits of entropy)
 *
 * With Argon2id (64MB memory, 4 iterations), brute-force is impractical:
 *   - ~0.7s per attempt on modern hardware
 *   - 2^80 attempts would take longer than the age of the universe
 */

// 32 consonant options (including common clusters for pronounceability)
const CONSONANTS = [
    'b', 'c', 'd', 'f', 'g', 'h', 'j', 'k',
    'l', 'm', 'n', 'p', 'r', 's', 't', 'v',
    'w', 'y', 'z', 'br', 'cr', 'dr', 'fr', 'gr',
    'pr', 'tr', 'st', 'ch', 'sh', 'th', 'pl', 'gl'
];
// 8 vowel options (including diphthongs for variety)
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ai', 'oo'];
// 5 words = ~80 bits of entropy (vs 4 words = ~64 bits)
const WORD_COUNT_DEFAULT = 5;

function byteToSyllable(byte) {
    const vowelCount = VOWELS.length;
    const consonantIndex = Math.floor(byte / vowelCount);
    const vowelIndex = byte % vowelCount;
    return `${CONSONANTS[consonantIndex]}${VOWELS[vowelIndex]}`;
}

function bytesToWord(byte1, byte2) {
    return `${byteToSyllable(byte1)}${byteToSyllable(byte2)}`;
}

export function generateRecoveryCode(wordCount = WORD_COUNT_DEFAULT) {
    const bytes = new Uint8Array(wordCount * 2);
    crypto.getRandomValues(bytes);
    const words = [];
    for (let i = 0; i < wordCount; i++) {
        words.push(bytesToWord(bytes[i * 2], bytes[i * 2 + 1]));
    }
    return words.join('-');
}

export function normalizeRecoveryCode(input) {
    if (!input) return '';
    return input
        .toLowerCase()
        .replace(/[^a-z]+/g, ' ')
        .trim()
        .split(/\s+/)
        .join('-');
}

export function splitRecoveryCode(input) {
    const normalized = normalizeRecoveryCode(input);
    if (!normalized) return [];
    return normalized.split('-').filter(Boolean);
}

export function isValidRecoveryCode(input, wordCount = WORD_COUNT_DEFAULT) {
    return splitRecoveryCode(input).length === wordCount;
}
