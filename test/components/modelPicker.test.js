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

test('ordinary model rows retain ticket prices without a product presenter', () => {
    const picker = createModelPicker();
    const html = picker.buildModelOptionHTML(picker.app.state.models[0]);
    assert.match(html, /title="\d+ tickets?"/);
    assert.match(html, /data-model-name="OpenAI: Primary"/);
    assert.match(html, /bg-accent/);
    assert.doesNotMatch(html, /data-model-balance-badge/);
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

test('optional minimum-balance badges use ticket styling and receive captured reasoning context', () => {
    const picker = createModelPicker();
    picker.app.reasoningEnabled = false;
    let suppliedOptions;
    picker.app.presentation = {
        getModelPricing(_model, options) {
            suppliedOptions = options;
            return {
                balanceBadgeLabel: '≥ $4.50 <balance>',
                balanceBadgeTooltip: 'Proof "threshold" <details>',
                label: '$10/M input · $50/M output',
                description: 'Per-token rates'
            };
        }
    };
    const html = picker.buildModelOptionHTML(picker.app.state.models[0]);
    assert.deepEqual(suppliedOptions, { reasoningEnabled: false });
    const badge = html.match(/<span data-model-balance-badge[^>]*>[\s\S]*?<\/span>/)?.[0];
    assert.ok(badge);
    assert.match(badge, /≥ \$4\.50 &lt;balance&gt;/);
    assert.match(badge, /title="Proof &quot;threshold&quot; &lt;details&gt;"/);
    const ordinary = createModelPicker().buildModelOptionHTML(picker.app.state.models[0]);
    const ticketClass = ordinary.match(/<span class="([^"]+)" title="\d+ tickets?"/)?.[1];
    assert.ok(ticketClass);
    assert.equal(badge.match(/class="([^"]+)"/)?.[1], ticketClass);
    assert.match(html, /title="Per-token rates">\$10\/M input · \$50\/M output/);
    assert.doesNotMatch(html, /data-model-budget-label/);
    assert.doesNotMatch(html, /title="\d+ tickets?"|<balance>|<details>/);
});

test('model search replaces automatic focus with a keyboard-only accent underline', () => {
    const html = fs.readFileSync('chat/index.html', 'utf8');
    const fixture = fs.readFileSync('test/fixtures/model-picker-focus.html', 'utf8');
    const css = fs.readFileSync('chat/styles.css', 'utf8');

    assert.match(html, /class="model-picker-search [^"]*" cmdk-input-wrapper=""/);
    assert.match(fixture, /id="model-search"[^>]*autofocus/);
    assert.match(css, /--color-focus-ring: var\(--blue-500\)/);
    assert.match(css, /--tw-ring-color: hsl\(var\(--color-focus-ring\)\)/);
    assert.match(css, /\.model-picker-search:has\(> #model-search:focus\)\s*\{[^}]*box-shadow: none/);
    assert.match(css, /html\[data-keyboard-nav\] \.model-picker-search:has\(> #model-search:focus-visible\)\s*\{[^}]*box-shadow: inset 0 -2px 0 hsl\(var\(--color-focus-ring\)\)/);
    assert.match(css, /#model-search:focus,\s*#model-search:focus-visible\s*\{\s*outline: none/);
    assert.match(css, /@media \(forced-colors: active\)\s*\{\s*html\[data-keyboard-nav\] #model-search:focus-visible\s*\{[^}]*outline: 2px solid Highlight/);
    assert.match(css, /html\[data-keyboard-nav\] \.account-login-control:focus-within\s*\{[^}]*border-color: hsl\(var\(--color-focus-ring\)/);
    assert.match(css, /\.pin-input-container:focus-within \.pin-box\.active\s*\{[^}]*border-color: hsl\(var\(--color-focus-ring\)\)/);

    const tailwindConfig = fs.readFileSync('tailwind.config.js', 'utf8');
    const shareModals = fs.readFileSync('chat/components/ShareModals.js', 'utf8');
    assert.match(tailwindConfig, /ring: 'hsl\(var\(--color-focus-ring\)\)'/);
    assert.doesNotMatch(shareModals, /focus:ring-primary/);
});
