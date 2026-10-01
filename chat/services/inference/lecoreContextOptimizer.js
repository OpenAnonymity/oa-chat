/*
 * Browser-local adaptation of leCore's retrieval_dispatch and BM25 algorithms:
 * https://github.com/AnOversizedMooseWithSocks/leCore/tree/5cef1aec
 * Copyright (c) 2026 AnOversizedMooseWithSocks. MIT License.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const STOP = new Set('a an the of to in on at for and or is are be by with from as it this that these those into over under out up down off no not do does did can could would should will your my our their its his her you we they i he she them us me'.split(' '));
const SUFFIXES = ['ing', 'ed', 'es', 's'];

function tokenize(text) {
    const raw = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
    return raw.filter(token => token.length > 1 && !STOP.has(token)).map(token => {
        for (const suffix of SUFFIXES) {
            if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
                return token.slice(0, -suffix.length);
            }
        }
        return token;
    });
}

function tokenOverlapScores(query, docs) {
    const terms = new Set(tokenize(query));
    if (terms.size === 0) return docs.map(() => 0);
    return docs.map(doc => {
        const present = new Set(tokenize(doc));
        let hits = 0;
        for (const term of terms) if (present.has(term)) hits++;
        return hits / terms.size;
    });
}

function bm25Rank(query, docs) {
    const tokens = docs.map(tokenize);
    const lengths = tokens.map(row => row.length);
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / (docs.length || 1);
    const frequencies = tokens.map(row => {
        const counts = new Map();
        for (const term of row) counts.set(term, (counts.get(term) || 0) + 1);
        return counts;
    });
    const documentFrequencies = new Map();
    for (const counts of frequencies) {
        for (const term of counts.keys()) {
            documentFrequencies.set(term, (documentFrequencies.get(term) || 0) + 1);
        }
    }
    const scores = docs.map(() => 0);
    for (const term of tokenize(query)) {
        const count = documentFrequencies.get(term);
        if (!count) continue;
        const idf = Math.log(1 + (docs.length - count + 0.5) / (count + 0.5));
        for (let index = 0; index < docs.length; index++) {
            const frequency = frequencies[index].get(term) || 0;
            if (frequency === 0) continue;
            const denominator = frequency + 1.5 * (0.25 + 0.75 * lengths[index] / (averageLength + 1e-12));
            scores[index] += idf * (frequency * 2.5) / (denominator + 1e-12);
        }
    }
    return scores.map((score, index) => [index, score])
        .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

/** leCore's exact -> margin-gated overlap -> shortlist BM25/RRF -> abstain cascade. */
export function dispatchRetrieval(query, docs, { k = 6, tau = 0.25, shortlist = 32 } = {}) {
    if (docs.length === 0) return { ranked: [], stage: 'abstain', margin: 0, shortlistSize: 0 };
    const phrase = query.toLowerCase().trim().replace(/\s+/g, ' ');
    if (phrase) {
        const exact = docs.map((doc, index) => ({ doc, index }))
            .filter(({ doc }) => String(doc).toLowerCase().trim().replace(/\s+/g, ' ').includes(phrase));
        if (exact.length === 1) {
            return { ranked: [[exact[0].index, 1]], stage: 'exact', margin: 1, shortlistSize: 0 };
        }
    }

    // Browser adapter uses leCore's documented token-overlap fallback. No embedding model is loaded.
    const scores = tokenOverlapScores(query, docs);
    const order = scores.map((score, index) => [index, score])
        .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const first = order[0][1];
    const second = order[1]?.[1] || 0;
    const margin = first > 0 ? (first - second) / Math.max(first, 1e-12) : 0;
    if (first > 0 && margin >= tau) {
        return { ranked: order.slice(0, k), stage: 'dense', margin, shortlistSize: 0 };
    }

    const window = order.slice(0, Math.min(shortlist, docs.length)).map(([index]) => index);
    const lexical = bm25Rank(query, window.map(index => docs[index]));
    if (first <= 0 && (lexical[0]?.[1] || 0) <= 0) {
        return { ranked: [], stage: 'abstain', margin, shortlistSize: window.length };
    }
    const fused = new Map();
    // Reciprocal rank fusion: dense 1.0, lexical 0.3; rank is one-based, k=60.
    window.forEach((_, rank) => fused.set(rank, 1 / (60 + rank + 1)));
    lexical.filter(([, score]) => score > 0).forEach(([index], rank) => {
        fused.set(index, (fused.get(index) || 0) + 0.3 / (60 + rank + 1));
    });
    const ranked = [...fused].sort((a, b) => b[1] - a[1])
        .slice(0, k).map(([localIndex, score]) => [window[localIndex], score]);
    return { ranked, stage: 'refine', margin, shortlistSize: window.length };
}

function passthrough(messages, reason) {
    return { messages, metadata: { applied: false, reason } };
}

function isTextMessage(message) {
    return message && typeof message === 'object' && !Array.isArray(message)
        && ['system', 'developer', 'user', 'assistant'].includes(message.role)
        && typeof message.content === 'string';
}

function positiveInteger(value, fallback, max) {
    return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function asksForWholeHistory(query) {
    return /\b(everything|entire|whole|all|every|each|full history|recap|summari[sz]e|so far|throughout)\b/i.test(query)
        || /\b(decisions|agreements|takeaways|topics|themes|highlights|action items|next steps|to-dos|todos|commitments)\b/i.test(query)
        || /\bacross\s+(?:this|the|our)?\s*(?:chat|conversation|thread|discussion|history)\b/i.test(query)
        || /\b(?:what|which)\b[\s\S]*\b(?:discuss|decide|agree|cover)(?:d|s|ed)?\b[\s\S]*\b(?:chat|conversation|thread|discussion)\b/i.test(query);
}

/**
 * Reduce long text-only history before inference while preserving original message objects.
 * Returned messages remain in source order; no synthesized text or network call is involved.
 */
export function transform(messages, options = {}) {
    if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
    if (!messages.every(isTextMessage)) return passthrough(messages, 'non_text_or_unsupported_message');
    // OA turns historical text/Word attachments into this plain-text delimiter
    // before inference. Preserve the full request so a later question can still
    // use every uploaded document, including one with little lexical overlap.
    if (messages.some(message => /\n\n--- File: [^\n]+ ---\n/.test(message.content))) {
        return passthrough(messages, 'inlined_attachment');
    }

    const minChars = positiveInteger(options.minChars, 16_000, 1_000_000);
    const recentTurns = positiveInteger(options.recentTurns, 4, 12);
    const maxOlderMessages = positiveInteger(options.maxOlderMessages, 6, 24);
    const maxOlderChars = positiveInteger(options.maxOlderChars, 12_000, 100_000);
    const originalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    if (originalChars < minChars) return passthrough(messages, 'short_history');

    const conversation = messages.map((message, index) => ({ message, index }))
        .filter(({ message }) => message.role === 'user' || message.role === 'assistant');
    const users = conversation.filter(({ message }) => message.role === 'user');
    if (users.length <= recentTurns || conversation.length < 12) {
        return passthrough(messages, 'too_few_turns');
    }
    const latestStart = Math.min(users.at(-recentTurns).index, conversation.at(-8).index);
    const older = conversation.filter(({ index }) => index < latestStart);
    if (older.length < 2) return passthrough(messages, 'too_few_older_messages');

    const latestQuery = users.at(-1).message.content.trim();
    if (asksForWholeHistory(latestQuery)) {
        return passthrough(messages, 'broad_query');
    }
    const query = latestQuery.length >= 12 ? latestQuery :
        `${users.at(-2).message.content} ${latestQuery}`.trim();
    if (query.length < 12) return passthrough(messages, 'short_query');

    const docs = older.map(({ message }) => message.content);
    const result = dispatchRetrieval(query.slice(-4_096), docs,
        { k: Math.min(maxOlderMessages * 2, 24), shortlist: 32 });
    if (result.stage === 'abstain') return passthrough(messages, 'no_relevant_older_context');

    const relevance = tokenOverlapScores(query.slice(-4_096), docs);
    const selected = new Set();
    let selectedChars = 0;
    for (const [rankedIndex] of result.ranked) {
        if (relevance[rankedIndex] <= 0) continue;
        const source = older[rankedIndex];
        // Keep a relevant exchange together: a user prompt with its following answer,
        // or an answer with its preceding prompt, if both precede the recent window.
        const companion = source.message.role === 'user' ? older[rankedIndex + 1] : older[rankedIndex - 1];
        const pair = [source];
        if (companion && Math.abs(companion.index - source.index) === 1
            && companion.message.role !== source.message.role) pair.push(companion);
        const fresh = pair.filter(({ index }) => !selected.has(index));
        const addedChars = fresh.reduce((sum, { message }) => sum + message.content.length, 0);
        if (addedChars > maxOlderChars && selected.size === 0) {
            return passthrough(messages, 'relevant_message_too_large');
        }
        if (selectedChars + addedChars > maxOlderChars
            || selected.size + fresh.length > maxOlderMessages) continue;
        for (const item of fresh) selected.add(item.index);
        selectedChars += addedChars;
        if (selected.size >= maxOlderMessages) break;
    }
    if (selected.size === 0) return passthrough(messages, 'no_relevant_older_context');

    const keep = new Set(selected);
    messages.forEach((message, index) => {
        if (index >= latestStart || message.role === 'system' || message.role === 'developer') keep.add(index);
    });
    const optimized = messages.filter((_, index) => keep.has(index));
    const optimizedChars = optimized.reduce((sum, message) => sum + message.content.length, 0);
    if (optimizedChars > originalChars * 0.85) return passthrough(messages, 'insufficient_savings');
    return {
        messages: optimized,
        metadata: {
            applied: true,
            reason: 'lecore_browser_retrieval',
            stage: result.stage,
            originalMessageCount: messages.length,
            optimizedMessageCount: optimized.length,
            originalChars,
            optimizedChars,
            retrievedIndices: [...selected].sort((a, b) => a - b)
        }
    };
}
