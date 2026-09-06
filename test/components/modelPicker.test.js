import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
};

const { default: ModelPicker } = await import('../../chat/components/ModelPicker.js');

function createModelPicker({ selectionMode = 'primary' } = {}) {
    const app = {
        state: {
            models: [
                { id: 'openai/primary', name: 'OpenAI: Primary', provider: 'OpenAI', category: 'Pinned' },
                { id: 'anthropic/secondary', name: 'Anthropic: Secondary ', provider: 'Anthropic', category: 'Pinned' },
                { id: 'google/other', name: 'Google: Other', provider: 'Google', category: 'Pinned' }
            ],
            modelsLoading: false,
            modelsVersion: 1
        },
        reasoningEnabled: true,
        elements: {},
        getCurrentSession: () => ({ id: 'session-1', model: 'OpenAI: Primary' }),
        getPrimaryModelName: () => 'OpenAI: Primary',
        getCouncilSecondaryModelName: () => 'Anthropic: Secondary',
        getCouncilSynthesisModelName: () => '',
        normalizeModelName: (modelName) => modelName
    };
    const picker = new ModelPicker(app);
    picker.selectionMode = selectionMode;
    return picker;
}

test('primary model picker allows selecting the active secondary model', () => {
    const picker = createModelPicker({ selectionMode: 'primary' });
    const modelNames = picker.filterModels('').map((model) => model.name.trim());

    assert.deepEqual(modelNames, ['OpenAI: Primary', 'Anthropic: Secondary', 'Google: Other']);
});

test('secondary model picker allows selecting the active primary model', () => {
    const picker = createModelPicker({ selectionMode: 'council-secondary' });
    const modelNames = picker.filterModels('').map((model) => model.name.trim());

    assert.deepEqual(modelNames, ['OpenAI: Primary', 'Anthropic: Secondary', 'Google: Other']);
});

test('ordinary model rows retain ticket prices without a product presenter', () => {
    const picker = createModelPicker();
    const html = picker.buildModelOptionHTML(picker.app.state.models[0]);
    assert.match(html, /title="\d+ tickets?"/);
    assert.match(html, /data-model-name="OpenAI: Primary"/);
    assert.match(html, /bg-accent/);
});

test('product pricing replaces only the ticket badge and safely escapes its copy', () => {
    const picker = createModelPicker();
    let suppliedModel;
    picker.app.presentation = {
        getModelPricing(model) {
            suppliedModel = model;
            return { label: '$1 <input>', description: 'Input " per token <script>' };
        }
    };
    const model = picker.app.state.models[0];
    const html = picker.buildModelOptionHTML(model);
    assert.equal(suppliedModel, model);
    assert.match(html, /\$1 &lt;input&gt;/);
    assert.match(html, /title="Input &quot; per token &lt;script&gt;"/);
    assert.doesNotMatch(html, /title="\d+ tickets?"|<input>|<script>/);
    assert.match(html, /data-model-name="OpenAI: Primary"/);
    assert.match(html, /bg-accent/);
});
