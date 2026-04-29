/**
 * AboutModal — intro to oa-chat (what it is, how unlinkable inference works,
 * a feature tour) plus links to the full privacy writeup. Triggered by the
 * About button in the chat-area top toolbar (info icon, next to Share).
 *
 * Refinement direction B (diagram-led):
 *   - 560px frame, content-sized height — no fixed 88vh empty space.
 *   - Privacy claim rendered as a You → OA org → Provider flow diagram
 *     with a "blind sig" lock badge over the first arrow.
 *   - Features in a denser two-column icon grid; resources as a row of pills.
 *   - Outer padding tightened (32→18px) and section gaps (32→14px).
 *
 * IMPORTANT: this file uses inline `style="..."` rules for sizing and
 * layout (rather than arbitrary Tailwind classes like `px-[18px]`) because
 * the project ships a *prebuilt* `tailwind.generated.css` — arbitrary classes
 * not present in source at build time would silently no-op.
 */

class AboutModal {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = document.getElementById('about-modal');
        this.escapeHandler = null;
        this.returnFocusEl = null;
    }

    open() {
        if (this.isOpen || !this.overlay) return;
        this.isOpen = true;
        this.returnFocusEl = document.activeElement;

        this.overlay.innerHTML = this._renderModal();
        this.overlay.classList.remove('hidden');

        this.overlay.onclick = (event) => {
            if (event.target === this.overlay) this.close();
        };
        this.overlay.querySelector('#about-modal-close')
            ?.addEventListener('click', () => this.close());

        this.escapeHandler = (event) => {
            if (event.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.escapeHandler);

        this.overlay.querySelector('[role="dialog"]')?.focus();
    }

    close() {
        if (!this.isOpen || !this.overlay) return;
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        if (this.returnFocusEl?.focus) this.returnFocusEl.focus();
        this.returnFocusEl = null;
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    _renderModal() {
        return `
            <div role="dialog" aria-modal="true" aria-labelledby="about-modal-title" tabindex="-1"
                 class="border border-border rounded-2xl bg-background shadow-2xl w-full mx-4 overflow-hidden flex flex-col"
                 style="max-width: 560px; max-height: min(86vh, 720px)">
                ${this._renderHeader()}
                <div class="flex-1 overflow-y-auto" style="min-height: 0; padding: 14px 18px">
                    ${this._renderFlowDiagram()}
                    ${this._renderFeatures()}
                    ${this._renderResources()}
                </div>
            </div>
        `;
    }

    _renderHeader() {
        return `
            <div class="flex items-center justify-between gap-4 border-b border-border shrink-0"
                 style="padding: 14px 18px">
                <div class="flex items-center min-w-0" style="gap: 10px">
                    <div class="flex items-center justify-center rounded-md flex-shrink-0"
                         style="width: 26px; height: 26px; background: hsl(var(--color-accent-primary) / 0.12)">
                        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.7" style="color: hsl(var(--color-accent-primary))">
                            <path stroke-linecap="round" stroke-linejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
                        </svg>
                    </div>
                    <div class="min-w-0">
                        <h2 id="about-modal-title" class="font-semibold text-foreground leading-tight truncate"
                            style="font-size: 14px; letter-spacing: -0.005em; margin: 0">About oa-chat</h2>
                        <p class="text-muted-foreground leading-tight"
                           style="font-size: 11px; margin: 2px 0 0; opacity: 0.85">Unlinkable AI inference, in your browser</p>
                    </div>
                </div>
                <button id="about-modal-close"
                        class="text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted/40 flex-shrink-0"
                        style="padding: 6px"
                        aria-label="Close about">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.7">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
        `;
    }

    // —————————————————————————————————————————————
    // Section 1 — flow diagram (You → OA org → Provider)
    // —————————————————————————————————————————————
    _renderFlowDiagram() {
        const node = (title, sub, you = false) => `
            <div class="rounded-lg border border-border"
                 style="display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding: 8px 10px; ${you ? 'background: hsl(var(--color-foreground) / 0.04)' : 'background: hsl(var(--color-background))'}">
                <div class="font-semibold text-foreground leading-tight" style="font-size: 11px">${title}</div>
                <div class="text-muted-foreground leading-tight" style="font-size: 10px; margin-top: 2px">${sub}</div>
            </div>
        `;
        const arrow = (label) => `
            <div class="text-muted-foreground/55"
                 style="align-self:center; font-size: 12px; padding: 0 2px; position: relative">
                ${label ? `
                    <div style="position:absolute; left:50%; top:-18px; transform:translateX(-50%); display:inline-flex; align-items:center; gap:4px; padding:1px 6px; border-radius:4px; font-size:9px; font-weight:600; white-space:nowrap; line-height:1;
                                background: hsl(var(--color-background));
                                color: hsl(var(--color-accent-primary));
                                border: 1px solid hsl(var(--color-accent-primary) / 0.25)">
                        <svg width="9" height="9" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                        </svg>
                        ${label}
                    </div>
                ` : ''}
                →
            </div>
        `;
        return `
            <section style="margin-bottom: 18px">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom: 10px">
                    <span style="color: hsl(var(--color-accent-primary)); display:inline-flex">
                        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.7">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12c0 6-9 9.75-9 9.75S3 18 3 12V5.25l9-3 9 3V12Z" />
                        </svg>
                    </span>
                    <h3 class="font-semibold text-foreground"
                        style="font-size: 13.5px; letter-spacing: -0.005em; margin: 0">How your prompt travels</h3>
                </div>
                <div style="display:grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: stretch; gap: 6px; margin-top: 14px">
                    ${node('You', 'browser', true)}
                    ${arrow('blind sig')}
                    ${node('OA org', 'tickets')}
                    ${arrow('')}
                    ${node('Provider', 'direct HTTPS')}
                </div>
                <p class="text-muted-foreground"
                   style="font-size: 11.5px; line-height: 1.55; margin: 12px 0 0">
                    Tickets are obtained via <strong class="text-foreground" style="font-weight: 600">blind signatures</strong>, redeemed for an
                    ephemeral key with no identity binding, and prompts flow <strong class="text-foreground" style="font-weight: 600">directly</strong> to the provider.
                    No OA system (org, station, verifier) is in the data path.
                </p>
                <a href="https://openanonymity.ai/blog/unlinkable-inference/" target="_blank" rel="noopener noreferrer"
                   style="display:inline-flex; align-items:center; gap:4px; margin-top: 8px; font-size: 11.5px; font-weight: 600; text-decoration: none; color: hsl(var(--color-accent-primary))">
                    Read the technical writeup
                    <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                    </svg>
                </a>
            </section>
        `;
    }

    // —————————————————————————————————————————————
    // Section 2 — features (compact 2-col grid)
    // —————————————————————————————————————————————
    _renderFeatures() {
        const items = [
            ['Sessions',        'Local-only history, pin & archive', this._iconChat()],
            ['Model picker',    'Fuzzy search; pin favorites',       this._iconCube()],
            ['Memory mode',     'Opt-in personal memory',            this._iconMemory()],
            ['System prompts',  'Save & pick presets per session',   this._iconBookmark()],
            ['Multimodal',      'Images, PDFs, and audio',           this._iconPhoto()],
            ['Right panel',     'Tickets, key status, proxy',        this._iconPanel()],
            ['Export',          'Per-chat PDF, full history JSON',   this._iconExport()],
            ['Custom shortcuts','Rebind the global shortcuts',       this._iconKeyboard()],
        ];
        const cells = items.map(([title, desc, icon]) => `
            <div style="display:flex; gap:8px; align-items:flex-start; padding: 5px 0">
                <div class="flex items-center justify-center rounded-md flex-shrink-0"
                     style="width: 22px; height: 22px; margin-top: 1px;
                            background: hsl(var(--color-muted) / 0.5);
                            color: hsl(var(--color-foreground) / 0.7)">
                    ${icon}
                </div>
                <div style="flex:1; min-width:0">
                    <div class="text-foreground" style="font-size: 11.5px; font-weight: 600; line-height: 1.25">${title}</div>
                    <div class="text-muted-foreground" style="font-size: 10.5px; line-height: 1.35; margin-top: 1px">${desc}</div>
                </div>
            </div>
        `).join('');
        return `
            <section style="margin-bottom: 18px">
                <h3 class="text-muted-foreground"
                    style="font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 8px; opacity: 0.75">What's inside</h3>
                <div style="display:grid; grid-template-columns: 1fr 1fr; column-gap: 12px; row-gap: 2px">${cells}</div>
            </section>
        `;
    }

    // —————————————————————————————————————————————
    // Section 3 — resources (pill-shaped row of links)
    // —————————————————————————————————————————————
    _renderResources() {
        const links = [
            ['openanonymity.ai',      'https://openanonymity.ai'],
            ['Unlinkable Inference',  'https://openanonymity.ai/blog/unlinkable-inference/'],
            ['Request a beta invite', 'https://openanonymity.ai/beta'],
        ];
        const pills = links.map(([title, url]) => `
            <a href="${this._escapeHtml(url)}" target="_blank" rel="noopener noreferrer"
               class="border border-border hover:bg-muted/40 transition-colors text-foreground"
               style="display:inline-flex; align-items:center; gap:6px; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 500; text-decoration: none; background: hsl(var(--color-muted) / 0.5)">
                ${this._escapeHtml(title)}
                <svg width="10" height="10" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" style="color: hsl(var(--color-muted-foreground) / 0.7)">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
            </a>
        `).join('');
        return `
            <section>
                <h3 class="text-muted-foreground"
                    style="font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 8px; opacity: 0.75">Learn more</h3>
                <div style="display:flex; flex-wrap:wrap; gap: 6px">${pills}</div>
            </section>
        `;
    }

    // —— icon helpers (heroicons outline, 14×14) ————————————————————————

    _iconBox(path) {
        return `<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="${path}" /></svg>`;
    }
    _iconChat()    { return this._iconBox('M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155'); }
    _iconCube()    { return this._iconBox('M21 7.5l-2.25-1.313M21 7.5v2.25m0-2.25l-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3l2.25-1.313M12 12.75l-2.25-1.313M12 12.75V15m0 6.75l2.25-1.313M12 21.75V19.5m0 2.25l-2.25-1.313m0-16.875L12 2.25l2.25 1.313M21 14.25v2.25l-2.25 1.313m-13.5 0L3 16.5v-2.25'); }
    _iconMemory()  { return this._iconBox('M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125'); }
    _iconBookmark(){ return this._iconBox('M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z'); }
    _iconPhoto()   { return this._iconBox('m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z'); }
    _iconPanel()   {
        return `<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.6">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2"/>
            <path d="M14.5 4.5v15"/>
        </svg>`;
    }
    _iconExport()  { return this._iconBox('M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3'); }
    _iconKeyboard(){ return this._iconBox('m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z'); }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }
}

export default AboutModal;
