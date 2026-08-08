export const EXTENSION_API_VERSION = 1;

export const SLOT_NAMES = Object.freeze({
    SIDEBAR_ACCOUNT_ACTIONS: 'sidebar.accountActions',
    ACCOUNT_COMMERCIAL: 'account.commercial',
    MODAL_LAYER: 'modalLayer'
});

const SUPPORTED_SLOTS = new Set(Object.values(SLOT_NAMES));

export class ExtensionSlotRegistry {
    constructor(options = {}) {
        this.document = options.documentImpl || globalThis.document || null;
        this.nodesBySlot = new Map();
    }

    mount(name, element) {
        if (!SUPPORTED_SLOTS.has(name)) {
            throw new Error(`Unsupported oa-chat extension slot: ${name}`);
        }
        const NodeConstructor = this.document?.defaultView?.Node || globalThis.Node;
        const isNode = NodeConstructor
            ? element instanceof NodeConstructor
            : !!element && Number.isInteger(element.nodeType) && typeof element.remove === 'function';
        if (!isNode) {
            throw new Error(`Extension slot ${name} requires a DOM element.`);
        }

        const nodes = this.nodesBySlot.get(name) || new Set();
        nodes.add(element);
        this.nodesBySlot.set(name, nodes);
        try {
            this.refresh(name);
        } catch (error) {
            nodes.delete(element);
            if (nodes.size === 0) this.nodesBySlot.delete(name);
            throw error;
        }

        let mounted = true;
        return () => {
            if (!mounted) return;
            mounted = false;
            nodes.delete(element);
            element.remove?.();
            if (nodes.size === 0) this.nodesBySlot.delete(name);
            this.refresh(name);
        };
    }

    refresh(name) {
        if (!SUPPORTED_SLOTS.has(name) || !this.document?.querySelector) return false;
        const host = this.document.querySelector(`[data-oa-extension-slot="${name}"]`);
        if (!host) return false;

        const nodes = this.nodesBySlot.get(name) || new Set();
        nodes.forEach(node => {
            if (node.parentNode !== host) host.appendChild(node);
        });
        host.hidden = nodes.size === 0;
        return true;
    }

    refreshAll(onError = () => {}) {
        SUPPORTED_SLOTS.forEach(name => {
            try {
                this.refresh(name);
            } catch (error) {
                onError(name, error);
            }
        });
    }

    clear() {
        for (const [name, nodes] of this.nodesBySlot.entries()) {
            nodes.forEach(node => node.remove?.());
            this.nodesBySlot.delete(name);
            this.refresh(name);
        }
    }
}

export class ExtensionHost {
    constructor(options = {}) {
        this.slots = options.slots || new ExtensionSlotRegistry(options);
        this.onError = options.onError || ((message, error) => console.error(message, error));
        this.cleanups = [];
        this.destroyed = false;
    }

    async mountAll(extensions, context) {
        const tasks = [];
        for (const extension of Array.isArray(extensions) ? extensions : []) {
            const id = String(extension?.id || 'unknown-extension');
            if (extension?.apiVersion !== EXTENSION_API_VERSION || typeof extension?.mount !== 'function') {
                this.onError(
                    `[Extensions] Skipped incompatible extension ${id}. Expected API version ${EXTENSION_API_VERSION}.`
                );
                continue;
            }

            // Start extensions independently. One promise that never settles
            // cannot prevent another extension from mounting.
            tasks.push(this.mountOne(extension, id, context));
        }
        await Promise.all(tasks);
        this.slots.refreshAll((name, error) => {
            this.onError(`[Extensions] Failed to refresh slot ${name}.`, error);
        });
    }

    async mountOne(extension, id, context) {
        const slotCleanups = [];
        const originalSlots = context?.slots;
        const scopedSlots = originalSlots && typeof originalSlots.mount === 'function'
            ? Object.freeze({
                ...originalSlots,
                mount: (name, element) => {
                    const cleanup = originalSlots.mount(name, element);
                    let active = true;
                    const trackedCleanup = () => {
                        if (!active) return;
                        active = false;
                        cleanup();
                    };
                    slotCleanups.push(trackedCleanup);
                    return trackedCleanup;
                }
            })
            : originalSlots;
        const scopedContext = Object.freeze({ ...(context || {}), slots: scopedSlots });
        const rollbackSlots = () => {
            while (slotCleanups.length > 0) {
                try {
                    slotCleanups.pop()();
                } catch (error) {
                    this.onError(`[Extensions] Failed to clean up ${id}.`, error);
                }
            }
        };

        try {
            const extensionCleanup = await extension.mount(scopedContext);
            const cleanup = () => {
                try {
                    if (typeof extensionCleanup === 'function') extensionCleanup();
                } finally {
                    rollbackSlots();
                }
            };
            if (this.destroyed) cleanup();
            else this.cleanups.push(cleanup);
        } catch (error) {
            rollbackSlots();
            this.onError(`[Extensions] Failed to mount ${id}.`, error);
        }
    }

    destroy() {
        this.destroyed = true;
        while (this.cleanups.length > 0) {
            const cleanup = this.cleanups.pop();
            try {
                cleanup();
            } catch (error) {
                this.onError('[Extensions] Cleanup failed.', error);
            }
        }
        this.slots.clear();
    }
}
