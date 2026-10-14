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

// A container whose innerHTML setter yields the nodes renderTopSectionOnly looks for.
function topSectionNode() {
    const section = {
        dataset: {}, writes: 0, proxy: null, notice: null,
        set innerHTML(html) {
            this.writes += 1;
            const key = /id="proxy-section"[^>]*data-proxy-key="([^"]*)"/.exec(html)?.[1];
            const parent = this;
            this.proxy = key === undefined ? null : {
                id: 'proxy-section', dataset: { proxyKey: unescapeAttr(key) },
                replaceWith(node) { parent.proxy = node; }
            };
            this.notice = /id="proxy-failure-notice"/.test(html)
                ? { id: 'proxy-failure-notice', contains: () => false, replaceWith(node) { parent.notice = node; }, querySelector: () => null }
                : null;
        },
        querySelector(selector) {
            if (selector === '#proxy-section') return this.proxy;
            if (selector === '#proxy-failure-notice') return this.notice;
            return null;
        }
    };
    return section;
}

function fixture() {
    const oldDocument = globalThis.document;
    const topSection = topSectionNode();
    const panelContent = { querySelector: selector => (selector === '.flex-shrink-0' ? topSection : null) };
    globalThis.document = {
        activeElement: null,
        getElementById: id => (id === 'right-panel-content' ? panelContent : id === 'proxy-section' ? topSection.proxy : null),
        querySelector: () => null, addEventListener() {}, removeEventListener() {}
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

test('a wallet change rebuilds the section but keeps the live proxy section when its presentation is unchanged', () => {
    const f = fixture();
    try {
        f.panel.renderTopSectionOnly();
        const proxy = f.topSection.proxy;
        f.panel.ticketCount = 4;
        f.panel.renderTopSectionOnly();
        assert.equal(f.topSection.writes, 2, 'the ticket count changed, so the section was rebuilt');
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

test('a different last-markup record forces a rebuild (render() clears it)', () => {
    const f = fixture();
    try {
        f.panel.renderTopSectionOnly();
        f.panel.lastTopSectionHtml = 'stale';
        f.panel.renderTopSectionOnly();
        assert.equal(f.topSection.writes, 2);
    } finally { f.cleanup(); }
});
