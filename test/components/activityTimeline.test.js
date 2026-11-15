import test from 'node:test';
import assert from 'node:assert/strict';
import { groupVerificationRetries } from '../../chat/services/activityTimeline.js';
import RightPanel from '../../chat/components/RightPanel.js';

const outage = (id, overrides = {}) => ({
    id, timestamp: Number(id) * 60000, sessionId: 'chat-a', type: 'verification',
    url: 'https://verifier.example/submit_key', method: 'POST',
    status: 'verifier-unavailable', detail: 'verifier-unavailable',
    request: { station_id: 'station-a', key_hash: 'a'.repeat(16) }, ...overrides
});

test('minute retries form one stable expandable row without changing raw logs', () => {
    const logs = [outage('3'), outage('2'), outage('1')];
    const snapshot = structuredClone(logs);
    const rows = groupVerificationRetries(logs);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, '1');
    assert.equal(rows[0].timestamp, 60000);
    assert.equal(rows[0].verificationChecks, 3);
    assert.equal(rows[0].lastCheckTimestamp, 180000);
    assert.deepEqual(logs, snapshot);
    const panel = Object.create(RightPanel.prototype);
    panel.escapeHtml = value => String(value);
    panel.app = { services: { networkLogger: { getResponseSummary: () => '' } } };
    const details = panel.generateExpandedDetailsHTML(rows[0]);
    assert.match(details, /3 checks · Last checked/);
    assert.match(details, /unverified key/);
});

test('different keys, chats, stations, verifier origins and malformed identity stay separate', () => {
    for (const overrides of [
        { request: { station_id: 'station-a', key_hash: 'b'.repeat(16) } },
        { request: { station_id: 'station-b', key_hash: 'a'.repeat(16) } },
        { sessionId: 'chat-b' }, { url: 'https://other.example/submit_key' },
        { request: {} }, { request: { station_id: 'station-a', key_hash: 'invalid' } },
        { isAborted: true }, { error: 'Request failed' }
    ]) {
        assert.equal(groupVerificationRetries([outage('2', overrides), outage('1')]).length, 2);
    }
});

test('approval, refusal, advisory verdict and intervening activity remain visible and break grouping', () => {
    for (const overrides of [
        { status: 200, detail: '', response: { status: 'verified' } },
        { status: 403, detail: 'banned' },
        { detail: 'verifier-unverified-advisory' },
        { type: 'api-key', status: 200, detail: '' },
        { type: 'openrouter', status: 200, detail: '' }
    ]) {
        const logs = [outage('3'), outage('2', overrides), outage('1')];
        assert.deepEqual(groupVerificationRetries(logs), logs);
    }
});

test('collapsed retries preserve scroll and do not announce a new activity row', () => {
    const originalWindow = globalThis.window;
    let listener;
    let logs = [outage('1')];
    const renders = [];
    let scrolls = 0;
    let announcements = 0;
    globalThis.window = { addEventListener() {} };
    try {
        const panel = Object.create(RightPanel.prototype);
        Object.assign(panel, {
            networkLogs: logs, previousLogCount: 1,
            app: { services: { networkLogger: {
                subscribe(fn) { listener = fn; }, getAllLogs: () => logs
            } }, floatingPanel: { updateWithLog() { announcements++; } } },
            renderLogsOnly(preserve) { renders.push(preserve); },
            scrollToBottomInstant() { scrolls++; }
        });
        panel.setupEventListeners();
        logs = [outage('2'), ...logs];
        listener();
        assert.deepEqual(renders, [true]);
        assert.equal(scrolls, 0);
        assert.equal(announcements, 0);
        logs = [outage('3', { status: 200, detail: '' }), ...logs];
        listener();
        assert.deepEqual(renders, [true, false]);
        assert.equal(scrolls, 1);
        assert.equal(announcements, 1);
    } finally {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
    }
});
