import test from 'node:test';
import assert from 'node:assert/strict';
import RightPanel from '../../chat/components/RightPanel.js';

// 2026-10-14: the System Panel's top section was rebuilt from scratch on every
// account notification and every wallet change. Each rebuild replaced the
// network-proxy status icon (restarting its connecting pulse: the "flashing"
// icon), dropped its tooltip, and swapped the Security Details button for a
// new node under the pointer, so a press that landed between two rebuilds
// never became a click. The section now leaves identical markup alone and
// keeps the proxy section's live nodes when its presentation is unchanged.

const unescapeAttr = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Minimal DOM lifecycle model: replacing innerHTML disconnects every child.
// A browser fixture separately checks native clicks, focus and CSS animations.
function topSectionNode() {
    const node = properties => ({
        parentNode: null, detachments: 0, ...properties,
        remove() {
            if (!this.parentNode) return;
            this.detachments += 1;
            this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
            this.parentNode = null;
        },
        replaceWith(next) {
            const parent = this.parentNode;
            parent.insertBefore(next, this);
            this.remove();
        },
        setAttribute(name, value) {
            if (name === 'data-proxy-key') this.dataset.proxyKey = value;
        }
    });
    return {
        writes: 0, childNodes: [], notice: null,
        get proxy() { return this.childNodes.find(child => child.id === 'proxy-section') || null; },
        set innerHTML(html) {
            this.writes += 1;
            for (const child of [...this.childNodes]) child.remove();
            const key = /id="proxy-section"[^>]*data-proxy-key="([^"]*)"/.exec(html)?.[1];
            this.insertBefore(node({ html: html.slice(0, html.indexOf('<div id="proxy-section"')) }), null);
            if (key !== undefined) {
                const toggleTag = /<button\s+id="proxy-toggle-btn"[\s\S]*?>/.exec(html)?.[0] || '';
                const proxy = node({
                    id: 'proxy-section', dataset: { proxyKey: unescapeAttr(key) },
                    toggle: {
                        disabled: /\sdisabled(?:\s|>)/.test(toggleTag), dataset: {},
                        classList: { add() {}, toggle() {} }, setAttribute() {},
                        ownerDocument: { defaultView: { matchMedia: () => ({ matches: true }) } }
                    },
                    icon: {
                        state: /data-proxy-state="([^"]*)"/.exec(html)?.[1],
                        set outerHTML(value) { this.state = /data-proxy-state="([^"]*)"/.exec(value)?.[1]; }
                    }
                });
                this.insertBefore(proxy, null);
            }
        },
        insertBefore(child, reference) {
            child.remove();
            const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
            assert.ok(index >= 0);
            this.childNodes.splice(index, 0, child);
            child.parentNode = this;
        },
        querySelector(selector) {
            if (selector === '#proxy-section') return this.proxy;
            return null;
        }
    };
}

function fixture() {
    const oldDocument = globalThis.document;
    const topSection = topSectionNode();
    const panelContent = { querySelector: selector => (selector === '.flex-shrink-0' ? topSection : null) };
    globalThis.document = {
        activeElement: null,
        getElementById: id => (id === 'right-panel-content' ? panelContent
            : id === 'proxy-section' ? topSection.proxy
                : id === 'proxy-toggle-btn' ? topSection.proxy?.toggle : null),
        querySelector: selector => selector === '.oa-proxy-status-icon' ? topSection.proxy?.icon : null,
        createElement(tag) {
            assert.equal(tag, 'template');
            return { content: topSectionNode(), set innerHTML(html) { this.content.innerHTML = html; } };
        },
        addEventListener() {}, removeEventListener() {}
    };
    const panel = Object.create(RightPanel.prototype);
    Object.assign(panel, {
        ticketCount: 5, showProxyInfo: false, proxyActionPending: false,
        proxySettings: { enabled: true }, proxyStatus: { ready: true, connectionVerified: true, usingProxy: true },
        escapeHtml: value => String(value ?? ''),
        generateFundingSectionHTML() { return `<div class="funding">${this.ticketCount} tickets</div>`; },
        fundingSectionIncludesAccessKey: () => true,
        attached: 0,
        attachTopSectionEventListeners() { this.attached += 1; },
        ensureLaneExpirationTimer() {}
    });
    panel.app = { services: { networkProxy: { getTlsInfo: () => ({ version: 'TLSv1.3' }), hasActiveRequests: () => false } }, refreshExtensionSlot() {} };
    return { panel, topSection, cleanup() { globalThis.document = oldDocument; } };
}

test('a notification that changes nothing leaves the top section DOM alone', () => {
    const f = fixture();
    try {
        f.panel.renderTopSectionOnly();
        assert.equal(f.topSection.writes, 1);
        const proxy = f.topSection.proxy;
        f.panel.renderTopSectionOnly();
        f.panel.renderTopSectionOnly();
        assert.equal(f.topSection.writes, 1, 'identical markup is not written again');
        assert.equal(f.topSection.proxy, proxy);
        assert.equal(f.panel.attached, 3, 'listeners are still (re)attached each time');
    } finally { f.cleanup(); }
});

test('wallet changes never detach the proxy section and do update the ticket count', () => {
    const f = fixture();
    try {
        f.panel.renderTopSectionOnly();
        const proxy = f.topSection.proxy;
        f.panel.ticketCount = 4;
        f.panel.renderTopSectionOnly();
        assert.match(f.topSection.childNodes[0].html, /4 tickets/);
        assert.equal(proxy.detachments, 0, 'same object is insufficient: it must stay attached');
        assert.equal(f.topSection.proxy, proxy, 'the proxy section (icon, tooltip, buttons) is the same node');
    } finally { f.cleanup(); }
});

test('a proxy status change replaces the proxy section', () => {
    const f = fixture();
    try {
        f.panel.renderTopSectionOnly();
        const proxy = f.topSection.proxy;
        assert.match(proxy.dataset.proxyKey, /"connected"/);
        f.panel.proxyStatus = { ready: true, connectionVerified: false, usingProxy: false, lastError: new Error('relay down') };
        f.panel.renderTopSectionOnly();
        assert.notEqual(f.topSection.proxy, proxy);
        assert.match(f.topSection.proxy.dataset.proxyKey, /"unavailable"/);
        // Turning the relay off removes the Security Details button: a new key again.
        f.panel.proxySettings = { enabled: false };
        f.panel.renderTopSectionOnly();
        assert.match(f.topSection.proxy.dataset.proxyKey, /^\[false,/);
    } finally { f.cleanup(); }
});

test('an in-place status update records the new key so the next rebuild does not revert it', () => {
    const f = fixture();
    try {
        f.panel.renderTopSectionOnly();
        const proxy = f.topSection.proxy;
        f.panel.proxyStatus = { ready: true, connectionVerified: false, usingProxy: false, connectOnNextRequest: true };
        proxy.setAttribute = (name, value) => { proxy.dataset.proxyKey = value; };
        f.panel.syncProxySectionKey();
        assert.match(proxy.dataset.proxyKey, /"ready"/);
        f.panel.ticketCount = 3;
        f.panel.renderTopSectionOnly();
        assert.equal(f.topSection.proxy, proxy, 'same presentation as the live node: kept');
    } finally { f.cleanup(); }
});

test('a different last-markup record refreshes siblings without detaching the proxy', () => {
    const f = fixture();
    try {
        f.panel.renderTopSectionOnly();
        const proxy = f.topSection.proxy;
        const funding = f.topSection.childNodes[0];
        f.panel.lastTopSectionHtml = 'stale';
        f.panel.renderTopSectionOnly();
        assert.notEqual(f.topSection.childNodes[0], funding);
        assert.equal(proxy.detachments, 0);
    } finally { f.cleanup(); }
});


test('a failed proxy Retry restores the switch and icon when the status returns to unavailable', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    try {
        f.panel.proxyStatus = { lastError: new Error('synthetic relay refusal') };
        f.panel.updateProxyFeedback = () => {};
        const service = f.panel.app.services.networkProxy;
        service.getSettings = () => f.panel.proxySettings;
        service.getStatus = () => f.panel.proxyStatus;
        service.reconnect = async () => { throw new Error('synthetic relay refusal'); };
        f.panel.renderTopSectionOnly();
        assert.equal(f.topSection.proxy.toggle.disabled, false);
        assert.equal(f.topSection.proxy.icon.state, 'unavailable');
        const retry = f.panel.handleProxyToggle({ retry: true });
        assert.equal(f.topSection.proxy.toggle.disabled, true);
        assert.equal(f.topSection.proxy.icon.state, 'connecting');
        await retry;
        t.mock.timers.tick(1000);
        assert.equal(f.panel.proxyActionPending, false);
        assert.equal(f.topSection.proxy.toggle.disabled, false);
        assert.equal(f.topSection.proxy.icon.state, 'unavailable');
    } finally { f.cleanup(); }
});

test('retained retry controls handle each animation completion once after repeated updates', () => {
    const f = fixture();
    try {
        const listeners = [];
        const turns = { addEventListener(type, listener) { listeners.push(listener); } };
        const retry = { querySelector: () => turns };
        const getElementById = document.getElementById;
        document.getElementById = id => id === 'proxy-retry-btn' ? retry : getElementById(id);
        document.querySelectorAll = () => [];
        f.panel.attachHelpDismissal = () => {};
        f.panel.updateProxyFeedback = () => {};
        let completions = 0;
        f.panel.onProxyRetryTurnEnd = () => { completions += 1; };
        for (let i = 0; i < 5; i++) RightPanel.prototype.attachTopSectionEventListeners.call(f.panel);
        const event = { propertyName: 'transform' };
        turns.ontransitionend?.(event);
        for (const listener of listeners) listener(event);
        assert.equal(completions, 1);
    } finally { f.cleanup(); }
});
