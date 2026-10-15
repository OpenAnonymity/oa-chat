import test from 'node:test';
import assert from 'node:assert/strict';
import ChatArea from '../../chat/components/ChatArea.js';

for (const path of ['append', 'replace-message', 'replace-typing']) {
    test(`math rendering reaches both parallel answers on ${path}`, async () => {
        const original = { document: globalThis.document, window: globalThis.window, renderer: globalThis.renderMathInElement };
        const lanes = [{ text: String.raw`\(3 - 2 = 1\)` }, { text: String.raw`\(7 + 3 = 10\)` }];
        const rendered = [];
        const root = {
            classList: { add() {} },
            querySelector: selector => selector === '.message-content' ? lanes[0] : null,
            querySelectorAll: selector => selector === '.message-content' ? lanes : []
        };
        let inserted = false;
        const placeholder = { replaceWith(node) { assert.equal(node, root); inserted = true; } };
        const container = {
            querySelector(selector) {
                if (selector.startsWith('[data-message-id')) return inserted ? root : path === 'replace-message' ? placeholder : null;
                if (selector.startsWith('[id^="typing-')) return path === 'replace-typing' ? placeholder : null;
                return null;
            },
            querySelectorAll: () => [],
            insertAdjacentHTML(where, html) {
                assert.match(html, /council-lane-content/);
                inserted = true;
            }
        };
        globalThis.document = { createElement() { return {
            innerHTML: '', firstElementChild: root,
            set textContent(value) { this.innerHTML = String(value ?? ''); }
        }; } };
        globalThis.window = { location: { hostname: 'localhost' }, app: { getDefaultModelName: () => 'Test' } };
        globalThis.renderMathInElement = node => rendered.push(node);
        try {
            const area = Object.create(ChatArea.prototype);
            area.app = {
                elements: { messagesContainer: container }, state: { models: [] },
                getCurrentSession: () => ({ model: 'Test' }),
                processContentWithLatex: text => text, formatTime: () => '',
                updateActivePromptScrollSpacer() {}, updateScrollButtonVisibility() {}
            };
            await area.appendMessage({ id: 'parallel-math', role: 'assistant', model: 'Parallel', timestamp: 1,
                council: { enabled: true, currentStage: 'stage1', stage1: lanes.map((lane, i) => ({
                    laneId: `lane${i}`, label: `Response ${i}`, model: 'Google: Test', status: 'complete', response: lane.text
                })) }
            });
            assert.deepEqual(rendered, lanes);
        } finally {
            globalThis.document = original.document;
            globalThis.window = original.window;
            globalThis.renderMathInElement = original.renderer;
        }
    });
}
