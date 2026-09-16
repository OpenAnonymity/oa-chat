import test from 'node:test';
import assert from 'node:assert/strict';
import RightPanel from '../../chat/components/RightPanel.js';

function fixture() {
    const oldDocument = globalThis.document;
    const panel = Object.create(RightPanel.prototype);
    const nodes = new Map();
    const handlers = {};
    const node = id => ({ id, dataset: {}, attrs: {}, inert: false,
        contains(target) { return target === this || target?.parent === this; },
        setAttribute(name, value) { this.attrs[name] = value; },
        closest() { return null; }, focus() { document.activeElement = this; }
    });
    for (const [, panelId, buttonId] of panel.getHelpDisclosures()) {
        nodes.set(panelId, node(panelId)); nodes.set(buttonId, node(buttonId));
    }
    nodes.set('right-panel-content', { contains: target => [...nodes.values()].some(n => n === target || (n.id && n.contains?.(target))) });
    globalThis.document = { activeElement: null, getElementById: id => nodes.get(id), querySelector: () => null,
        addEventListener: (type, fn) => { handlers[type] = fn; },
        removeEventListener: type => { delete handlers[type]; }
    };
    panel.escapeHtml = value => String(value);
    panel.proxySettings = { enabled: false };
    panel.proxyStatus = {};
    panel.renderTopSectionOnly = () => {};
    panel.smoothProgress = { stop() {} };
    const networkProxy = { getTlsInfo: () => ({ version: null }), hasActiveRequests: () => false,
        getSettings: () => panel.proxySettings, getStatus: () => panel.proxyStatus };
    panel.app = { services: { networkProxy }, showToast() {} };
    return { panel, nodes, handlers, networkProxy, cleanup() { panel.destroy(); globalThis.document = oldDocument; } };
}

test('help disclosures switch exclusively and close on repeated activation', () => {
    const f = fixture();
    try {
        for (const [name, panelId, buttonId] of f.panel.getHelpDisclosures()) {
            f.panel.togglePanelHelp(name);
            for (const [other] of f.panel.getHelpDisclosures()) assert.equal(f.panel[other], name === other);
            assert.equal(f.nodes.get(panelId).inert, false);
            assert.equal(f.nodes.get(buttonId).attrs['aria-expanded'], 'true');
        }
        f.panel.togglePanelHelp('showProxyInfo');
        assert.ok(f.panel.getHelpDisclosures().every(([name, id]) => !f.panel[name] && f.nodes.get(id).inert));
    } finally { f.cleanup(); }
});

test('outside clicks dismiss help without consuming the clicked action; inner clicks stay open', () => {
    const f = fixture();
    try {
        f.panel.attachHelpDismissal();
        const click = f.handlers.click;
        f.panel.attachHelpDismissal();
        assert.equal(f.handlers.click, click, 'handlers attach only once across renders');
        f.panel.setOpenHelp('showProxyInfo');
        click({ target: { parent: f.nodes.get('proxy-info-panel') } });
        assert.equal(f.panel.showProxyInfo, true);
        click({ target: f.nodes.get('proxy-info-btn') });
        assert.equal(f.panel.showProxyInfo, true);
        // No preventDefault or stopPropagation provided: the handler must not consume either.
        click({ target: {} });
        assert.equal(f.panel.showProxyInfo, false);
    } finally { f.cleanup(); }
    assert.deepEqual(f.handlers, {}, 'destroy removes document handlers');
});

test('Escape returns focus from help content but leaves foreground modal Escape alone', () => {
    const f = fixture();
    try {
        f.panel.attachHelpDismissal(); f.panel.setOpenHelp('showProxyInfo');
        const inner = { parent: f.nodes.get('proxy-info-panel') };
        document.activeElement = inner;
        let prevented = false;
        f.handlers.keydown({ key: 'Escape', target: inner, preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(document.activeElement, f.nodes.get('proxy-info-btn'));
        assert.equal(f.panel.showProxyInfo, false);
        f.panel.setOpenHelp('showProxyInfo');
        f.handlers.keydown({ key: 'Escape', target: {}, preventDefault() { throw Error('modal consumed'); } });
        assert.equal(f.panel.showProxyInfo, true);
    } finally { f.cleanup(); }
});

test('proxy status distinguishes disabled, initializing, ready, verified, and failed connections', () => {
    const f = fixture();
    try {
        const cases = [
            [false, {}, 'off'], [true, {}, 'connecting'], [true, {ready:true}, 'ready'],
            [true, {ready:true,usingProxy:true}, 'ready'],
            [true, {usingProxy:true,connectionVerified:true}, 'connected'],
            [false, {lastError:'failed'}, 'unavailable'], [true, {fallbackActive:true}, 'unavailable']
        ];
        for (const [enabled, status, expected] of cases) {
            f.panel.proxySettings = { enabled }; f.panel.proxyStatus = status;
            const meta = f.panel.getProxyStatusMeta();
            assert.equal(meta.state, expected);
            const html = f.panel.generateProxySectionHTML();
            assert.match(html, new RegExp('data-proxy-state="' + expected + '"'));
            assert.match(html, /aria-controls="proxy-info-panel"/);
            assert.match(html, /id="proxy-info-learn-more"/);
            assert.doesNotMatch(html, /statusMeta\.dotClass|TLS-over-WSS/);
            assert.equal(/id="proxy-failure-notice"[^>]* hidden/.test(html), expected !== 'unavailable');
        }
        f.panel.proxyActionPending = true; f.panel.proxyPendingEnabled = true;
        assert.equal(f.panel.getProxyStatusMeta().state, 'connecting', 'retry temporarily replaces old error');
    } finally { f.cleanup(); }
});

test('Retry enables a disabled proxy, reconnects an enabled proxy, and respects active requests', async () => {
    const f = fixture();
    try {
        const calls = [];
        f.networkProxy.updateSettings = async value => { calls.push(value); f.panel.proxySettings = value; };
        f.networkProxy.reconnect = async () => calls.push('reconnect');
        await f.panel.handleProxyToggle({ retry: true });
        assert.deepEqual(calls, [{enabled:true}]);
        clearTimeout(f.panel.proxyRenderTimer); f.panel.lastProxyToggleTime = 0;
        await f.panel.handleProxyToggle({ retry: true });
        assert.deepEqual(calls, [{enabled:true}, 'reconnect']);
        clearTimeout(f.panel.proxyRenderTimer); f.panel.lastProxyToggleTime = 0;
        f.networkProxy.hasActiveRequests = () => true;
        await f.panel.handleProxyToggle({ retry: true });
        assert.equal(calls.length, 2);
    } finally { f.cleanup(); }
});


test('intentional disable acknowledges old failures; automatic fallback still warns', async () => {
    const f = fixture();
    try {
        f.panel.proxyStatus = { lastError: 'failed', fallbackActive: true };
        assert.equal(f.panel.getProxyStatusMeta().state, 'unavailable');
        f.panel.proxySettings = { enabled: true };
        f.networkProxy.updateSettings = async settings => { f.panel.proxySettings = settings; };
        await f.panel.handleProxyToggle();
        assert.equal(f.panel.getProxyStatusMeta().state, 'off');
        clearTimeout(f.panel.proxyRenderTimer); f.panel.lastProxyToggleTime = 0;
        await f.panel.handleProxyToggle({ retry: true });
        assert.equal(f.panel.getProxyStatusMeta().state, 'unavailable', 'a failed retry warns again');
    } finally { f.cleanup(); }
});

test('destroy during a pending proxy change does not schedule a later panel render', async () => {
    const f = fixture();
    try {
        let finish;
        f.networkProxy.updateSettings = () => new Promise(resolve => { finish = resolve; });
        const operation = f.panel.handleProxyToggle();
        f.panel.destroy(); finish(); await operation;
        assert.equal(f.panel.proxyRenderTimer, undefined);
    } finally { f.cleanup(); }
});
