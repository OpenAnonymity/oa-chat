import {
    create,
    insertMultiple,
    removeMultiple,
    search
} from '../vector/vendor/orama/index.js';
import { getMessageTextContent } from '../domain/messageContent.js';

const SEARCH_PROPERTIES = ['title', 'userText', 'assistantText'];
const DEFAULT_LIMIT = 300;
const DEFAULT_SNIPPET_CHARS = 180;
const BUILD_BATCH_SIZE = 250;
const PRIVACY_SAFE_VARIANTS = new Set([
    'title',
    'prompt',
    'scrubbed-prompt',
    'answer',
    'redacted-answer'
]);

function normalizeText(value) {
    return getMessageTextContent(value)
        .replace(/\s+/g, ' ')
        .trim();
}

function addVariant(variants, seen, kind, label, value) {
    const text = normalizeText(value);
    if (!text) return;
    const key = text.toLocaleLowerCase('en');
    if (seen.has(key)) return;
    seen.add(key);
    variants.push({ kind, label, text });
}

export function getSearchableMessageVariants(message) {
    if (!message || message.isLocalOnly) return [];
    if (message.role !== 'user' && message.role !== 'assistant') return [];

    const variants = [];
    const seen = new Set();

    if (message.role === 'user') {
        addVariant(variants, seen, 'original-prompt', 'Original prompt', message.scrubber?.original);
        addVariant(variants, seen, 'scrubbed-prompt', 'Scrubbed prompt', message.scrubber?.redacted);
        addVariant(variants, seen, 'prompt', 'You', message.content);
        return variants;
    }

    addVariant(variants, seen, 'redacted-answer', 'Assistant', message.scrubber?.redactedResponse);
    addVariant(variants, seen, 'restored-answer', 'Restored answer', message.scrubber?.restoredResponse);
    addVariant(variants, seen, 'answer', 'Assistant', message.content);
    return variants;
}

function getSearchDocumentId(sessionId, messageId, type = 'message') {
    return type === 'title'
        ? `${sessionId}::title`
        : `${sessionId}::message::${String(messageId || '')}`;
}

export function buildConversationSearchDocuments(session, messages = []) {
    if (!session?.id) return [];

    const title = normalizeText(session.title);
    const updatedAt = Number(session.updatedAt || session.createdAt || 0);
    const starred = Boolean(session.starred);
    const documents = [];

    for (const message of messages || []) {
        const variants = getSearchableMessageVariants(message);
        if (!variants.length) continue;
        const text = variants.map(variant => variant.text).join('\n');
        documents.push({
            id: getSearchDocumentId(session.id, message.id),
            sessionId: session.id,
            messageId: String(message.id || ''),
            role: message.role,
            title: '',
            userText: message.role === 'user' ? text : '',
            assistantText: message.role === 'assistant' ? text : '',
            updatedAt,
            starred,
            variants
        });
    }

    if (!documents.length || title) {
        documents.push({
            id: getSearchDocumentId(session.id, '', 'title'),
            sessionId: session.id,
            messageId: '',
            role: 'session',
            title,
            userText: '',
            assistantText: '',
            updatedAt,
            starred,
            variants: title ? [{ kind: 'title', label: 'Chat title', text: title }] : []
        });
    }

    return documents;
}

function normalizeQuery(query) {
    return String(query || '')
        .toLocaleLowerCase('en')
        .replace(/\s+/g, ' ')
        .trim();
}

function getQueryTerms(query) {
    return normalizeQuery(query).match(/[a-z0-9]+/g) || [];
}

function variantMatchScore(variant, normalizedQuery, queryTerms) {
    const text = normalizeQuery(variant?.text);
    if (!text) return -1;
    const phraseIndex = text.indexOf(normalizedQuery);
    const privacySafe = PRIVACY_SAFE_VARIANTS.has(variant?.kind);
    if (phraseIndex !== -1) {
        return (privacySafe ? 20000 : 0) + 10000 - Math.min(phraseIndex, 1000);
    }

    const matchedTerms = queryTerms.filter(term => text.includes(term));
    if (!matchedTerms.length) return -1;
    const complete = matchedTerms.length === queryTerms.length;
    return (complete && privacySafe ? 20000 : 0) +
        (complete ? 5000 : 1000) + matchedTerms.length * 100;
}

export function selectBestSearchVariant(document, query) {
    const normalizedQuery = normalizeQuery(query);
    const queryTerms = getQueryTerms(query);
    const variants = Array.isArray(document?.variants) ? document.variants : [];
    const candidates = [
        ...(normalizeText(document?.title)
            ? [{ kind: 'title', label: 'Chat title', text: normalizeText(document.title) }]
            : []),
        ...variants
    ];

    let best = null;
    let bestScore = -1;
    for (const variant of candidates) {
        const score = variantMatchScore(variant, normalizedQuery, queryTerms);
        if (score > bestScore) {
            best = variant;
            bestScore = score;
        }
    }
    return best || candidates[0] || null;
}

export function buildSearchSnippet(text, query, maxChars = DEFAULT_SNIPPET_CHARS) {
    const normalizedText = normalizeText(text);
    if (!normalizedText || normalizedText.length <= maxChars) return normalizedText;

    const normalizedQuery = normalizeQuery(query);
    const lowerText = normalizedText.toLocaleLowerCase('en');
    let matchIndex = lowerText.indexOf(normalizedQuery);
    if (matchIndex === -1) {
        const terms = getQueryTerms(query);
        matchIndex = terms.reduce((best, term) => {
            const index = lowerText.indexOf(term);
            if (index === -1) return best;
            return best === -1 ? index : Math.min(best, index);
        }, -1);
    }
    if (matchIndex === -1) matchIndex = 0;

    const context = Math.floor((maxChars - normalizedQuery.length) / 2);
    let start = Math.max(0, matchIndex - Math.max(24, context));
    let end = Math.min(normalizedText.length, start + maxChars);
    if (end - start < maxChars) {
        start = Math.max(0, end - maxChars);
    }

    const prefix = start > 0 ? '…' : '';
    const suffix = end < normalizedText.length ? '…' : '';
    return `${prefix}${normalizedText.slice(start, end).trim()}${suffix}`;
}

function createSearchDatabase() {
    return create({
        schema: {
            sessionId: 'string',
            messageId: 'string',
            role: 'string',
            title: 'string',
            userText: 'string',
            assistantText: 'string',
            updatedAt: 'number',
            starred: 'boolean'
        }
    });
}

function yieldToBrowser() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export class ConversationSearchService {
    constructor(options = {}) {
        this.batchSize = options.batchSize || BUILD_BATCH_SIZE;
        this.yieldControl = options.yieldControl || yieldToBrowser;
        this.db = createSearchDatabase();
        this.ready = false;
        this.buildPromise = null;
        this.mutationPromise = Promise.resolve();
        this.generation = 0;
        this.sessionDocumentIds = new Map();
        this.pendingMutations = new Map();
    }

    async ensureBuilt(dataSource) {
        if (this.ready) return;
        if (this.buildPromise) {
            await this.buildPromise;
            if (!this.ready) return this.ensureBuilt(dataSource);
            return;
        }
        const hasMessageLoader = typeof dataSource?.getSearchableMessagesForIndex === 'function' ||
            typeof dataSource?.getAllMessages === 'function';
        if (typeof dataSource?.getAllSessions !== 'function' || !hasMessageLoader) {
            throw new Error('Conversation search requires session and message loaders.');
        }

        const generation = ++this.generation;
        const buildPromise = this.buildFromDataSource(dataSource, generation)
            .finally(() => {
                if (this.buildPromise === buildPromise) {
                    this.buildPromise = null;
                }
            });
        this.buildPromise = buildPromise;
        await buildPromise;
        if (!this.ready && generation !== this.generation) {
            return this.ensureBuilt(dataSource);
        }
    }

    async buildFromDataSource(dataSource, generation) {
        const loadMessages = typeof dataSource.getSearchableMessagesForIndex === 'function'
            ? () => dataSource.getSearchableMessagesForIndex()
            : () => dataSource.getAllMessages();
        const [sessions, messages] = await Promise.all([
            dataSource.getAllSessions(),
            loadMessages()
        ]);
        if (generation !== this.generation) return;

        const messagesBySession = new Map();
        for (const message of messages || []) {
            if (!message?.sessionId) continue;
            const list = messagesBySession.get(message.sessionId) || [];
            list.push(message);
            messagesBySession.set(message.sessionId, list);
        }

        const nextDb = createSearchDatabase();
        const nextDocumentIds = new Map();
        let batch = [];
        for (const session of sessions || []) {
            const sessionMessages = messagesBySession.get(session.id) || [];
            sessionMessages.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
            const documents = buildConversationSearchDocuments(session, sessionMessages);
            nextDocumentIds.set(session.id, documents.map(document => document.id));
            batch.push(...documents);
            if (batch.length >= this.batchSize) {
                await insertMultiple(nextDb, batch);
                batch = [];
                await this.yieldControl();
                if (generation !== this.generation) return;
            }
        }
        if (batch.length) {
            await insertMultiple(nextDb, batch);
        }
        if (generation !== this.generation) return;

        while (this.pendingMutations.size) {
            const pending = Array.from(this.pendingMutations.entries());
            for (const [sessionId, mutation] of pending) {
                if (this.pendingMutations.get(sessionId) !== mutation) continue;
                this.pendingMutations.delete(sessionId);
                await this.applyMutation(nextDb, nextDocumentIds, mutation);
                if (generation !== this.generation) return;
            }
        }

        this.db = nextDb;
        this.sessionDocumentIds = nextDocumentIds;
        this.ready = true;
    }

    async applyMutation(targetDb, targetDocumentIds, mutation) {
        const sessionId = mutation?.sessionId;
        if (!sessionId) return;
        const existingIds = targetDocumentIds.get(sessionId) || [];
        if (existingIds.length) {
            await removeMultiple(targetDb, existingIds);
        }
        if (mutation.type === 'remove') {
            targetDocumentIds.delete(sessionId);
            return;
        }

        const documents = buildConversationSearchDocuments(mutation.session, mutation.messages);
        if (documents.length) {
            await insertMultiple(targetDb, documents);
        }
        targetDocumentIds.set(sessionId, documents.map(document => document.id));
    }

    async upsertSession(session, messages) {
        if (!session?.id) return;
        if (!this.ready) {
            this.pendingMutations.set(session.id, {
                type: 'upsert',
                sessionId: session.id,
                session,
                messages
            });
            return this.buildPromise || undefined;
        }
        const generation = this.generation;
        const targetDb = this.db;
        this.mutationPromise = this.mutationPromise.catch(() => {}).then(async () => {
            if (generation !== this.generation) return;
            await this.applyMutation(targetDb, this.sessionDocumentIds, {
                type: 'upsert',
                sessionId: session.id,
                session,
                messages
            });
            if (generation !== this.generation) return;
        });
        return this.mutationPromise;
    }

    async removeSession(sessionId) {
        if (!sessionId) return;
        if (!this.ready) {
            this.pendingMutations.set(sessionId, { type: 'remove', sessionId });
            return this.buildPromise || undefined;
        }
        const generation = this.generation;
        const targetDb = this.db;
        this.mutationPromise = this.mutationPromise.catch(() => {}).then(async () => {
            if (generation !== this.generation) return;
            await this.applyMutation(targetDb, this.sessionDocumentIds, {
                type: 'remove',
                sessionId
            });
            if (generation !== this.generation) return;
        });
        return this.mutationPromise;
    }

    clear() {
        this.generation += 1;
        this.db = createSearchDatabase();
        this.ready = false;
        this.buildPromise = null;
        this.mutationPromise = Promise.resolve();
        this.sessionDocumentIds.clear();
        this.pendingMutations.clear();
    }

    invalidate() {
        this.clear();
    }

    async search(query, options = {}) {
        if (!this.ready) return [];
        await this.mutationPromise;
        const term = String(query || '').trim();
        if (!term) return [];

        const where = {};
        if (options.starredOnly) {
            where.starred = true;
        }
        const updatedAt = {};
        if (Number.isFinite(options.minUpdatedAt) && Number.isFinite(options.maxUpdatedAt)) {
            updatedAt.between = [options.minUpdatedAt, options.maxUpdatedAt];
        } else if (Number.isFinite(options.minUpdatedAt)) {
            updatedAt.gte = options.minUpdatedAt;
        } else if (Number.isFinite(options.maxUpdatedAt)) {
            updatedAt.lte = options.maxUpdatedAt;
        }
        if (Object.keys(updatedAt).length) where.updatedAt = updatedAt;

        const response = await search(this.db, {
            term,
            properties: SEARCH_PROPERTIES,
            boost: { title: 2.5, userText: 1.25, assistantText: 1 },
            relevance: { k: 1.2, b: 0.75, d: 0.5 },
            tolerance: 0,
            threshold: 0,
            distinctOn: 'sessionId',
            sortBy: (left, right) => {
                const updatedAtDifference = Number(right[2]?.updatedAt || 0) - Number(left[2]?.updatedAt || 0);
                return updatedAtDifference || right[1] - left[1];
            },
            where,
            limit: options.limit || DEFAULT_LIMIT
        });

        return (response?.hits || []).map(hit => {
            const document = hit.document || {};
            const variant = selectBestSearchVariant(document, term);
            return {
                sessionId: document.sessionId,
                messageId: variant?.kind === 'title' ? null : (document.messageId || null),
                role: document.role,
                variant: variant?.kind || null,
                label: variant?.label || 'Match',
                snippet: buildSearchSnippet(variant?.text || document.title || '', term),
                score: hit.score || 0
            };
        });
    }
}

const conversationSearch = new ConversationSearchService();

export default conversationSearch;
