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

for (const [selectionMode, action] of [
    ['primary', 'selectModel'],
    ['council-secondary', 'selectCouncilSecondaryModel'],
    ['council-synthesis', 'selectCouncilSynthesisModel'],
]) {
    test(`${selectionMode} keeps the composer covered until model selection applies`, async () => {
        const picker = createModelPicker({ selectionMode });
        let resolve, selected = 'old', closed = false;
        const saving = new Promise(done => { resolve = done; });
        picker.app.actions = { [action]: async model => { await saving; selected = model; } };
        picker.close = () => { closed = true; assert.equal(selected, 'new'); };
        const choosing = picker.selectModel('new');
        await Promise.resolve();
        assert.equal(closed, false, 'an immediate Send must not be exposed with the old selection');
        resolve();
        await choosing;
        assert.equal(closed, true);
    });
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

test('Council search offers pinned models only and still excludes disabled models', () => {
    const picker = createModelPicker({ selectionMode: 'council-synthesis' });
    picker.pinnedModels = ['anthropic/secondary', 'openai/primary'];
    picker.disabledModels = new Set(['openai/primary']);
    assert.deepEqual(picker.filterModels('').map(model => model.id), ['anthropic/secondary']);
    assert.deepEqual(picker.filterModels('google'), []);
    assert.equal(picker.filterModels('anthropic secondary').length, 1);
});

test('Council picker reports unavailable pins without exposing the full catalog', () => {
    const picker = createModelPicker({ selectionMode: 'council-synthesis' });
    picker.pinnedModels = ['missing/model'];
    picker.app.elements.modelsList = { innerHTML: '', querySelectorAll: () => [] };
    picker.renderModels('');
    assert.match(picker.app.elements.modelsList.innerHTML, /No pinned models are available for Council/);
    assert.doesNotMatch(picker.app.elements.modelsList.innerHTML, /data-model-name/);
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

test('model search gives feedback for no matches and recovers when the query clears', () => {
    const picker = createModelPicker();
    picker.app.elements.modelsList = { innerHTML: '', querySelectorAll: () => [] };
    picker.renderModels('zzzz-no-match');
    assert.match(picker.app.elements.modelsList.innerHTML, /role="status"/);
    assert.match(picker.app.elements.modelsList.innerHTML, /No models match your search/);
    assert.equal(picker.highlightedIndex, -1);
    picker.renderModels('');
    assert.match(picker.app.elements.modelsList.innerHTML, /OpenAI: Primary/);
    assert.doesNotMatch(picker.app.elements.modelsList.innerHTML, /No models match/);
});

test('an empty settled model catalog does not spin forever', () => {
    const picker = createModelPicker();
    picker.app.elements.modelsList = { innerHTML: '', querySelectorAll: () => [] };
    picker.app.state.models = [];
    picker.app.state.modelsLoading = true;
    picker.renderModels();
    assert.match(picker.app.elements.modelsList.innerHTML, /Loading models/);
    picker.app.state.modelsLoading = false;
    picker.renderModels();
    assert.match(picker.app.elements.modelsList.innerHTML, /No models are available/);
    assert.doesNotMatch(picker.app.elements.modelsList.innerHTML, /Loading models|modelpicker-spin/);
});

function interactivePicker(t, { touch = true, keyboard = false } = {}) {
    const picker = createModelPicker();
    const frames = [];
    t.mock.method(globalThis, 'requestAnimationFrame', callback => frames.push(callback));
    const focused = [];
    const handlers = new Map();
    const focusable = name => ({ focus: () => focused.push(name), value: '',
        addEventListener: (event, callback) => handlers.set(`${name}:${event}`, callback) });
    const hidden = new Set(['hidden']);
    const dialog = focusable('dialog');
    const modal = {
        classList: { contains: key => hidden.has(key), add: key => hidden.add(key), remove: key => hidden.delete(key) },
        dataset: {},
        ownerDocument: { defaultView: { matchMedia: () => ({ matches: touch }) },
            documentElement: { hasAttribute: () => keyboard } },
        querySelector: () => dialog,
        addEventListener() {}
    };
    let html = '', writes = 0;
    picker.app.elements = {
        modelPickerModal: modal,
        modelSearch: focusable('search'), messageInput: focusable('composer'),
        modelPickerBtn: focusable('trigger'), closeModalBtn: focusable('close'),
        modelListScrollArea: { scrollTop: 0 },
        modelsList: { get innerHTML() { return html; }, set innerHTML(value) { html = value; writes++; },
            querySelectorAll: () => [], addEventListener() {} }
    };
    return { picker, focused, handlers, flush: () => frames.splice(0).forEach(fn => fn()), writes: () => writes };
}

// The browser provides RAF. Keep the Node fixture local to these lifecycle tests.
globalThis.requestAnimationFrame ??= () => {};

test('touch opening/closing leaves text fields unfocused and restores the list position', t => {
    const { picker, focused, flush } = interactivePicker(t);
    picker.savedScrollTop = 500;
    picker.open(); flush();
    assert.deepEqual(focused, ['dialog']);
    assert.equal(picker.app.elements.modelListScrollArea.scrollTop, 500);
    picker.close(); flush();
    assert.deepEqual(focused, ['dialog', 'trigger']);
});

test('desktop and deliberate hardware-keyboard opening still focus model search', t => {
    for (const options of [{ touch: false }, { touch: true, keyboard: true }]) {
        const { picker, focused, flush } = interactivePicker(t, options);
        picker.open(); flush();
        assert.equal(focused[0], 'search');
    }
});

test('closing before the opening frame cannot bring back the search keyboard', t => {
    const { picker, focused, flush } = interactivePicker(t, { touch: false });
    picker.open(); picker.close(); flush();
    assert.deepEqual(focused, ['composer']);
});

test('keyboard shortcut can focus search after touch cleared keyboard modality', t => {
    const { picker, focused, flush } = interactivePicker(t, { touch: true, keyboard: false });
    picker.toggle({ focusSearch: true }); flush();
    picker.toggle({ selectionMode: 'council-secondary', focusSearch: true }); flush();
    picker.toggle({ selectionMode: 'council-synthesis', focusSearch: true }); flush();
    assert.deepEqual(focused, ['search', 'search', 'search']);
    picker.close(); flush();
    assert.equal(focused.at(-1), 'composer');
    picker.open(); flush(); picker.close(); flush();
    assert.equal(focused.at(-1), 'trigger', 'a later touch opening must not inherit keyboard focus');
    const app = fs.readFileSync('chat/app.js', 'utf8');
    assert.match(app, /modelPicker\.toggle\(\{ focusSearch: true \}\)/);
    for (const mode of ['council-secondary', 'council-synthesis']) {
        assert.ok(app.includes(`modelPicker.toggle({ selectionMode: '${mode}', focusSearch: true })`));
    }
});

test('reopening before the close frame cannot focus the composer behind the picker', t => {
    const { picker, focused, flush } = interactivePicker(t, { touch: false });
    picker.open(); flush();
    picker.close(); picker.open(); flush();
    assert.deepEqual(focused, ['search', 'search']);
});

test('a pending search cannot replace the list after closing', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { picker, handlers, writes } = interactivePicker(t);
    picker.setupEventListeners(); picker.open();
    handlers.get('search:input')({ target: { value: 'no matches' } });
    picker.close();
    const before = writes();
    t.mock.timers.tick(100);
    assert.equal(writes(), before);
});

test('switching selection mode discards the previous debounced search', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { picker, handlers } = interactivePicker(t);
    picker.setupEventListeners(); picker.open();
    picker.app.elements.modelSearch.value = 'no matches';
    handlers.get('search:input')({ target: { value: 'no matches' } });
    picker.pinnedModels = ['openai/primary'];
    picker.open({ selectionMode: 'council-synthesis' });
    t.mock.timers.tick(100);
    assert.equal(picker.app.elements.modelSearch.value, '');
    assert.match(picker.app.elements.modelsList.innerHTML, /OpenAI: Primary/);
    assert.doesNotMatch(picker.app.elements.modelsList.innerHTML, /No models match/);
});

test('unchanged catalog refresh retains rows, while pricing and search changes replace them', () => {
    const picker = createModelPicker();
    let writes = 0, html;
    picker.app.elements.modelsList = { set innerHTML(value) { html = value; writes++; }, querySelectorAll: () => [] };
    picker.renderModels('', true, true);
    picker.renderModels('', true, true);
    assert.equal(writes, 1, 'unchanged refresh must not replace scrolling rows');
    let price = '$1';
    picker.app.presentation = { getModelPricing: () => ({ label: price, description: 'Synthetic price' }) };
    picker.renderModels('', true, true);
    assert.equal(writes, 2);
    price = '$2';
    picker.renderModels('', true, true);
    assert.equal(writes, 3);
    assert.match(html, /\$2/);
    picker.renderModels('no matches');
    assert.equal(writes, 4);
    assert.match(html, /No models match/);
});
