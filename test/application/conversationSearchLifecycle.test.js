import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSource = fs.readFileSync(path.join(process.cwd(), 'chat/app.js'), 'utf8');

function methodSource(name, nextSignature) {
    const start = appSource.indexOf(`    async ${name}(`);
    const end = appSource.indexOf(`    ${nextSignature}`, start + 1);
    assert.notEqual(start, -1, `Expected ${name} method`);
    assert.notEqual(end, -1, `Expected ${nextSignature} boundary`);
    return appSource.slice(start, end);
}

test('session reload invalidates the memory search index for same-tab backup imports', () => {
    const source = methodSource('reloadSessions', 'handleStorageEvent(');
    assert.match(source, /this\.conversationSearch\.invalidate\(\)/);
});

test('forks index the remapped message IDs used by persisted fork messages', () => {
    const source = methodSource('forkConversation', 'async deleteAllChats(');
    assert.match(source, /const forkedMessages = messagesToCopy\.map/);
    assert.match(source, /applySessionConversationSearchText\(newSession, forkedMessages\)/);
    assert.match(source, /for \(const newMessage of forkedMessages\)/);
    assert.doesNotMatch(source, /applySessionConversationSearchText\(newSession, messagesToCopy\)/);
});

test('generated session titles update the ready search index', () => {
    const source = methodSource('generateSessionTitleIfNeeded', 'async addMessage(');
    assert.match(source, /getSessionMessages\(latestSession\.id\)/);
    assert.match(source, /conversationSearch\.upsertSession\(latestSession, latestMessages\)/);
});

test('opening any mobile search result closes the sidebar before title-only navigation returns', () => {
    const source = methodSource('openSessionSearchMatch', 'async toggleSessionStar(');
    assert.match(
        source,
        /isMobileView\(\)[\s\S]*?hideSidebar\(\)[\s\S]*?if \(!match\?\.messageId\) return/
    );
});

test('cancelled visible partial answers refresh search in regeneration and normal send paths', () => {
    const regeneration = methodSource('regenerateResponse', 'async sendMessage(');
    assert.match(
        regeneration,
        /if \(error\.isCancelled\) \{[\s\S]*?refreshSessionConversationSearchText\(session, null, \{ persist: true \}\)[\s\S]*?\} else \{/
    );

    const send = methodSource('sendMessage', 'async resolveModelForQuickAsk(');
    assert.match(
        send,
        /if \(error\.isCancelled\) \{[\s\S]*?refreshSessionConversationSearchText\(session, null, \{ persist: true \}\)[\s\S]*?break retryLoop/
    );
});
