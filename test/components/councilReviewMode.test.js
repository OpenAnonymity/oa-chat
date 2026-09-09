import test from 'node:test';
import assert from 'node:assert/strict';

import { RESPONSE_MODE_COUNCIL, COUNCIL_OUTPUT_PARALLEL, COUNCIL_OUTPUT_SYNTHESIS } from '../../chat/domain/councilConfig.js';

// ChatInput pulls in browser-only modules; load it with a minimal window.
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalStorage = globalThis.localStorage;
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { search: '' } };
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute: () => null, classList: { toggle() {}, contains: () => false } } };
const { default: ChatInput } = await import('../../chat/components/ChatInput.js');
globalThis.window = originalWindow;
globalThis.document = originalDocument;
globalThis.localStorage = originalStorage;

function harness({ session, pending = null } = {}) {
    const calls = [];
    const input = Object.create(ChatInput.prototype);
    input.app = {
        getCurrentSession: () => session,
        getPendingCouncilConfig: () => pending,
        setPendingCouncilConfig: config => { calls.push(['pending', config]); pending = config; },
        setCouncilModeForCurrentSession: async config => {
            calls.push(['session', config]);
            session.responseMode = config.enabled ? RESPONSE_MODE_COUNCIL : 'chat';
            session.councilConfig = { ...config };
        }
    };
    input.getMultiModelMembersForSelection = () => ['a', 'b'];
    input.getCouncilSynthesisModelForSelection = () => 'synth';
    input.persistParallelDefaults = async config => { calls.push(['persist', config]); };
    input.refreshMultiModelSettingsUI = () => {};
    input.updateMemoryToggleUI = () => {};
    return { input, calls, modes: () => calls.filter(([k]) => k === 'session').map(([, c]) => [c.enabled, c.outputMode]) };
}

test('review turned on from Chat enters Parallel, and turning it off returns to Chat', async () => {
    const session = { id: 's1', responseMode: 'chat', councilConfig: null };
    const h = harness({ session });
    await h.input.setCouncilReviewEnabledFromSettings(true);
    await h.input.setCouncilReviewEnabledFromSettings(false);
    assert.deepEqual(h.modes(), [[true, COUNCIL_OUTPUT_SYNTHESIS], [false, COUNCIL_OUTPUT_PARALLEL]]);
    // Both switches are explicit mode changes as far as the saved default goes.
    assert.deepEqual(h.calls.filter(([k]) => k === 'persist').map(([, c]) => c.persistMode), [true, true]);
});

test('a conversation already in Parallel stays in Parallel when review is turned off', async () => {
    const session = { id: 's2', responseMode: RESPONSE_MODE_COUNCIL, councilConfig: { enabled: true, outputMode: COUNCIL_OUTPUT_PARALLEL } };
    const h = harness({ session });
    await h.input.setCouncilReviewEnabledFromSettings(true);
    await h.input.setCouncilReviewEnabledFromSettings(false);
    assert.deepEqual(h.modes(), [[true, COUNCIL_OUTPUT_SYNTHESIS], [true, COUNCIL_OUTPUT_PARALLEL]]);
});

test('choosing Parallel on the composer after review entered it makes Parallel stick', async () => {
    const session = { id: 's3', responseMode: 'chat', councilConfig: null };
    const h = harness({ session });
    await h.input.setCouncilReviewEnabledFromSettings(true);
    // The composer toggle handler clears the memory for this conversation.
    h.input.parallelEnteredByReview.delete(session.id);
    await h.input.setCouncilReviewEnabledFromSettings(false);
    assert.deepEqual(h.modes().at(-1), [true, COUNCIL_OUTPUT_PARALLEL]);
});

test('the memory is per conversation, and covers the no-session (pending) state', async () => {
    const h = harness({ session: null, pending: { enabled: false } });
    await h.input.setCouncilReviewEnabledFromSettings(true);
    assert.equal(h.calls.at(-1)[1].enabled, true);
    await h.input.setCouncilReviewEnabledFromSettings(false);
    assert.equal(h.calls.at(-1)[1].enabled, false, 'back to Chat before any message was sent');
});
