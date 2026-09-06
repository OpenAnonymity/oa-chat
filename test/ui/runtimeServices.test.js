import test from 'node:test';
import assert from 'node:assert/strict';

const storage = { getItem: () => null, setItem() {}, removeItem() {} };
const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
globalThis.window = { ...events, location, localStorage: storage, sessionStorage: storage };
globalThis.document = { ...events, querySelector: () => null, getElementById: () => null,
    documentElement: { classList: { contains: () => false }, dataset: {} } };
globalThis.fetch = async () => { throw new Error('UI service wiring tests must not use the network.'); };

const { default: preferencesStore } = await import('../../chat/services/preferencesStore.js');
const getPreference = preferencesStore.getPreference;
preferencesStore.getPreference = async () => false;
const { default: VanillaChatUi } = await import('../../chat/ui/vanilla/VanillaChatUi.js');
const { default: defaultInferenceService } = await import('../../chat/services/inference/inferenceService.js');
await new Promise(resolve => setTimeout(resolve, 0));
preferencesStore.getPreference = getPreference;

test('the shared UI uses exactly the runtime inference service used by the app', () => {
    const inferenceService = { getAccessInfo() {}, getBackend() {}, clearAccessInfo() {} };
    const ui = new VanillaChatUi({ elements: {}, state: {}, inferenceService });
    assert.equal(ui.interfaces.componentApp.services.inference, inferenceService);
});

test('ordinary OA keeps its inference service and explicit composition overrides remain supported', () => {
    const app = { elements: {}, state: {} };
    assert.equal(new VanillaChatUi(app).interfaces.componentApp.services.inference, defaultInferenceService);
    const explicitService = {};
    assert.equal(new VanillaChatUi(app, { inferenceServiceImpl: explicitService }).interfaces.componentApp.services.inference, explicitService);
});
