/**
 * shortcutManager — centralized keyboard-shortcut registry.
 *
 * Stores user-customized bindings in localStorage (`oa-shortcuts`), falls
 * back to defaults for any unset action. Bindings are platform-aware: the
 * `mod` modifier maps to Cmd on macOS and Ctrl elsewhere, so a single
 * stored binding works across both.
 *
 * Consumers (app.js global handler, ShortcutsModal UI) call:
 *   - `matches(event, actionId)` to dispatch a keydown
 *   - `get(actionId)` / `getAll()` to render
 *   - `set(actionId, binding)` to save a new binding
 *   - `reset(actionId)` / `resetAll()` to revert
 *   - `subscribe(fn)` to react to changes
 *
 * Bindings are `{ key: string, modifiers: string[] }` where modifiers ∈
 * { 'mod', 'shift', 'alt' }. `key` is normalized to lowercase for
 * single-character keys and kept as-is for named keys ('Enter', 'ArrowUp',
 * etc.). The static helper `eventToBinding(event)` produces this shape
 * from a `KeyboardEvent`.
 */

const STORAGE_KEY = 'oa-shortcuts';

const DEFAULT_SHORTCUTS = {
    newChat:      { key: '/', modifiers: ['mod'] },
    modelPicker:  { key: 'k', modifiers: ['mod'] },
    searchFocus:  { key: 'f', modifiers: ['mod', 'shift'] },
    memoryEditor: { key: 'm', modifiers: ['mod', 'shift'] },
    shortcuts:    { key: '?', modifiers: [] },
};

const ACTION_LABELS = {
    newChat:      'New chat',
    modelPicker:  'Open model picker',
    searchFocus:  'Focus session search',
    memoryEditor: 'Open memory editor',
    shortcuts:    'Open shortcuts panel',
};

const ACTION_ORDER = [
    'newChat',
    'modelPicker',
    'searchFocus',
    'memoryEditor',
    'shortcuts',
];

const isMacPlatform = () => /Mac|iPhone|iPad|iPod/i.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
);

class ShortcutManager {
    constructor() {
        this.shortcuts = this._load();
        this.subscribers = new Set();
    }

    _load() {
        const merged = { ...DEFAULT_SHORTCUTS };
        try {
            const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
            if (!raw) return merged;
            const parsed = JSON.parse(raw);
            for (const id of Object.keys(DEFAULT_SHORTCUTS)) {
                if (parsed && parsed[id] && typeof parsed[id].key === 'string' && Array.isArray(parsed[id].modifiers)) {
                    merged[id] = { key: parsed[id].key, modifiers: [...parsed[id].modifiers] };
                }
            }
        } catch (err) {
            console.warn('[shortcutManager] Failed to load saved shortcuts:', err);
        }
        return merged;
    }

    _persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.shortcuts));
        } catch (err) {
            console.warn('[shortcutManager] Failed to persist shortcuts:', err);
        }
    }

    _notify() {
        for (const fn of this.subscribers) {
            try { fn(this.shortcuts); } catch (err) { console.warn('[shortcutManager] subscriber threw:', err); }
        }
    }

    subscribe(fn) {
        this.subscribers.add(fn);
        return () => this.subscribers.delete(fn);
    }

    get(actionId) {
        return this.shortcuts[actionId] ? { ...this.shortcuts[actionId], modifiers: [...this.shortcuts[actionId].modifiers] } : null;
    }

    getAll() {
        const out = {};
        for (const id of Object.keys(this.shortcuts)) {
            out[id] = { ...this.shortcuts[id], modifiers: [...this.shortcuts[id].modifiers] };
        }
        return out;
    }

    set(actionId, binding) {
        if (!DEFAULT_SHORTCUTS[actionId]) return;
        if (!binding || typeof binding.key !== 'string' || !Array.isArray(binding.modifiers)) return;
        this.shortcuts[actionId] = { key: binding.key, modifiers: [...binding.modifiers] };
        this._persist();
        this._notify();
    }

    reset(actionId) {
        if (!DEFAULT_SHORTCUTS[actionId]) return;
        this.shortcuts[actionId] = { ...DEFAULT_SHORTCUTS[actionId], modifiers: [...DEFAULT_SHORTCUTS[actionId].modifiers] };
        this._persist();
        this._notify();
    }

    resetAll() {
        this.shortcuts = {};
        for (const id of Object.keys(DEFAULT_SHORTCUTS)) {
            this.shortcuts[id] = { ...DEFAULT_SHORTCUTS[id], modifiers: [...DEFAULT_SHORTCUTS[id].modifiers] };
        }
        this._persist();
        this._notify();
    }

    matches(event, actionId) {
        const binding = this.shortcuts[actionId];
        if (!binding) return false;
        return ShortcutManager.eventMatchesBinding(event, binding);
    }

    /**
     * Find which (if any) bound action matches the same key+modifiers as
     * `binding`, ignoring `excludeActionId`. Used for conflict detection
     * when the user is rebinding an action.
     */
    findConflict(binding, excludeActionId) {
        for (const [id, other] of Object.entries(this.shortcuts)) {
            if (id === excludeActionId) continue;
            if (ShortcutManager.bindingsEqual(other, binding)) return id;
        }
        return null;
    }

    static eventMatchesBinding(event, binding) {
        if (!binding) return false;
        const mac = isMacPlatform();
        const wantMod   = binding.modifiers.includes('mod');
        const wantShift = binding.modifiers.includes('shift');
        const wantAlt   = binding.modifiers.includes('alt');
        const evMod     = mac ? event.metaKey  : event.ctrlKey;
        const evOther   = mac ? event.ctrlKey  : event.metaKey;

        if (wantMod !== evMod) return false;
        if (wantShift !== event.shiftKey) return false;
        if (wantAlt !== event.altKey) return false;
        // The "other" platform mod (Ctrl on Mac, Cmd elsewhere) must NOT be down.
        if (evOther) return false;

        const evKey = ShortcutManager.normalizeKey(event.key);
        const bindKey = ShortcutManager.normalizeKey(binding.key);
        return evKey === bindKey;
    }

    static normalizeKey(key) {
        if (typeof key !== 'string' || !key) return '';
        // Single-printable-character keys are case-folded so `?` (Shift+/)
        // and `K` (Shift+k) are matched against their stored single-char
        // form. Named keys (`Enter`, `ArrowUp`) keep their casing.
        return key.length === 1 ? key.toLowerCase() : key;
    }

    static bindingsEqual(a, b) {
        if (!a || !b) return false;
        if (ShortcutManager.normalizeKey(a.key) !== ShortcutManager.normalizeKey(b.key)) return false;
        const am = new Set(a.modifiers || []);
        const bm = new Set(b.modifiers || []);
        if (am.size !== bm.size) return false;
        for (const m of am) if (!bm.has(m)) return false;
        return true;
    }

    /**
     * Build a binding from a keydown event. Returns `null` if the key is a
     * pure modifier (Meta/Control/Shift/Alt) — those alone can't be a binding.
     */
    static eventToBinding(event) {
        const key = event.key;
        if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt' ||
            key === 'OS' || key === 'AltGraph') return null;
        const mac = isMacPlatform();
        const modifiers = [];
        const evMod = mac ? event.metaKey : event.ctrlKey;
        if (evMod) modifiers.push('mod');
        if (event.shiftKey) modifiers.push('shift');
        if (event.altKey) modifiers.push('alt');
        return { key: ShortcutManager.normalizeKey(key), modifiers };
    }

    /**
     * Render-friendly chip list for a binding, e.g. ['⌘', '⇧', 'F'].
     */
    static format(binding) {
        if (!binding) return [];
        const mac = isMacPlatform();
        const parts = [];
        if (binding.modifiers.includes('mod'))   parts.push(mac ? '⌘'  : 'Ctrl');
        if (binding.modifiers.includes('shift')) parts.push(mac ? '⇧'  : 'Shift');
        if (binding.modifiers.includes('alt'))   parts.push(mac ? '⌥'  : 'Alt');
        const k = binding.key;
        if (!k) return parts;
        if (k.length === 1) parts.push(k.toUpperCase());
        else if (k === 'ArrowUp') parts.push('↑');
        else if (k === 'ArrowDown') parts.push('↓');
        else if (k === 'ArrowLeft') parts.push('←');
        else if (k === 'ArrowRight') parts.push('→');
        else parts.push(k);
        return parts;
    }

    static labelFor(actionId) {
        return ACTION_LABELS[actionId] || actionId;
    }

    static actionIds() {
        return [...ACTION_ORDER];
    }

    static defaultFor(actionId) {
        const def = DEFAULT_SHORTCUTS[actionId];
        return def ? { ...def, modifiers: [...def.modifiers] } : null;
    }
}

const shortcutManager = new ShortcutManager();

export default shortcutManager;
export { ShortcutManager, DEFAULT_SHORTCUTS, ACTION_LABELS, ACTION_ORDER };
