import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDetailedPendingIndicator, updateDetailedPendingIndicator } from '../../chat/components/PendingIndicator.js';
import { createVanillaUiInterface } from '../../chat/ui/appInterface.js';
import { normalizePendingPhase } from '../../chat/domain/streamingState.js';

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem() {}, removeItem() {} }
});
const { default: RightPanel } = await import('../../chat/components/RightPanel.js');
if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
else delete globalThis.localStorage;

test('funding section override retains shared access and proxy sections', () => {
    const panel = Object.create(RightPanel.prototype);
    panel.app = {};
    panel.hasAnyAccessKey = () => true;
    panel.generateFundingSectionHTML = () => '<section>External funding</section>';
    panel.generateAccessKeyPanelHTML = hasKey => `<section>Shared access: ${hasKey}</section>`;
    panel.generateProxySectionHTML = () => '<section>Shared proxy</section>';
    const html = panel.generateTopSectionHTML();
    assert.match(html, /External funding/);
    assert.match(html, /Shared access: true/);
    assert.match(html, /Shared proxy/);
});

test('commercial embedded access is not duplicated after funding seam extraction', () => {
    const panel = Object.create(RightPanel.prototype);
    panel.app = { hasTicketManagementAction: () => true };
    panel.hasAnyAccessKey = () => true;
    panel.generateFundingSectionHTML = () => 'Commercial tickets and embedded key';
    panel.generateAccessKeyPanelHTML = () => { throw new Error('Access already embedded'); };
    panel.generateProxySectionHTML = () => 'Shared proxy';
    assert.match(panel.generateTopSectionHTML(), /Commercial tickets and embedded key/);
});

test('generic preparation presentation escapes untrusted copy in every surface', () => {
    const html = buildDetailedPendingIndicator({
        mode: 'security', current: 'Prepare <img src=x onerror=alert(1)>',
        description: 'Progress " quoted', category: '<script>', note: '<iframe>',
        progressPhase: 'prepare" onmouseover="alert(1)',
        steps: [{ id: 'x"', label: '<img>', state: 'active' }]
    }, { phase: 'preparing-access', traceId: 'session" data-bad="true' });
    assert.doesNotMatch(html, /<img|<script|<iframe|data-bad="true|onmouseover="alert/);
    assert.match(html, /aria-current="step"/);
    assert.match(html, /pending-response-announcement sr-only/);
    assert.match(html, /pending-response-simple hidden/);
    assert.equal(normalizePendingPhase('preparing-access'), 'preparing-access');
});

test('response-ready presentation hides preparation details and shows a single thinking row', () => {
    const html = buildDetailedPendingIndicator({
        mode: 'thinking', current: 'Thinking', description: 'Message sent', steps: []
    }, { phase: 'waiting-response' });
    assert.match(html, /pending-security-trace hidden/);
    assert.match(html, /class="pending-response-simple"/);
    assert.doesNotMatch(html, /user-message|delivery-state|Queued/);
});

test('UI composition exposes only explicitly supplied product capabilities', () => {
    const integration = { getTransition: () => ({ phase: 'working' }) };
    const presentation = { getModelPricing: () => ({ label: 'Example pricing' }) };
    const payments = {};
    const app = { elements: {}, state: {}, privateSecret: 'must stay private' };
    const ui = createVanillaUiInterface(app, { integration, presentation, services: { payments } });
    assert.equal(ui.componentApp.integration, integration);
    assert.equal(ui.componentApp.services.payments, payments);
    assert.equal(ui.componentApp.services.presentation, presentation);
    assert.equal(ui.modelPicker.presentation, presentation);
    assert.equal(ui.sidebar.presentation, presentation);
    assert.equal(ui.componentApp.privateSecret, undefined);
    assert.throws(() => { ui.componentApp.privateSecret = 'replace'; }, /unsupported app field/);
});

test('unchanged preparation snapshots never reset labels or open disclosures', () => {
    let writes = 0;
    const label = { _text: '', get textContent() { return this._text; }, set textContent(value) { writes += 1; this._text = value; } };
    const trace = {
        open: true,
        classList: { toggle() {} },
        querySelector(selector) { return selector === '.pending-response-label' ? label : null; }
    };
    const indicator = {
        dataset: {},
        querySelector(selector) { return selector === '.pending-security-trace' ? trace : null; }
    };
    const presentation = { mode: 'security', current: 'Preparing access', steps: [] };
    updateDetailedPendingIndicator(indicator, presentation, 'preparing-access');
    assert.equal(writes, 1);
    updateDetailedPendingIndicator(indicator, { ...presentation, elapsedSeconds: 1 }, 'preparing-access');
    assert.equal(writes, 1, 'clock-only data must not touch the pending DOM');
    assert.equal(trace.open, true);
    updateDetailedPendingIndicator(indicator, { ...presentation, current: 'Checking access' }, 'preparing-access');
    assert.equal(writes, 2);
    assert.equal(trace.open, true, 'phase updates preserve the open detail state');
});
