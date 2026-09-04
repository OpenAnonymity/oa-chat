import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

test('model search replaces the automatic full outline with an accent underline', () => {
    const html = fs.readFileSync('chat/index.html', 'utf8');
    const fixture = fs.readFileSync('test/fixtures/model-picker-focus.html', 'utf8');
    const css = fs.readFileSync('chat/styles.css', 'utf8');

    assert.match(html, /class="model-picker-search [^"]*" cmdk-input-wrapper=""/);
    assert.match(fixture, /id="model-search"[^>]*autofocus/);
    assert.match(css, /--color-focus-ring: var\(--blue-500\)/);
    assert.match(css, /--tw-ring-color: hsl\(var\(--color-focus-ring\)\)/);
    assert.match(css, /\.model-picker-search:has\(> #model-search:focus\)\s*\{[^}]*box-shadow: inset 0 -2px 0 hsl\(var\(--color-focus-ring\)\)/);
    assert.match(css, /#model-search:focus,\s*#model-search:focus-visible\s*\{\s*outline: none/);
    assert.match(css, /@media \(forced-colors: active\)\s*\{\s*#model-search:focus-visible\s*\{[^}]*outline: 2px solid Highlight/);
    assert.match(css, /\.account-login-control:focus-within\s*\{[^}]*border-color: hsl\(var\(--color-focus-ring\)/);
    assert.match(css, /\.pin-input-container:focus-within \.pin-box\.active\s*\{[^}]*border-color: hsl\(var\(--color-focus-ring\)\)/);

    const tailwindConfig = fs.readFileSync('tailwind.config.js', 'utf8');
    const shareModals = fs.readFileSync('chat/components/ShareModals.js', 'utf8');
    assert.match(tailwindConfig, /ring: 'hsl\(var\(--color-focus-ring\)\)'/);
    assert.doesNotMatch(shareModals, /focus:ring-primary/);
});
