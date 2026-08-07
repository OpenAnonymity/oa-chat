import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildConversationSearchDocuments,
    buildSearchSnippet,
    ConversationSearchService,
    getSearchableMessageVariants
} from '../../chat/services/conversationSearch.js';

function createDataSource(sessions, messages) {
    return {
        getAllSessions: async () => sessions,
        getAllMessages: async () => messages
    };
}

function createService() {
    return new ConversationSearchService({
        batchSize: 1000,
        yieldControl: async () => {}
    });
}

test('searchable variants include scrubber prompt forms and visible answer forms only', () => {
    const userVariants = getSearchableMessageVariants({
        role: 'user',
        content: '[NAME] asked a question',
        scrubber: {
            original: 'Alice asked a question',
            redacted: '[NAME] asked a question'
        },
        reasoning: 'not searchable'
    });
    assert.deepEqual(userVariants.map(variant => variant.kind), ['original-prompt', 'scrubbed-prompt']);
    assert.match(userVariants[0].text, /Alice/);

    const assistantVariants = getSearchableMessageVariants({
        role: 'assistant',
        content: 'Redacted visible answer',
        scrubber: {
            redactedResponse: 'Redacted visible answer',
            restoredResponse: 'Restored visible answer'
        },
        reasoning: 'hidden chain of thought',
        citations: [{ title: 'hidden citation' }]
    });
    assert.deepEqual(assistantVariants.map(variant => variant.kind), ['redacted-answer', 'restored-answer']);
    assert.equal(getSearchableMessageVariants({ role: 'assistant', content: 'local', isLocalOnly: true }).length, 0);
});

test('documents exclude system and local-only messages', () => {
    const documents = buildConversationSearchDocuments(
        { id: 's1', title: 'Search title', updatedAt: 10 },
        [
            { id: 'u1', role: 'user', content: 'visible prompt', timestamp: 1 },
            { id: 'a1', role: 'assistant', content: 'visible answer', timestamp: 2 },
            { id: 'l1', role: 'assistant', content: 'memory agent', isLocalOnly: true, timestamp: 3 },
            { id: 'x1', role: 'system', content: 'system text', timestamp: 4 }
        ]
    );
    assert.equal(documents.filter(document => document.messageId).length, 2);
    assert.equal(documents.some(document => document.userText.includes('system text')), false);
    assert.equal(documents.some(document => document.assistantText.includes('memory agent')), false);
});

test('search finds original scrubbed prompts and complete long assistant answers', async () => {
    const service = createService();
    const longAnswer = `${'prefix '.repeat(700)}needle-at-the-end`;
    await service.ensureBuilt(createDataSource(
        [{ id: 's1', title: 'Private chat', updatedAt: 100 }],
        [
            {
                id: 'u1',
                sessionId: 's1',
                role: 'user',
                content: '[NAME] launch plan',
                timestamp: 1,
                scrubber: {
                    original: 'Alice launch plan',
                    redacted: '[NAME] launch plan'
                }
            },
            { id: 'a1', sessionId: 's1', role: 'assistant', content: longAnswer, timestamp: 2 }
        ]
    ));

    const originalMatches = await service.search('Alice');
    assert.equal(originalMatches[0].messageId, 'u1');
    assert.equal(originalMatches[0].variant, 'original-prompt');

    const answerMatches = await service.search('needle-at-the-end');
    assert.equal(answerMatches[0].messageId, 'a1');
    assert.match(answerMatches[0].snippet, /needle-at-the-end/);
});

test('canonical scrubber variants keep navigation identity regardless of the current view', async () => {
    const service = createService();
    await service.ensureBuilt(createDataSource(
        [{ id: 's1', title: 'Private chat', updatedAt: 100 }],
        [
            {
                id: 'u1',
                sessionId: 's1',
                role: 'user',
                content: 'Alice launch plan',
                scrubber: {
                    original: 'Alice launch plan',
                    redacted: '[NAME] launch plan',
                    showingOriginal: true
                }
            },
            {
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: 'Alice should launch Tuesday',
                scrubber: {
                    redactedResponse: '[NAME] should launch Tuesday',
                    restoredResponse: 'Alice should launch Tuesday',
                    restored: true
                }
            }
        ]
    ));

    assert.equal((await service.search('Alice launch plan'))[0].variant, 'original-prompt');
    assert.equal((await service.search('Alice should launch'))[0].variant, 'restored-answer');
});

test('privacy-safe scrubber variants win when they satisfy the same query', async () => {
    const service = createService();
    await service.ensureBuilt(createDataSource(
        [{ id: 's1', title: 'Private chat', updatedAt: 100 }],
        [
            {
                id: 'u1',
                sessionId: 's1',
                role: 'user',
                content: '[NAME] likes bananas',
                scrubber: {
                    original: 'Alice likes bananas',
                    redacted: '[NAME] likes bananas'
                }
            },
            {
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: '[NAME] should buy bananas',
                scrubber: {
                    redactedResponse: '[NAME] should buy bananas',
                    restoredResponse: 'Alice should buy bananas'
                }
            }
        ]
    ));

    assert.equal((await service.search('likes bananas'))[0].variant, 'scrubbed-prompt');
    assert.equal((await service.search('buy bananas'))[0].variant, 'redacted-answer');
    assert.equal((await service.search('Alice likes'))[0].variant, 'original-prompt');
    assert.equal((await service.search('Alice should'))[0].variant, 'restored-answer');
});

test('search keeps sessions recent-first and applies star/date filters', async () => {
    const service = createService();
    await service.ensureBuilt(createDataSource(
        [
            { id: 'old', title: 'Old', updatedAt: 100, starred: true },
            { id: 'new', title: 'New', updatedAt: 300 },
            { id: 'middle', title: 'Middle', updatedAt: 200, starred: true }
        ],
        [
            { id: 'a1', sessionId: 'old', role: 'assistant', content: 'shared banana answer', timestamp: 1 },
            { id: 'a2', sessionId: 'new', role: 'assistant', content: 'shared banana answer', timestamp: 2 },
            { id: 'a3', sessionId: 'middle', role: 'assistant', content: 'shared banana answer', timestamp: 3 }
        ]
    ));

    assert.deepEqual((await service.search('banana')).map(match => match.sessionId), ['new', 'middle', 'old']);
    assert.deepEqual(
        (await service.search('banana', { starredOnly: true })).map(match => match.sessionId),
        ['middle', 'old']
    );
    assert.deepEqual(
        (await service.search('banana', { minUpdatedAt: 150, maxUpdatedAt: 250 })).map(match => match.sessionId),
        ['middle']
    );
});

test('multi-term queries require all terms in one visible message', async () => {
    const service = createService();
    await service.ensureBuilt(createDataSource(
        [
            { id: 'complete', title: 'Complete', updatedAt: 1 },
            { id: 'partial', title: 'Partial', updatedAt: 2 }
        ],
        [
            { id: 'm1', sessionId: 'complete', role: 'user', content: 'alpha beta', timestamp: 1 },
            { id: 'm2', sessionId: 'partial', role: 'user', content: 'alpha only', timestamp: 2 }
        ]
    ));
    assert.deepEqual((await service.search('alpha beta')).map(match => match.sessionId), ['complete']);
});

test('incremental upsert and removal keep results current', async () => {
    const service = createService();
    const session = { id: 's1', title: 'Chat', updatedAt: 1 };
    await service.ensureBuilt(createDataSource([session], [
        { id: 'm1', sessionId: 's1', role: 'user', content: 'before edit', timestamp: 1 }
    ]));

    await service.upsertSession({ ...session, updatedAt: 2 }, [
        { id: 'm1', sessionId: 's1', role: 'user', content: 'after edit', timestamp: 1 }
    ]);
    assert.equal((await service.search('before')).length, 0);
    assert.equal((await service.search('after'))[0].sessionId, 's1');

    await service.removeSession('s1');
    assert.equal((await service.search('after')).length, 0);
});

test('an upsert racing the initial build is replayed after the build snapshot', async () => {
    const service = createService();
    const session = { id: 's1', title: 'Chat', updatedAt: 2 };
    let releaseMessages;
    const messageSnapshot = new Promise(resolve => {
        releaseMessages = resolve;
    });
    const build = service.ensureBuilt({
        getAllSessions: async () => [session],
        getAllMessages: async () => messageSnapshot
    });

    const upsert = service.upsertSession(session, [
        { id: 'm1', sessionId: 's1', role: 'assistant', content: 'new race winner' }
    ]);
    releaseMessages([
        { id: 'm1', sessionId: 's1', role: 'assistant', content: 'old snapshot value' }
    ]);
    await Promise.all([build, upsert]);

    assert.equal((await service.search('old snapshot')).length, 0);
    assert.equal((await service.search('new race winner'))[0].messageId, 'm1');
});

test('BM25 chooses the best excerpt per session before sessions are ordered by recency', async () => {
    const service = createService();
    const token = 'precisionneedle';
    await service.ensureBuilt(createDataSource(
        [
            { id: 'older', title: 'Older', updatedAt: 100 },
            { id: 'newer', title: 'Newer', updatedAt: 200 }
        ],
        [
            { id: 'concise', sessionId: 'older', role: 'user', content: token, timestamp: 1 },
            {
                id: 'verbose',
                sessionId: 'older',
                role: 'assistant',
                content: `${'unrelated context '.repeat(500)}${token}`,
                timestamp: 2
            },
            { id: 'recent', sessionId: 'newer', role: 'assistant', content: `recent ${token}`, timestamp: 3 }
        ]
    ));

    const matches = await service.search(token);
    assert.deepEqual(matches.map(match => match.sessionId), ['newer', 'older']);
    assert.equal(matches.find(match => match.sessionId === 'older').messageId, 'concise');
});

test('invalidation rebuilds newly imported sessions from the current data source', async () => {
    const sessions = [{ id: 'existing', title: 'Existing', updatedAt: 1 }];
    const messages = [];
    const service = createService();
    const dataSource = createDataSource(sessions, messages);
    await service.ensureBuilt(dataSource);

    sessions.push({ id: 'imported', title: 'Imported', updatedAt: 2 });
    messages.push({
        id: 'imported-message',
        sessionId: 'imported',
        role: 'assistant',
        content: 'backup import needle'
    });
    service.invalidate();
    await service.ensureBuilt(dataSource);

    assert.equal((await service.search('backup import needle'))[0].sessionId, 'imported');
});

test('snippet centers long text around the match', () => {
    const snippet = buildSearchSnippet(`${'left '.repeat(80)}target ${'right '.repeat(80)}`, 'target', 80);
    assert.ok(snippet.startsWith('…'));
    assert.ok(snippet.endsWith('…'));
    assert.match(snippet, /target/);
});

test('indexed queries stay fast at the 5,000-session scale target', async () => {
    const sessions = [];
    const messages = [];
    for (let index = 0; index < 5000; index += 1) {
        const id = `session-${index}`;
        sessions.push({ id, title: `Chat ${index}`, updatedAt: index });
        messages.push({
            id: `message-${index}`,
            sessionId: id,
            role: 'assistant',
            content: index === 4321 ? 'unique performance needle' : `ordinary response ${index}`,
            timestamp: index
        });
    }

    const service = createService();
    await service.ensureBuilt(createDataSource(sessions, messages));
    const startedAt = performance.now();
    const results = await service.search('performance needle');
    const elapsed = performance.now() - startedAt;

    assert.equal(results[0].sessionId, 'session-4321');
    assert.ok(elapsed < 500, `Expected indexed query under 500ms, received ${elapsed.toFixed(1)}ms`);
});
