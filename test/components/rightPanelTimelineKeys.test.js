import test from 'node:test';
import assert from 'node:assert/strict';

// The panel and the inference service are loaded the way runtimeServices.test.js
// loads them: browser globals stubbed, no network.
const storage = { getItem: () => null, setItem() {}, removeItem() {} };
const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
globalThis.window = { ...events, location, localStorage: storage, sessionStorage: storage };
globalThis.document = { ...events, querySelector: () => null, getElementById: () => null,
    documentElement: { classList: { contains: () => false }, dataset: {} } };
globalThis.fetch = async () => { throw new Error('Timeline tests must not use the network.'); };

const { default: RightPanel } = await import('../../chat/components/RightPanel.js');
const { default: inferenceService } = await import('../../chat/services/inference/inferenceService.js');
// The real masking and ephemeral-id lookup; access is read straight from the
// fixture sessions (a verifier proof is not what these tests are about).
const inference = Object.create(inferenceService);
inference.getAccessInfo = session => (session?.apiKey ? { token: session.apiKey, info: session.apiKeyInfo || null } : null);
const { NetworkLogger } = await import('../../chat/services/networkLogger.js');

const OLD_KEY = 'sk-or-v1-older-conversation-key-AAAA1111';
const NEW_KEY = 'sk-or-v1-current-conversation-key-BBBB2222';
const RETIRED_KEY = 'sk-or-v1-retired-key-of-the-older-chat-CCCC3333';

function session(id, title, key, ephemeralId, extraMappings = {}) {
    return {
        id, title, apiKey: key, apiKeyInfo: { key, verifierApproved: true, verification: 'verified' },
        currentEphemeralKeyId: ephemeralId,
        ephemeralKeyMappings: { [ephemeralId]: { underlyingKeyId: key, backendId: 'openrouter', createdAt: 1 }, ...extraMappings }
    };
}

function createPanel() {
    const older = session('old', 'Older chat', OLD_KEY, 'olderkeyid0001',
        { retiredid000009: { underlyingKeyId: RETIRED_KEY, backendId: 'openrouter', createdAt: 0 } });
    const current = session('cur', 'Current chat', NEW_KEY, 'currkeyid00002');
    const panel = Object.create(RightPanel.prototype);
    panel.expandedLogIds = new Set();
    panel.escapeHtml = value => String(value);
    panel.escapeHtmlAttribute = value => String(value);
    panel.currentSession = current;
    panel.app = {
        state: { sessions: [older, current], sessionsById: new Map([[older.id, older], [current.id, current]]) },
        services: { inference }
    };
    return { panel, older, current };
}

const entry = (id, sessionId, extra = {}) => ({
    id, sessionId, type: 'openrouter', method: 'POST', url: 'https://openrouter.ai/api/v1/chat/completions',
    status: 200, timestamp: 1000 + id.length, request: {}, response: {}, ...extra
});

function separators(html) {
    return [...html.matchAll(/<div class="session-separator[\s\S]*?<\/div>\s*<\/div>/g)].map(m => m[0]);
}

test('an older conversation keeps its own key label, not the current conversation\'s', () => {
    const { panel, older, current } = createPanel();
    panel.networkLogs = [entry('b', 'cur'), entry('a', 'old')]; // newest first, as the logger stores them
    const html = panel.renderNetworkLogs();
    const [olderSeparator, currentSeparator] = separators(html);
    assert.match(olderSeparator, /Older chat/);
    assert.match(olderSeparator, new RegExp(inference.formatEphemeralKeyId(older.currentEphemeralKeyId)));
    assert.doesNotMatch(olderSeparator, new RegExp(inference.formatEphemeralKeyId(current.currentEphemeralKeyId)));
    assert.match(currentSeparator, /Current chat/);
    assert.match(currentSeparator, new RegExp(inference.formatEphemeralKeyId(current.currentEphemeralKeyId)));
});

test('an entry that recorded its key is labelled with that key after the session moved on', () => {
    const { panel, older } = createPanel();
    const retiredRef = new NetworkLogger().keyRefForToken(RETIRED_KEY);
    panel.networkLogs = [entry('later', 'old'), entry('earlier', 'old', { keyRef: retiredRef })];
    const html = panel.renderNetworkLogs();
    const [earlier, later] = separators(html);
    assert.match(earlier, new RegExp(inference.formatEphemeralKeyId('retiredid000009')));
    assert.match(later, new RegExp(inference.formatEphemeralKeyId(older.currentEphemeralKeyId)));
    assert.doesNotMatch(html, /CCCC3333|AAAA1111|BBBB2222/, 'no key material in the timeline');
});

test('a recorded key the session no longer knows shows only its reference', () => {
    const { panel } = createPanel();
    panel.networkLogs = [entry('x', 'old', { keyRef: '9999' })];
    assert.match(panel.renderNetworkLogs(), />\.\.\.9999</);
});

test('the logger records the key reference from the raw Authorization header and never the key', () => {
    const logger = new NetworkLogger();
    const log = logger.logRequest({
        type: 'openrouter', method: 'POST', url: 'https://openrouter.ai/api/v1/chat/completions', status: 200,
        request: { headers: { Authorization: `Bearer ${OLD_KEY}` } }
    });
    assert.equal(log.keyRef, 'AAAA1111'.slice(-4));
    assert.doesNotMatch(JSON.stringify(log), new RegExp(OLD_KEY));
    assert.equal(logger.keyRefForHeaders({ authorization: 'Bearer [REDACTED]' }), '');
    assert.equal(logger.keyRefForToken('short'), '');
    const explicit = logger.logRequest({ type: 'openrouter', keyRef: '2222', request: { headers: {} } });
    assert.equal(explicit.keyRef, '2222');
});
