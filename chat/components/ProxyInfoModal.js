/**
 * Proxy Info Modal Component
 * Explains what the inference proxy is and how it works
 */

class ProxyInfoModal {
    constructor() {
        this.isOpen = false;
        this.overlay = null;
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;

        document.querySelector('.proxy-info-modal')?.remove();

        this.overlay = document.createElement('div');
        this.overlay.className = 'proxy-info-modal fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in';

        this.render();
        document.body.appendChild(this.overlay);
        this.setupEventListeners();
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.overlay?.remove();
        this.overlay = null;
    }

    render() {
        this.overlay.innerHTML = `
            <div class="bg-background border border-border rounded-xl shadow-2xl max-w-md w-full mx-4 animate-in zoom-in-95 overflow-hidden">
                <!-- Header -->
                <div class="p-4 border-b border-border flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <svg class="w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <circle cx="12" cy="9" r="8"/>
                            <path d="M4 9h16"/>
                            <path d="M12 1a12 12 0 0 1 3.5 8 12 12 0 0 1-3.5 8 12 12 0 0 1-3.5-8A12 12 0 0 1 12 1z"/>
                            <path d="M12 17v4"/>
                            <circle cx="12" cy="22" r="1.5" fill="currentColor"/>
                            <path d="M4 22h6m4 0h6"/>
                        </svg>
                        <h2 class="text-base font-semibold text-foreground">Inference Proxy</h2>
                        <span class="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400 uppercase tracking-wide">Beta</span>
                    </div>
                    <button class="proxy-info-close text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-muted">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                <!-- Content -->
                <div class="p-4 space-y-4">
                    <div class="space-y-3 text-sm text-foreground">
                        <p>
                            OA provides an <strong>in-browser, VPN-like encrypted tunnel</strong> when accessing the models with OA-issued ephemeral access keys. This hides your IP/metadata side-channels from the model provider, preventing network-level fingerprinting.
                        </p>

                        <div class="p-3 rounded-lg border border-border bg-slate-100 dark:bg-slate-800/50 space-y-2">
                            <div class="font-medium text-xs text-slate-600 dark:text-slate-400 uppercase tracking-wider">How it works</div>
                            <ul class="text-xs space-y-1.5 text-slate-600 dark:text-slate-300">
                                <li class="flex items-start gap-2">
                                    <span class="text-blue-500 mt-0.5">→</span>
                                    <span>Your browser connects to our relay server via <strong class="text-foreground">WebSocket</strong></span>
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="text-blue-500 mt-0.5">→</span>
                                    <span>Inside that WebSocket, your browser establishes a separate <strong class="text-foreground">TLS connection</strong> (using mbedTLS/WASM) directly to model provider</span>
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="text-blue-500 mt-0.5">→</span>
                                    <span>Encrypted prompts and responses travel through this tunnel <strong class="text-foreground">directly</strong> to and from the model provider</span>
                                </li>
                            </ul>
                        </div>

                        <div class="p-3 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 space-y-2">
                            <div class="font-medium text-xs text-green-700 dark:text-green-400 uppercase tracking-wider flex items-center gap-1.5">
                                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                                    <path d="M9 12l2 2 4-4"/>
                                </svg>
                                Security Properties
                            </div>
                            <ul class="text-xs space-y-1 text-green-800 dark:text-green-300">
                                <li>• Same encryption guarantees as traditional VPN</li>
                                <li>• Relay servers only see encrypted blobs (i.e., no plaintext prompts or responses)</li>
                                <li>• Your IP/metadata is hidden from the model provider</li>
                            </ul>
                        </div>

                        <p class="text-xs text-muted-foreground">
                            Click <strong class="text-foreground">Security Details</strong> below to verify the TLS implementation and inspect connection info.
                        </p>
                    </div>
                </div>

                <!-- Footer -->
                <div class="p-4 border-t border-border flex justify-end">
                    <button class="proxy-info-done px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                        Got it
                    </button>
                </div>
            </div>
        `;
    }

    setupEventListeners() {
        this.overlay.querySelector('.proxy-info-close')?.addEventListener('click', () => this.close());
        this.overlay.querySelector('.proxy-info-done')?.addEventListener('click', () => this.close());

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });

        this.escapeHandler = (e) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.escapeHandler);
    }
}

const proxyInfoModal = new ProxyInfoModal();
export default proxyInfoModal;

