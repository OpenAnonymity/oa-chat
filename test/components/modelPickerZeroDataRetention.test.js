import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
};

const { default: ModelPicker } = await import('../../chat/components/ModelPicker.js');
const { zeroDataRetention } = await import('../../chat/services/zeroDataRetention.js');

const LIST = { data: [
    { model_id: 'openai/primary', tag: 'azure', safety_retention: false },
    { model_id: 'google/other', tag: 'google-ai-studio', safety_retention: true }
] };

async function useList() {
    zeroDataRetention.configure({ settingsStore: { saveSetting: async () => {}, getSetting: async () => undefined },
        fetchJson: async () => LIST });
    await zeroDataRetention.ensureCatalog({ force: true });
}

function createPicker() {
    const app = {
        state: {
            models: [
                { id: 'openai/primary', name: 'OpenAI: Primary', provider: 'OpenAI', category: 'Pinned' },
                { id: 'google/other', name: 'Google: Other', provider: 'Google', category: 'Pinned' }
            ],
            modelsLoading: false,
            modelsVersion: 1
        },
        reasoningEnabled: true,
        elements: {},
        cachedModelDisplayMetadata: [],
        getCurrentSession: () => ({ id: 'session-1', model: 'OpenAI: Primary' }),
        getPrimaryModelName: () => 'OpenAI: Primary',
        normalizeModelName: name => name
    };
    return new ModelPicker(app);
}

afterEach(async () => { await zeroDataRetention.setEnabled(false); });

test('model shields appear only while ZDR is enabled and disappear when turned off', async () => {
    await useList();
    await zeroDataRetention.setEnabled(false);
    const picker = createPicker();
    const eligible = () => picker.buildModelOptionHTML(picker.app.state.models[0]);
    const ineligible = () => picker.buildModelOptionHTML(picker.app.state.models[1]);
    assert.doesNotMatch(eligible(), /zdr-shield-wrap|Supports zero data retention/);
    assert.doesNotMatch(ineligible(), /zdr-shield-wrap|aria-disabled/);
    await zeroDataRetention.setEnabled(true);
    assert.match(eligible(), /title="Supports zero data retention"/);
    assert.doesNotMatch(eligible(), /aria-disabled/);
    assert.doesNotMatch(ineligible(), /zdr-shield-wrap/);
    assert.match(ineligible(), /aria-disabled="true"/);
    await zeroDataRetention.setEnabled(false);
    assert.doesNotMatch(eligible(), /zdr-shield-wrap/);
    assert.doesNotMatch(ineligible(), /aria-disabled/);
});

test('with the switch on, models without a ZDR provider are listed but cannot be chosen', async () => {
    await useList();
    await zeroDataRetention.setEnabled(true);
    const picker = createPicker();
    const other = picker.buildModelOptionHTML(picker.app.state.models[1]);
    assert.match(other, /aria-disabled="true"/);
    assert.match(other, /zdr-unavailable/);
    assert.match(other, /<span class="sr-only">No zero data retention providers<\/span>/);
    assert.doesNotMatch(picker.buildModelOptionHTML(picker.app.state.models[0]), /aria-disabled/);
});

test('keyboard navigation and Enter skip blocked rows', () => {
    const picker = createPicker();
    let selector = '';
    picker.app.elements.modelsList = { querySelectorAll: query => { selector = query; return []; } };
    picker.getModelOptions();
    assert.equal(selector, '.model-option:not([aria-disabled="true"])');
});

test('the composer button never shows a ZDR shield while the picker keeps it', async () => {
    await useList();
    const picker = createPicker();
    const button = { innerHTML: '', title: '', classList: { add() {} }, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
    picker.app.elements.modelPickerBtn = button;
    picker.renderCurrentModel();
    assert.doesNotMatch(button.innerHTML, /zdr-shield/);
    await zeroDataRetention.setEnabled(true);
    picker.renderCurrentModel();
    assert.doesNotMatch(button.innerHTML, /zdr-shield/);
    assert.match(picker.buildModelOptionHTML(picker.app.state.models[0]), /zdr-shield/);
    assert.match(button.attributes['aria-label'], /zero data retention on/);
});
