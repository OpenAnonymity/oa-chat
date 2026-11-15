import { setFeatureUsageReporter } from '../../chat/services/featureUsage.js';
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
const { getPinnedModels } = await import('../../chat/services/modelConfig.js');
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


test('settings analytics count review actions once and exclude the dependent Parallel changes', async () => {
    const events = [];
    setFeatureUsageReporter(code => events.push(code));
    try {
        for (const session of [null, { id: 's1', responseMode: 'chat', councilConfig: null }]) {
            const h = harness({ session, pending: { enabled: false } });
            await h.input.setCouncilReviewEnabledFromSettings(true);
            await h.input.setCouncilReviewEnabledFromSettings(true);
            await h.input.setCouncilReviewEnabledFromSettings(false);
            assert.deepEqual(events.splice(0), ['settings_changed', 'default_changed', 'setting_council_away', 'settings_changed', 'setting_council_back']);
            await Promise.all([h.input.setCouncilModeFromComposer(true), h.input.setCouncilModeFromComposer(true)]);
            await h.input.setCouncilModeFromComposer(false);
            assert.deepEqual(events.splice(0), ['settings_changed', 'default_changed', 'setting_parallel_away', 'settings_changed', 'setting_parallel_back']);
            h.input.persistParallelDefaults = async () => { throw new Error('storage failed'); };
            await assert.rejects(h.input.setCouncilModeFromComposer(true), /storage failed/);
            await assert.rejects(h.input.setCouncilReviewEnabledFromSettings(true), /storage failed/);
            assert.deepEqual(events, []);
        }
    } finally { setFeatureUsageReporter(null); }
});


test('an existing Chat session does not inherit the pending draft Council analytics state', async () => {
    const events = [];
    setFeatureUsageReporter(code => events.push(code));
    try {
        const h = harness({ session: { id: 'existing', responseMode: 'chat', councilConfig: null },
            pending: { enabled: true, outputMode: COUNCIL_OUTPUT_SYNTHESIS } });
        await h.input.setCouncilReviewEnabledFromSettings(true);
        assert.deepEqual(events, ['settings_changed', 'default_changed', 'setting_council_away']);
    } finally { setFeatureUsageReporter(null); }
});

test('Council dropdowns use pin order and preserve an unpinned saved choice without selecting it anew', () => {
    const beforeDocument = globalThis.document;
    const controls = Object.fromEntries([
        'council-review-model-select', 'council-synthesis-inline-select', 'multi-model-synthesis-select'
    ].map(id => [id, { innerHTML: '', dataset: {}, setAttribute() {} }]));
    globalThis.document = { getElementById: id => controls[id] || null };
    try {
        const input = Object.create(ChatInput.prototype);
        const [firstId, secondId] = getPinnedModels();
        const first = { id: firstId, name: 'Provider: First pinned' };
        const second = { id: secondId, name: 'Provider: Second pinned' };
        const old = { id: 'unpinned/old', name: 'Provider: Saved <model>' };
        const session = {
            responseMode: RESPONSE_MODE_COUNCIL,
            councilConfig: { enabled: true, outputMode: COUNCIL_OUTPUT_SYNTHESIS, synthesisModel: old.name }
        };
        input.app = {
            state: { models: [second, old, first, { id: 'unpinned/other', name: 'Other unpinned' }] },
            elements: {}, getCurrentSession: () => session
        };
        input.supportsFeature = () => true;
        input.setComposerModeDataset = () => {};
        input.getPrimaryModelName = () => first.name;
        input.refreshMultiModelSettingsUI();
        for (const control of Object.values(controls)) {
            assert.ok(control.innerHTML.includes(`<option value="${first.name}">First pinned</option>`),
                'the visible label omits the provider while the option retains the raw model name');
            assert.ok(control.innerHTML.includes(`<option value="${second.name}">Second pinned</option>`));
            assert.match(control.innerHTML, /selected disabled>Saved &lt;model&gt; \(current\)/);
            assert.doesNotMatch(control.innerHTML, /Other unpinned/);
            assert.ok(control.innerHTML.indexOf(first.name) < control.innerHTML.indexOf(second.name));
            assert.equal(control.disabled, false);
        }
        assert.equal(session.councilConfig.synthesisModel, old.name);
        session.councilConfig.synthesisModel = first.id;
        input.refreshMultiModelSettingsUI();
        assert.doesNotMatch(controls['council-review-model-select'].innerHTML, /Saved|\(current\)/);
        assert.equal(controls['council-review-model-select'].value, first.name);

        input.app.state.models = [old];
        session.councilConfig.synthesisModel = old.name;
        input.refreshMultiModelSettingsUI();
        for (const control of Object.values(controls)) {
            assert.equal(control.disabled, true);
            assert.match(control.innerHTML, /Saved &lt;model&gt; \(current\)/);
        }
        assert.equal(session.councilConfig.synthesisModel, old.name);
    } finally {
        globalThis.document = beforeDocument;
    }
});
