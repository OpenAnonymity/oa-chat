import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EXTENSION_API_VERSION,
    SLOT_NAMES,
    ExtensionHost,
    ExtensionSlotRegistry
} from '../../chat/extensions/extensionHost.js';

function createElement() {
    return {
        nodeType: 1,
        parentNode: null,
        remove() {
            if (!this.parentNode) return;
            const parent = this.parentNode;
            parent.children = parent.children.filter(child => child !== this);
            this.parentNode = null;
        }
    };
}

function createFixture() {
    const hosts = new Map();
    Object.values(SLOT_NAMES).forEach(name => {
        hosts.set(name, {
            hidden: true,
            children: [],
            appendChild(node) {
                if (!node || node.nodeType !== 1) throw new TypeError('Not a DOM Node');
                node.remove?.();
                this.children.push(node);
                node.parentNode = this;
            }
        });
    });
    const documentImpl = {
        querySelector(selector) {
            const match = selector.match(/data-oa-extension-slot="([^"]+)"/);
            return match ? hosts.get(match[1]) || null : null;
        }
    };
    return { hosts, registry: new ExtensionSlotRegistry({ documentImpl }) };
}

test('slot registry mounts, reattaches, and removes extension nodes', () => {
    const { hosts, registry } = createFixture();
    const node = createElement();
    const unmount = registry.mount(SLOT_NAMES.ACCOUNT_COMMERCIAL, node);
    const firstHost = hosts.get(SLOT_NAMES.ACCOUNT_COMMERCIAL);

    assert.equal(firstHost.hidden, false);
    assert.deepEqual(firstHost.children, [node]);

    const replacementHost = {
        hidden: true,
        children: [],
        appendChild(child) {
            if (!child || child.nodeType !== 1) throw new TypeError('Not a DOM Node');
            child.remove?.();
            this.children.push(child);
            child.parentNode = this;
        }
    };
    hosts.set(SLOT_NAMES.ACCOUNT_COMMERCIAL, replacementHost);
    registry.refresh(SLOT_NAMES.ACCOUNT_COMMERCIAL);

    assert.deepEqual(firstHost.children, []);
    assert.deepEqual(replacementHost.children, [node]);
    unmount();
    assert.equal(replacementHost.hidden, true);
    assert.deepEqual(replacementHost.children, []);
});

test('extension host skips incompatible and failing extensions without blocking valid ones', async () => {
    const { registry } = createFixture();
    const errors = [];
    const mounted = [];
    const host = new ExtensionHost({
        slots: registry,
        onError: (...args) => errors.push(args)
    });

    await host.mountAll([
        { id: 'old', apiVersion: 0, mount() {} },
        { id: 'broken', apiVersion: EXTENSION_API_VERSION, mount() { throw new Error('broken'); } },
        {
            id: 'valid',
            apiVersion: EXTENSION_API_VERSION,
            mount() {
                mounted.push('valid');
                return () => mounted.push('cleaned');
            }
        }
    ], {});

    assert.deepEqual(mounted, ['valid']);
    assert.equal(errors.length, 2);
    host.destroy();
    assert.deepEqual(mounted, ['valid', 'cleaned']);
});

test('slot registry rejects undocumented locations', () => {
    const { registry } = createFixture();
    assert.throws(() => registry.mount('internal.sidebar', createElement()), /Unsupported/);
});

test('invalid elements roll back cleanly and do not stop a later extension', async () => {
    const { hosts, registry } = createFixture();
    const errors = [];
    const host = new ExtensionHost({ slots: registry, onError: (...args) => errors.push(args) });
    const context = { slots: { mount: (name, element) => registry.mount(name, element) } };
    const valid = createElement();

    await host.mountAll([
        {
            id: 'invalid-node',
            apiVersion: EXTENSION_API_VERSION,
            mount(extensionContext) {
                extensionContext.slots.mount(SLOT_NAMES.MODAL_LAYER, {});
            }
        },
        {
            id: 'valid-after-invalid',
            apiVersion: EXTENSION_API_VERSION,
            mount(extensionContext) {
                extensionContext.slots.mount(SLOT_NAMES.MODAL_LAYER, valid);
            }
        }
    ], context);

    assert.equal(errors.length, 1);
    assert.deepEqual(hosts.get(SLOT_NAMES.MODAL_LAYER).children, [valid]);
});

test('a partial mount is rolled back when its extension later throws', async () => {
    const { hosts, registry } = createFixture();
    const host = new ExtensionHost({ slots: registry, onError() {} });
    const context = { slots: { mount: (name, element) => registry.mount(name, element) } };
    const partial = createElement();
    const valid = createElement();

    await host.mountAll([
        {
            id: 'partial',
            apiVersion: EXTENSION_API_VERSION,
            mount(extensionContext) {
                extensionContext.slots.mount(SLOT_NAMES.SIDEBAR_ACCOUNT_ACTIONS, partial);
                throw new Error('mount failed after inserting UI');
            }
        },
        {
            id: 'valid',
            apiVersion: EXTENSION_API_VERSION,
            mount(extensionContext) {
                extensionContext.slots.mount(SLOT_NAMES.SIDEBAR_ACCOUNT_ACTIONS, valid);
            }
        }
    ], context);

    assert.deepEqual(hosts.get(SLOT_NAMES.SIDEBAR_ACCOUNT_ACTIONS).children, [valid]);
});

test('a never-settling extension does not prevent another extension from mounting', async () => {
    const { hosts, registry } = createFixture();
    const host = new ExtensionHost({ slots: registry, onError() {} });
    const context = { slots: { mount: (name, element) => registry.mount(name, element) } };
    const valid = createElement();

    void host.mountAll([
        {
            id: 'hung',
            apiVersion: EXTENSION_API_VERSION,
            mount: () => new Promise(() => {})
        },
        {
            id: 'valid',
            apiVersion: EXTENSION_API_VERSION,
            mount(extensionContext) {
                extensionContext.slots.mount(SLOT_NAMES.ACCOUNT_COMMERCIAL, valid);
            }
        }
    ], context);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(hosts.get(SLOT_NAMES.ACCOUNT_COMMERCIAL).children, [valid]);
});
