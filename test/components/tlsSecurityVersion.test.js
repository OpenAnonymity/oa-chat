import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import tlsSecurityModal from '../../chat/components/TLSSecurityModal.js';

// Use the vendored getter: reading libcurl.version invokes native WASM code.
function vendorVersion() {
    // The repository runner bundles tests into /tmp, so resolve from its cwd.
    const source = fs.readFileSync('chat/vendor/libcurl/libcurl_full.js', 'utf8');
    const start = source.indexOf('function get_version() {');
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start);
    const context = {
        wasm_ready: true, version_dict: null,
        libcurl_version: '0.7.1', wisp_version: '1.1.1',
        _get_version() { throw new Error('native runtime unavailable'); },
        UTF8ToString: () => '{}', _free() {}
    };
    vm.runInNewContext(source.slice(start, end), context);
    return { context, libcurl: { get version() { return context.get_version(); } } };
}

function fixture(t, libcurl) {
    const previousWindow = globalThis.window;
    globalThis.window = { libcurl };
    t.after(() => { globalThis.window = previousWindow; });
    const modal = new tlsSecurityModal.constructor();
    modal.overlay = { innerHTML: '' };
    modal.configureServices({
        networkProxy: { getStatus: () => ({ enabled: true, usingProxy: false }), getTlsInfo: () => ({}), getSettings: () => ({}) },
        inference: { getTlsDisplayName: () => 'Provider' }
    });
    return modal;
}

test('Security Details remains usable when the native version getter throws, and recovers on rerender', t => {
    const { context, libcurl } = vendorVersion();
    assert.throws(() => libcurl.version, /native runtime unavailable/);
    const modal = fixture(t, libcurl);
    assert.doesNotThrow(() => modal.render());
    assert.match(modal.overlay.innerHTML, /Version<\/span>\s*<span[^>]*>Unknown<\/span>/);
    assert.match(modal.overlay.innerHTML, /No TLS captured yet/);
    assert.match(modal.overlay.innerHTML, /tls-modal-done/);
    assert.doesNotMatch(modal.overlay.innerHTML, /native runtime unavailable/);
    context._get_version = () => 1;
    modal.render();
    assert.match(modal.overlay.innerHTML, /Version<\/span>\s*<span[^>]*>0\.7\.1<\/span>/);
});

test('Security Details tolerates an unloaded or absent library without initializing it', t => {
    const { context, libcurl } = vendorVersion();
    context.wasm_ready = false;
    const modal = fixture(t, libcurl);
    assert.doesNotThrow(() => modal.render());
    assert.match(modal.overlay.innerHTML, /Version<\/span>\s*<span[^>]*>Unknown<\/span>/);
    globalThis.window.libcurl = undefined;
    assert.doesNotThrow(() => modal.render());
});
