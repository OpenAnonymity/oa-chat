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
    assert.equal(registry.hasMounted(SLOT_NAMES.ACCOUNT_COMMERCIAL), false);
    const unmount = registry.mount(SLOT_NAMES.ACCOUNT_COMMERCIAL, node);
    assert.equal(registry.hasMounted(SLOT_NAMES.ACCOUNT_COMMERCIAL), true);
    assert.equal(hosts.get(SLOT_NAMES.ACCOUNT_COMMERCIAL).hidden, false);
    assert.deepEqual(hosts.get(SLOT_NAMES.ACCOUNT_COMMERCIAL).children, [node]);
    unmount();
    assert.equal(registry.hasMounted(SLOT_NAMES.ACCOUNT_COMMERCIAL), false);
    assert.equal(hosts.get(SLOT_NAMES.ACCOUNT_COMMERCIAL).hidden, true);
});

test('one broken extension cannot block or retain partial UI from another', async () => {
    const { hosts, registry } = createFixture();
    const errors = [];
    const host = new ExtensionHost({ slots: registry, onError: (...args) => errors.push(args) });
    const context = { slots: { mount: (name, element) => registry.mount(name, element) } };
    const partial = createElement();
    const valid = createElement();

    await host.mountAll([
        {
            id: 'partial', apiVersion: EXTENSION_API_VERSION,
            mount(extensionContext) {
                extensionContext.slots.mount(SLOT_NAMES.MODAL_LAYER, partial);
                throw new Error('mount failed');
            }
        },
        {
            id: 'valid', apiVersion: EXTENSION_API_VERSION,
            mount(extensionContext) {
                extensionContext.slots.mount(SLOT_NAMES.MODAL_LAYER, valid);
            }
        }
    ], context);

    assert.equal(errors.length, 1);
    assert.deepEqual(hosts.get(SLOT_NAMES.MODAL_LAYER).children, [valid]);
});

test('slot registry rejects undocumented locations and incompatible API versions', async () => {
    const { registry } = createFixture();
    assert.throws(() => registry.mount('internal.sidebar', createElement()), /Unsupported/);
    const errors = [];
    const host = new ExtensionHost({ slots: registry, onError: (...args) => errors.push(args) });
    await host.mountAll([{ id: 'old', apiVersion: 1, mount() {} }], {});
    assert.equal(errors.length, 1);
});
