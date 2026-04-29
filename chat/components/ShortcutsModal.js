/**
 * ShortcutsModal — keyboard-shortcut cheat sheet with per-action customization.
 *
 * Inline-styled refinement: structurally identical to the original but every
 * arbitrary Tailwind class (px-[…], text-[13px], min-w-[1.75rem], tracking-[…])
 * is replaced with explicit inline `style=` rules so the modal renders
 * correctly without a Tailwind rebuild.
 *
 * Tightened: 560px frame (was 720), content-sized height (was fixed 88vh),
 * 14–18px padding (was 28–32px), denser rows.
 */

import shortcutManager, { ShortcutManager } from '../services/shortcutManager.js';

const CONTEXTUAL_SHORTCUTS = [
    ['Chat input', [
        [['Enter'],          'Send message'],
        [['⇧', 'Enter'],     'Newline within message'],
        [['⌘', 'Z'],         'Undo last file paste (when attachments are pending)'],
    ]],
    ['Editing a sent message', [
        [['⌘', 'Enter'],     'Confirm edit and resend'],
        [['Esc'],            'Cancel edit'],
    ]],
    ['Memory editor', [
        [['⌘', 'S'],         'Save current file'],
        [['Enter'],          'Confirm new file or folder name'],
        [['Esc'],            'Cancel inline create'],
    ]],
    ['Model picker', [
        [['↑', '↓'],         'Navigate models'],
        [['Enter'],          'Select highlighted model'],
    ]],
    ['Anywhere', [
        [['Esc'],            'Close any open modal or menu'],
    ]],
];

class ShortcutsModal {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = document.getElementById('shortcuts-modal');
        this.escapeHandler = null;
        this.returnFocusEl = null;

        this.editingActionId = null;
        this.editingError = null;
        this.captureHandler = null;
        this.unsubscribe = null;
    }

    open() {
        if (this.isOpen || !this.overlay) return;
        this.isOpen = true;
        this.returnFocusEl = document.activeElement;

        this.overlay.classList.remove('hidden');
        this._render();

        this.overlay.onclick = (event) => {
            if (event.target === this.overlay) this.close();
        };
        this.escapeHandler = (event) => {
            if (this.editingActionId) return;
            if (event.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.escapeHandler);

        this.unsubscribe = shortcutManager.subscribe(() => {
            if (this.isOpen) this._render();
        });

        this.overlay.querySelector('[role="dialog"]')?.focus();
    }

    close() {
        if (!this.isOpen || !this.overlay) return;
        this._stopCapture();
        this.editingActionId = null;
        this.editingError = null;
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        if (this.returnFocusEl?.focus) this.returnFocusEl.focus();
        this.returnFocusEl = null;
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    _render() {
        if (!this.overlay) return;
        const customizedCount = this._countCustomized();
        this.overlay.innerHTML = `
            <div role="dialog" aria-modal="true" aria-labelledby="shortcuts-modal-title" tabindex="-1"
                 class="border border-border rounded-2xl bg-background shadow-2xl w-full mx-4 overflow-hidden flex flex-col"
                 style="max-width: 560px; max-height: min(86vh, 720px)">
                ${this._renderHeader(customizedCount)}
                <div class="flex-1 overflow-y-auto" style="min-height: 0; padding: 14px 18px">
                    ${this._renderCustomizableSection(customizedCount)}
                    ${this._renderContextualSection()}
                </div>
            </div>
        `;
        this._attachListeners();
    }

    _countCustomized() {
        let n = 0;
        for (const id of ShortcutManager.actionIds()) {
            const cur = shortcutManager.get(id);
            const def = ShortcutManager.defaultFor(id);
            if (!ShortcutManager.bindingsEqual(cur, def)) n++;
        }
        return n;
    }

    _renderHeader(customizedCount) {
        const resetVisible = customizedCount > 0;
        const resetBtn = resetVisible ? `
            <button id="shortcuts-reset-all"
                    class="text-muted-foreground hover:text-foreground transition-colors hover:bg-muted/40"
                    style="font-size: 11px; font-weight: 500; padding: 5px 9px; border-radius: 6px; background: transparent; border: 0; cursor: pointer">
                Reset all
            </button>
        ` : '';
        return `
            <div class="flex items-center justify-between gap-4 border-b border-border shrink-0"
                 style="padding: 14px 18px">
                <div class="flex items-center min-w-0" style="gap: 10px">
                    <div class="flex items-center justify-center rounded-md flex-shrink-0"
                         style="width: 26px; height: 26px; background: hsl(var(--color-accent-primary) / 0.12)">
                        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.7" style="color: hsl(var(--color-accent-primary))">
                            <path stroke-linecap="round" stroke-linejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
                        </svg>
                    </div>
                    <div class="min-w-0">
                        <h2 id="shortcuts-modal-title" class="font-semibold text-foreground leading-tight truncate"
                            style="font-size: 14px; letter-spacing: -0.005em; margin: 0">Keyboard shortcuts</h2>
                        <p class="text-muted-foreground leading-tight"
                           style="font-size: 11px; margin: 2px 0 0; opacity: 0.85">Click <em>Edit</em> on any row to rebind</p>
                    </div>
                </div>
                <div class="flex items-center flex-shrink-0" style="gap: 4px">
                    ${resetBtn}
                    <button id="shortcuts-modal-close"
                            class="text-muted-foreground hover:text-foreground transition-colors hover:bg-muted/40"
                            style="padding: 6px; border-radius: 6px; background: transparent; border: 0; cursor: pointer"
                            aria-label="Close shortcuts">
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.7">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }

    _renderCustomizableSection(customizedCount) {
        const ids = ShortcutManager.actionIds();
        const rows = ids.map((id) => this._renderActionRow(id)).join('');
        const customizedBadge = customizedCount > 0
            ? `<span style="display:inline-flex; align-items:center; gap:4px; padding:1px 6px; border-radius:999px; font-size:9.5px; font-weight:700; letter-spacing:0.04em; margin-left: 8px;
                          background: hsl(var(--color-accent-primary) / 0.14); color: hsl(var(--color-accent-primary))">
                  <span style="display:inline-block; width:4px; height:4px; border-radius:999px; background: currentColor"></span>
                  ${customizedCount} customized
              </span>`
            : '';
        return `
            <section style="margin-bottom: 18px">
                <div style="display:flex; align-items:baseline; margin-bottom: 8px">
                    <h3 class="text-muted-foreground"
                        style="font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin: 0; opacity: 0.75">Customizable</h3>
                    ${customizedBadge}
                </div>
                <div class="border border-border"
                     style="border-radius: 10px; overflow: hidden; opacity: 1">
                    ${rows}
                </div>
            </section>
        `;
    }

    _renderActionRow(actionId) {
        const label = ShortcutManager.labelFor(actionId);
        const binding = shortcutManager.get(actionId);
        const defaultBinding = ShortcutManager.defaultFor(actionId);
        const isEditing = this.editingActionId === actionId;
        const isDefault = ShortcutManager.bindingsEqual(binding, defaultBinding);

        const middle = isEditing
            ? `
                <div style="display:inline-flex; align-items:center; gap:6px; padding: 4px 10px; border-radius: 6px; white-space: nowrap;
                            background: hsl(var(--color-accent-primary) / 0.10);
                            border: 1px solid hsl(var(--color-accent-primary) / 0.45)">
                    <span style="display:inline-block; width:6px; height:6px; border-radius:999px; background: hsl(var(--color-accent-primary)); animation: pulse 1.5s ease-in-out infinite"></span>
                    <span style="font-size: 11px; font-weight: 600; color: hsl(var(--color-accent-primary))">Press a new combo</span>
                </div>
            `
            : `<div style="display:flex; align-items:center">${this._renderChips(binding)}</div>`;

        let buttons;
        if (isEditing) {
            buttons = `
                <button class="shortcut-cancel-btn text-muted-foreground hover:text-foreground hover:bg-muted/40"
                        style="font-size: 11px; font-weight: 500; padding: 4px 8px; border-radius: 5px; background: transparent; border: 0; cursor: pointer">
                    Cancel
                </button>
            `;
        } else {
            const resetBtn = isDefault ? '' : `
                <button class="shortcut-reset-btn text-muted-foreground hover:text-foreground hover:bg-muted/40"
                        style="display:inline-flex; align-items:center; gap:4px; font-size: 11px; font-weight: 500; padding: 4px 8px; border-radius: 5px; background: transparent; border: 0; cursor: pointer"
                        data-action="${this._escapeHtml(actionId)}" title="Reset to default">
                    <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                    </svg>
                    Reset
                </button>
            `;
            buttons = `
                ${resetBtn}
                <button class="shortcut-edit-btn"
                        style="font-size: 11px; font-weight: 500; padding: 4px 9px; border-radius: 5px; cursor: pointer; border: 0;
                               color: hsl(var(--color-accent-primary));
                               background: hsl(var(--color-accent-primary) / 0.08)"
                        data-action="${this._escapeHtml(actionId)}"
                        onmouseenter="this.style.background='hsl(var(--color-accent-primary) / 0.14)'"
                        onmouseleave="this.style.background='hsl(var(--color-accent-primary) / 0.08)'"
                        title="Rebind shortcut">
                    Edit
                </button>
            `;
        }

        const modifiedDot = !isDefault && !isEditing
            ? `<span style="display:inline-block; width:6px; height:6px; border-radius:999px; flex-shrink:0; background: hsl(var(--color-accent-primary))" title="Customized"></span>`
            : `<span style="display:inline-block; width:6px; flex-shrink:0"></span>`;

        const editingBg = isEditing ? 'background: hsl(var(--color-accent-primary) / 0.04);' : '';
        const hoverClass = isEditing ? '' : 'hover:bg-muted/15';

        const errorBlock = (isEditing && this.editingError) ? `
            <div style="display:flex; align-items:flex-start; gap:6px; padding: 0 14px 10px; margin-left: 22px; margin-top: -4px">
                <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" style="color: rgb(239 68 68); flex-shrink: 0; margin-top: 1px">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                </svg>
                <span style="font-size: 11px; color: rgb(239 68 68); line-height: 1.45">${this._escapeHtml(this.editingError)}</span>
            </div>
        ` : '';

        // Border-top on every row except the first; first row gets no top border.
        return `
            <div class="${hoverClass} transition-colors" style="${editingBg} border-top: 1px solid hsl(var(--color-border) / 0.4)">
                <div style="display:flex; align-items:center; justify-content:space-between; gap: 10px; padding: 9px 14px">
                    <div style="display:flex; align-items:center; gap: 9px; min-width: 0; flex: 1">
                        ${modifiedDot}
                        <div class="text-foreground" style="font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${this._escapeHtml(label)}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap: 9px; flex-shrink: 0">
                        ${middle}
                        <div style="display:flex; align-items:center; gap: 4px">${buttons}</div>
                    </div>
                </div>
                ${errorBlock}
            </div>
        `;
    }

    _renderContextualSection() {
        const groups = CONTEXTUAL_SHORTCUTS.map(([title, items], gIdx) => {
            const rows = items.map(([keys, desc]) => {
                const chips = keys.map((k) => this._chipHtml(k))
                    .join('<span style="font-size:10px; color: hsl(var(--color-muted-foreground) / 0.45); margin: 0 2px">+</span>');
                return `
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding: 7px 14px; border-top: 1px solid hsl(var(--color-border) / 0.3)">
                        <span class="text-muted-foreground" style="font-size: 11.5px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.95">${this._escapeHtml(desc)}</span>
                        <div style="display:flex; align-items:center; flex-shrink: 0">${chips}</div>
                    </div>
                `;
            }).join('');
            return `
                <div${gIdx === 0 ? '' : ' style="border-top: 1px solid hsl(var(--color-border) / 0.4)"'}>
                    <div class="text-muted-foreground"
                         style="padding: 6px 14px; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.65;
                                background: hsl(var(--color-muted) / 0.22)">${this._escapeHtml(title)}</div>
                    ${rows}
                </div>
            `;
        }).join('');
        return `
            <section>
                <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom: 8px">
                    <h3 class="text-muted-foreground"
                        style="font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin: 0; opacity: 0.75">Built-in</h3>
                    <span class="text-muted-foreground" style="font-size: 9.5px; opacity: 0.6">Reserved for typing &amp; editing</span>
                </div>
                <div class="border border-border" style="border-radius: 10px; overflow: hidden">
                    ${groups}
                </div>
            </section>
        `;
    }

    _renderChips(binding) {
        if (!binding) return `<span class="text-muted-foreground" style="font-size: 11px; font-style: italic">unbound</span>`;
        const parts = ShortcutManager.format(binding);
        if (!parts.length) return `<span class="text-muted-foreground" style="font-size: 11px; font-style: italic">unbound</span>`;
        return parts.map((key) => this._chipHtml(key))
            .join('<span style="font-size:10px; color: hsl(var(--color-muted-foreground) / 0.45); margin: 0 2px">+</span>');
    }

    _chipHtml(key) {
        return `<kbd class="border border-border text-foreground"
                  style="display:inline-flex; align-items:center; justify-content:center; min-width: 22px; height: 22px; padding: 0 6px;
                         border-radius: 5px;
                         font: 600 10.5px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
                         color: hsl(var(--color-foreground) / 0.9);
                         background: linear-gradient(to bottom, hsl(var(--color-muted) / 0.55), hsl(var(--color-muted) / 0.35));
                         box-shadow: 0 1px 0 hsl(var(--color-border) / 0.7), inset 0 1px 0 hsl(var(--color-foreground) / 0.04)">${this._escapeHtml(key)}</kbd>`;
    }

    _attachListeners() {
        if (!this.overlay) return;
        this.overlay.querySelector('#shortcuts-modal-close')?.addEventListener('click', () => this.close());
        this.overlay.querySelector('#shortcuts-reset-all')?.addEventListener('click', () => this._handleResetAll());

        this.overlay.querySelectorAll('.shortcut-edit-btn').forEach((btn) => {
            btn.addEventListener('click', () => this._startEditing(btn.dataset.action));
        });
        this.overlay.querySelectorAll('.shortcut-reset-btn').forEach((btn) => {
            btn.addEventListener('click', () => this._resetOne(btn.dataset.action));
        });
        this.overlay.querySelectorAll('.shortcut-cancel-btn').forEach((btn) => {
            btn.addEventListener('click', () => this._cancelEditing());
        });
    }

    _startEditing(actionId) {
        if (!ShortcutManager.actionIds().includes(actionId)) return;
        this._stopCapture();
        this.editingActionId = actionId;
        this.editingError = null;
        this._render();

        this.captureHandler = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this._cancelEditing();
                return;
            }
            const binding = ShortcutManager.eventToBinding(event);
            if (!binding) return;
            event.preventDefault();
            event.stopPropagation();

            const conflict = shortcutManager.findConflict(binding, actionId);
            if (conflict) {
                this.editingError = `Conflicts with "${ShortcutManager.labelFor(conflict)}". Try a different combo.`;
                this._render();
                return;
            }
            shortcutManager.set(actionId, binding);
            this.editingActionId = null;
            this.editingError = null;
            this._stopCapture();
            this._render();
        };
        document.addEventListener('keydown', this.captureHandler, true);
    }

    _cancelEditing() {
        this.editingActionId = null;
        this.editingError = null;
        this._stopCapture();
        this._render();
    }

    _stopCapture() {
        if (this.captureHandler) {
            document.removeEventListener('keydown', this.captureHandler, true);
            this.captureHandler = null;
        }
    }

    _resetOne(actionId) {
        shortcutManager.reset(actionId);
    }

    _handleResetAll() {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            if (!window.confirm('Reset all customizable shortcuts to their defaults?')) return;
        }
        shortcutManager.resetAll();
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }
}

export default ShortcutsModal;
